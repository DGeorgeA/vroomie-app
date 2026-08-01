/**
 * qa_unit_tests.mjs — QA checks for v9.2 (possibility statement + motion gate).
 * Usage: node scripts/qa_unit_tests.mjs   (exit 0 = all pass)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyMotionSamples } from '../src/lib/motionDetector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// ─── QA-1a: marginToConfidence mapping ──────────────────────────────────────
// Reads the qualifying margin FROM SOURCE so the test can never drift out of
// sync with the shipped constant (it silently did when margin 0.05 -> 0.04).
const engineSrcEarly = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'mlEmbeddingEngine.js'), 'utf8');
const marginMatch = engineSrcEarly.match(/const ANCHOR_MARGIN\s*=\s*([\d.]+)/);
const ANCHOR_MARGIN = marginMatch ? parseFloat(marginMatch[1]) : NaN;
check('ANCHOR_MARGIN is parseable from engine source', Number.isFinite(ANCHOR_MARGIN), `= ${ANCHOR_MARGIN}`);
const marginToConfidence = (m) => Math.max(0.70, Math.min(0.97, 0.70 + 1.08 * (m - ANCHOR_MARGIN)));
check('possibility at the qualifying margin is exactly 70%', marginToConfidence(ANCHOR_MARGIN) === 0.70);
check('possibility at decisive margin (+0.25) saturates at 97%', marginToConfidence(ANCHOR_MARGIN + 0.25) === 0.97);
check('possibility never below 70% for any confirmed anomaly', marginToConfidence(-1) === 0.70 && marginToConfidence(0) === 0.70);
check('possibility never above 97%', marginToConfidence(5) === 0.97);
check('mapping is monotonic', marginToConfidence(0.10) > marginToConfidence(0.05) && marginToConfidence(0.20) > marginToConfidence(0.10));

const engineSrc = engineSrcEarly;
check('engine uses the tested confidence formula',
  engineSrc.includes('0.70 + 1.08 * (margin - ANCHOR_MARGIN)'));
// Guard the measured operating point: loosening these without re-running the
// grid is what produced a 20% false-positive rate on healthy vehicles.
check('detection operating point matches the measured optimum',
  /const ANOMALY_THRESHOLD\s*=\s*0\.45/.test(engineSrc) && ANCHOR_MARGIN === 0.04,
  `threshold/margin = ${(engineSrc.match(/ANOMALY_THRESHOLD\s*=\s*([\d.]+)/) || [])[1]}/${ANCHOR_MARGIN}`);
{
  const rec = fs.readFileSync(path.join(ROOT, 'src', 'components', 'predictive', 'AudioRecorder.jsx'), 'utf8');
  const frac = parseFloat((rec.match(/SESSION_FRACTION\s*=\s*([\d.]+)/) || [])[1]);
  const minW = parseInt((rec.match(/SESSION_MIN_ACCEPTED\s*=\s*(\d+)/) || [])[1], 10);
  check('session rule matches the measured optimum (>=45% of >=3 windows)',
    frac === 0.45 && minW === 3, `fraction=${frac} minWindows=${minW}`);
  check('family (fault_type) vote aggregation is active',
    rec.includes('familyKey') && rec.includes('faultType'));
}

// ─── QA-1b: possibility statement format ────────────────────────────────────
const recorderSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'predictive', 'AudioRecorder.jsx'), 'utf8');
const buildStatement = (possibility, readable, sourceFile) =>
  `There is a ${possibility}% possibility that there could be a possible ${readable}${sourceFile ? ` (${sourceFile})` : ''}`;
const sample = buildStatement(82, 'Piston', 'Piston.wav');
check('statement format matches product requirement',
  sample === 'There is a 82% possibility that there could be a possible Piston (Piston.wav)', sample);
check('recorder source builds the same statement template',
  recorderSrc.includes('% possibility that there could be a possible '));
check('statement omits parenthetical when source file unknown',
  buildStatement(75, 'Piston', null) === 'There is a 75% possibility that there could be a possible Piston');

// ─── QA-1c: motion classifier on synthetic traces ───────────────────────────
const mk = (fn, n = 300) => Array.from({ length: n }, (_, i) => fn(i));
// Perfectly still phone on a table (gravity + sensor noise ~0.002 m/s²)
const still = mk(i => ({ x: 0.001 * Math.sin(i), y: 9.81 + 0.002 * Math.sin(i * 1.7), z: 0.001 * Math.cos(i * 0.9) }));
// Idle engine vibration (~0.1 m/s² at ~30 Hz on top of gravity)
const idle = mk(i => ({ x: 0.1 * Math.sin(i * 6.0), y: 9.81 + 0.12 * Math.sin(i * 6.3 + 1), z: 0.08 * Math.cos(i * 5.7) }));
// Hand-held tremor (slow wander, ~0.15 m/s²)
const handheld = mk(i => ({ x: 0.15 * Math.sin(i * 0.8), y: 9.81 + 0.2 * Math.sin(i * 0.5), z: 0.1 * Math.sin(i * 0.65) }));

const rStill = classifyMotionSamples(still);
const rIdle = classifyMotionSamples(idle);
const rHand = classifyMotionSamples(handheld);
check('still phone classified as still', rStill.verdict === 'still', `rms=${rStill.vibrationRms.toFixed(4)}`);
check('idle-engine vibration classified as moving', rIdle.verdict === 'moving', `rms=${rIdle.vibrationRms.toFixed(4)}`);
check('hand-held phone classified as moving (never suppressed)', rHand.verdict === 'moving', `rms=${rHand.vibrationRms.toFixed(4)}`);
check('short capture returns insufficient (fail-open)', classifyMotionSamples(still.slice(0, 10)).verdict === 'insufficient');
check('empty/no sensor data returns insufficient (fail-open)', classifyMotionSamples([]).verdict === 'insufficient');

// ─── QA-2: motion wiring in the recorder (annotation semantics) ─────────────
check('stillness verdict requires motion data to be AVAILABLE (fail-open)',
  recorderSrc.includes("m.available && m.verdict === 'still'"));
check('anomalies are NEVER suppressed by stillness — annotated instead',
  recorderSrc.includes('vehicle vibration was not sensed; verify at the running vehicle') &&
  recorderSrc.includes('published WITHOUT vehicle vibration') &&
  !recorderSrc.includes('Keep the phone in or on the running vehicle and try again'));
check('motion annotation applies only to sessions WITH anomalies',
  recorderSrc.includes('realAnomalies.length > 0 && isVibrationUnverified()'));
check('motion telemetry stored in analysis_result',
  recorderSrc.includes('vibration_rms'));

// ─── QA-2b: report/narrative coverage for EVERY emittable label ─────────────
{
  const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'fingerprints_v9.json'), 'utf8'));
  const labels = [...new Set(art.faults.map(f => f.label))];
  const ameSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'audioMatchingEngine.js'), 'utf8');
  const narrativeKeys = [...ameSrc.matchAll(/^  '([^']+)':/gm)].map(m => m[1]);
  const SEV = new Set(['critical', 'high', 'medium', 'low']);
  const readable = (raw) => {
    let p = raw.split('_');
    if (p.length > 1 && SEV.has(p[p.length - 1])) p.pop();
    p = p.filter((w, i) => i === 0 || w !== p[i - 1]);
    return p.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  };
  const norm = (s) => s.toLowerCase().replace(/[_\s]+/g, '');
  // mirrors the shipped LONGEST-match resolver
  const resolve = (raw) => {
    if (narrativeKeys.includes(raw)) return raw;
    const target = norm(raw);
    let bestKey = null, bestLen = -1;
    for (const k of narrativeKeys) {
      const kn = norm(k);
      if (kn === target) return k;
      if (target.includes(kn) || kn.includes(target)) {
        if (kn.length > bestLen) { bestLen = kn.length; bestKey = k; }
      }
    }
    return bestKey;
  };
  const missing = labels.filter(l => !resolve(readable(l)));
  check('every artifact label resolves to a repair narrative', missing.length === 0,
    missing.length ? 'missing: ' + missing.join(', ') : `${labels.length} labels covered`);
  // The combined power-steering label must NOT be hijacked by the shorter
  // "SerpentineBelt" key (first-match bug: wrong repair advice, largest class)
  const combined = labels.find(l => l.toLowerCase().includes('power steering or low oil'));
  if (combined) {
    check('combined power-steering label maps to its OWN narrative (longest match)',
      resolve(readable(combined)) === 'Issue_with_Power_steering_or_low_oil_or_serpentine_belt',
      `resolved -> ${resolve(readable(combined))}`);
  }
  check('longest-match resolver is the shipped implementation',
    ameSrc.includes('LONGEST match wins') && ameSrc.includes('bestLen'));
}

// ─── QA-2c: PDF report regression guards ────────────────────────────────────
{
  const rg = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'reportGenerator.js'), 'utf8');
  // dict.inr/.usd were purged from diagnosticDictionary; interpolating them
  // threw a TypeError and killed doc.save() for EVERY anomaly report.
  // Strip comments so the guard tests CODE, not the note explaining the bug.
  const rgCode = rg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('PDF export never interpolates purged cost fields (crash guard)',
    !/dict\.(inr|usd)/.test(rgCode));
  check('PDF export renders a single page (no duplicate cost pages)',
    !/renderPage\(['"]INR/.test(rgCode));
  check('PDF uses sourceFile for the matched reference',
    rg.includes('primaryAnomaly.sourceFile'));
  check('PDF includes the possibility statement',
    rg.includes('primaryAnomaly.statement'));
  const dd = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'diagnosticDictionary.js'), 'utf8');
  check('diagnostic dictionary has no mojibake', !dd.includes('ΓÇö'));
  check('diagnostic lookup falls back beyond exact match', dd.includes('bestLen'));
}

// ─── QA-3: possibility statements from real benchmark measurements ─────────
const measPath = path.join(ROOT, 'scratch', 'bench_measurements.json');
if (fs.existsSync(measPath)) {
  const measured = JSON.parse(fs.readFileSync(measPath, 'utf8'));
  const bucket = measured.find(m => m.name === 'bucket reference originals');
  let statements = 0;
  for (const wins of bucket.sessions) {
    const hits = new Map();
    let accepted = 0;
    for (const w of wins) {
      if (!w) continue;
      accepted++;
      if (w.bf >= 0.60 && w.margin >= 0.05) {
        const e = hits.get(w.bl) || { n: 0, confSum: 0 };
        e.n++; e.confSum += marginToConfidence(w.margin);
        hits.set(w.bl, e);
      }
    }
    for (const [label, e] of hits) {
      if (accepted >= 4 && e.n / accepted >= 0.5) {
        const p = Math.round((e.confSum / e.n) * 100);
        console.log(`   sample: "There is a ${p}% possibility that there could be a possible ${label}"`);
        check(`  -> possibility ${p}% is >= 70`, p >= 70);
        statements++;
      }
    }
  }
  check('confirmed bucket replays produce >= 9 possibility statements', statements >= 9, `${statements} statements`);
} else {
  check('bench_measurements.json present for statement QA', false, 'run scripts/benchmark_discrimination.mjs first');
}

console.log(failures === 0 ? '\nALL QA UNIT CHECKS PASSED' : `\n${failures} QA CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
