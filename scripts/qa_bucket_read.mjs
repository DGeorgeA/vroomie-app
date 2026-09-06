/**
 * qa_bucket_read.mjs — proves the builder reads the anomaly-patterns bucket
 * COMPLETELY, without needing the real bucket.
 *
 * The bucket is Path A's sole source, so an incomplete read is not a build
 * failure — it is a silently smaller index, and every reference missing from
 * that index is a fault the app can no longer detect. The previous read had
 * three silent failure modes:
 *
 *   1. ONE list call with limit 1000 — a larger bucket was truncated with no
 *      error, and since the .wav filter ran AFTER the limit, non-wav objects
 *      ate into the same budget.
 *   2. NO folder recursion — Supabase returns a folder as an entry with a null
 *      id, not as its contents, so anything filed in a subfolder was invisible.
 *   3. NO retry, and `res.ok` unchecked on the object download — one transient
 *      blip dropped a reference, and an error page was fed to the WAV decoder
 *      as if it were audio.
 *
 * This runs the real builder against a mock Supabase storage endpoint on
 * localhost (SUPABASE_URL override) that reproduces those exact conditions:
 * more objects than a single page, nested folders, non-wav clutter, and
 * injected transient 500s. It asserts the builder finds everything.
 *
 * Usage: node scripts/qa_bucket_read.mjs   (exit 0 = all pass)
 */
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// ── A minimal 16-bit PCM WAV the builder can actually decode ────────────────
function makeWav(seconds = 5, hz = 220, sr = 16000) {
  const n = Math.floor(sr * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    // Broadband-ish: a tone plus noise, so the flatness floor does not reject it.
    const v = 0.3 * Math.sin(2 * Math.PI * hz * (i / sr)) + 0.25 * (Math.random() * 2 - 1);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ── The mock bucket ─────────────────────────────────────────────────────────
// Deliberately built to break the OLD reader: 140 objects (more than one
// 100-item page), real subfolders, and non-wav clutter mixed in.
const OBJECTS = new Map();   // full path -> Buffer
const FOLDERS = new Set();

function addObj(p, buf) {
  OBJECTS.set(p, buf);
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) FOLDERS.add(parts.slice(0, i).join('/'));
}

// Root: enough power_steering objects to span two pages.
for (let i = 1; i <= 120; i++) addObj(`PowerSteeringPump_${String(i).padStart(3, '0')}.wav`, makeWav(5, 300 + i));
// Root clutter that must not be counted, and must not consume the page budget.
addObj('readme.txt', Buffer.from('not audio'));
addObj('cover.png', Buffer.from('not audio'));
// One object per thin family, at root.
addObj('Piston.wav', makeWav(5, 90));
addObj('MotorStarter.wav', makeWav(5, 150));
// NESTED — invisible to the old reader.
addObj('archive/2026/BearingAlternator.wav', makeWav(5, 500));
addObj('archive/2026/RockerArmAndValve.wav', makeWav(5, 700));
addObj('archive/deep/er/still/timing_chain_rattle_high.wav', makeWav(5, 400));
// Nested clutter.
addObj('archive/notes.md', Buffer.from('not audio'));

const EXPECTED_WAVS = [...OBJECTS.keys()].filter(p => /\.wav$/i.test(p));

// Transient failure injection: the Nth request to these paths fails once.
const failOnce = new Set(['Piston.wav', 'archive/2026/BearingAlternator.wav']);
const listFailures = { remaining: 2 };   // first two list calls 500

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname.includes('/object/list/')) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (listFailures.remaining > 0) {
        listFailures.remaining--;
        res.writeHead(500).end('injected list failure');
        return;
      }
      const { prefix = '', limit = 100, offset = 0 } = JSON.parse(body || '{}');
      // Mirror Supabase: one level only, folders as null-id entries.
      const seen = new Map();
      const scope = prefix ? prefix + '/' : '';
      for (const p of OBJECTS.keys()) {
        if (!p.startsWith(scope)) continue;
        const rest = p.slice(scope.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(rest, { name: rest, id: `id-${rest}` });
        else {
          const folder = rest.slice(0, slash);
          if (!seen.has(folder)) seen.set(folder, { name: folder, id: null });
        }
      }
      const all = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(all.slice(offset, offset + limit)));
    });
    return;
  }

  const marker = '/object/public/anomaly-patterns/';
  const at = url.pathname.indexOf(marker);
  if (req.method === 'GET' && at !== -1) {
    const key = decodeURIComponent(url.pathname.slice(at + marker.length));
    if (failOnce.has(key)) {
      failOnce.delete(key);
      res.writeHead(503).end('injected transient failure');
      return;
    }
    const buf = OBJECTS.get(key);
    if (!buf) { res.writeHead(404).end('no such object'); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(buf);
    return;
  }
  res.writeHead(404).end();
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
console.log(`══ Bucket read QA — mock storage at ${origin} ══\n`);
console.log(`mock bucket: ${OBJECTS.size} objects, ${EXPECTED_WAVS.length} of them .wav, `
  + `${FOLDERS.size} folders, list pages of 100\n`);

// ── Run the REAL builder against the mock ───────────────────────────────────
const outPath = path.join(ROOT, 'public', 'constellation_v1.json');
const backup = fs.readFileSync(outPath);
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bucketqa-'));

const run = () => new Promise(resolve => {
  const child = spawn(process.execPath, ['--max-old-space-size=4096',
    path.join(ROOT, 'scripts/build_constellation_index.mjs')], {
    env: { ...process.env, SUPABASE_URL: origin },
    cwd: ROOT,
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', code => resolve({ code, out }));
});

const { code, out } = await run();
fs.writeFileSync(path.join(tmpHome, 'build.log'), out);

let artifact = null;
try { artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* left below */ }
// Restore the shipped artifact immediately — this QA must never mutate it.
fs.writeFileSync(outPath, backup);

console.log('── Completeness ──');
check('the builder exits successfully against the mock bucket', code === 0,
  code === 0 ? '' : `exit ${code}; log at ${tmpHome}/build.log`);

const listedMatch = out.match(/(\d+) wav objects in bucket/);
const listed = listedMatch ? Number(listedMatch[1]) : -1;
check('every .wav in the bucket is listed, across pages AND folders',
  listed === EXPECTED_WAVS.length, `listed ${listed}, expected ${EXPECTED_WAVS.length}`);
check('pagination is exercised — more objects than one page',
  EXPECTED_WAVS.length > 100, `${EXPECTED_WAVS.length} wavs vs 100/page`);
check('non-wav objects are excluded from the count',
  listed === EXPECTED_WAVS.length && OBJECTS.size > EXPECTED_WAVS.length,
  `${OBJECTS.size - EXPECTED_WAVS.length} non-wav objects present`);

console.log('\n── Folder recursion ──');
for (const nested of ['archive/2026/BearingAlternator.wav',
                      'archive/deep/er/still/timing_chain_rattle_high.wav']) {
  check(`nested object is reached: ${nested}`, out.includes(nested.split('/').pop()),
    `depth ${nested.split('/').length - 1}`);
}

console.log('\n── Transient failure handling ──');
check('a transient list failure is retried, not fatal',
  /retry \d+\/\d+ — list/.test(out) && code === 0);
check('a transient download failure is retried, not dropped',
  /retry \d+\/\d+ — (Piston\.wav|archive)/.test(out) && code === 0);
check('no download was silently abandoned',
  !/downloads failed/.test(out), 'build would have aborted otherwise');

console.log('\n── Budget still honoured on a large bucket ──');
// Only meaningful when the build actually produced this artifact — otherwise
// we would be re-inspecting the restored shipped index and calling it a pass.
if (code !== 0) {
  check('artifact reflects this run', false, 'build failed; budget checks skipped');
} else if (artifact) {
  const perFam = new Map();
  for (const r of artifact.refs) perFam.set(r.fault_type, (perFam.get(r.fault_type) || 0) + 1);
  check('total references stay within MAX_TOTAL_REFS', artifact.refs.length <= 20,
    `${artifact.refs.length} refs from ${EXPECTED_WAVS.length} candidates`);
  check('no family exceeds MAX_REFS_PER_FAMILY',
    [...perFam.values()].every(n => n <= 3),
    [...perFam.entries()].map(([f, n]) => `${f}=${n}`).join(' '));
  check('a 120-recording family did not starve the thin families',
    perFam.size >= 4, `${perFam.size} families represented: ${[...perFam.keys()].join(', ')}`);
} else {
  check('artifact was produced', false, 'no artifact to inspect');
}

console.log('\n── The shipped artifact was not mutated ──');
check('public/constellation_v1.json is byte-identical to before this run',
  fs.readFileSync(outPath).equals(backup));

server.close();
console.log(`\n${failures === 0 ? 'ALL BUCKET READ CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
console.log(`build log: ${tmpHome}/build.log`);
process.exit(failures ? 1 : 0);
