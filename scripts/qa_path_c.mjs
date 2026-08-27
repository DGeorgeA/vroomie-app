/**
 * qa_path_c.mjs — acceptance tests for PATH C, the normality model.
 *
 * Path C scores how far live audio sits from the HEALTHY manifold, so it can
 * flag a fault nobody catalogued. It is wired to AI Enabled only, in SHADOW
 * mode: it logs, it does not decide.
 *
 * This suite runs the SHIPPED scorer against the SHIPPED artifacts, with no
 * Supabase and no TF Hub. It answers three questions:
 *
 *   1. Does the model separate healthy engines from things that are not
 *      healthy engines? (If not, Path C is worthless and should not ship.)
 *   2. Does it fail safe — malformed input, missing artifact, wrong shape?
 *   3. Is it genuinely inert? Nothing it produces may reach a verdict.
 *
 * Usage: node scripts/qa_path_c.mjs   (exit 0 = all pass)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The scorer fetches its artifact; in Node we stub fetch to read from disk so
// the SHIPPED module under test is exercised unmodified.
const artifactPath = path.join(ROOT, 'public', 'normality_v1.json');
globalThis.fetch = async (url) => {
  const file = String(url).replace(/^.*\//, '');
  const p = path.join(ROOT, 'public', file);
  if (!fs.existsSync(p)) return { ok: false, status: 404 };
  const text = fs.readFileSync(p, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};

const {
  loadNormalityModel, scoreNormality, summariseNormality,
  isNormalityReady, resetNormalityModel,
} = await import('../src/lib/normalityScorer.js');

// ── Artifact shape ──────────────────────────────────────────────────────────
console.log('══ PATH C — NORMALITY MODEL ══\n');
console.log('── Artifact ──');

check('normality artifact exists', fs.existsSync(artifactPath));
const art = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
check('declares its generator',
  art.generated_by === 'scripts/build_normality_model.mjs', art.generated_by);
check('built from the shipped anchor artifact',
  art.source_artifact === 'public/fingerprints_v9.json', art.source_artifact);
check('embedding dim matches YAMNet', art.dim === 1024, String(art.dim));
check('PCA dims well-conditioned for the anchor count',
  art.pca_dims * 2 <= art.anchor_count,
  `${art.pca_dims} dims from ${art.anchor_count} anchors`);
check('shrinkage is applied', art.shrinkage > 0 && art.shrinkage < 1, String(art.shrinkage));
check('ships a healthy calibration', !!art.calibration?.healthy_p99,
  JSON.stringify(art.calibration));

const sizeKB = fs.statSync(artifactPath).size / 1024;
check('artifact stays a small fraction of the precache budget', sizeKB < 300,
  `${sizeKB.toFixed(1)} KB`);

check('model loads', await loadNormalityModel('/normality_v1.json'));
check('reports ready', isNormalityReady());

// ── Discrimination: the whole point of Path C ───────────────────────────────
console.log('\n── Does it separate healthy from not-healthy? ──');

const dequantize = (q) => {
  const bin = Buffer.from(q.b64, 'base64');
  const emb = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) emb[i] = q.min + bin[i] * q.scale;
  return emb;
};
const fp = JSON.parse(read('public/fingerprints_v9.json'));
const healthy = fp.anchors.filter(a => a.kind === 'healthy').map(a => dequantize(a.q));
const interferers = fp.anchors.filter(a => a.kind === 'interferer').map(a => dequantize(a.q));
const faults = fp.faults.map(f => dequantize(f.q));

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const scoreAll = (set) => set.map(e => scoreNormality(e)).filter(Boolean).map(r => r.distance);

const hS = scoreAll(healthy);
const iS = scoreAll(interferers);
const fS = scoreAll(faults);

check('every healthy anchor scores', hS.length === healthy.length, `${hS.length}/${healthy.length}`);
check('every fault embedding scores', fS.length === faults.length, `${fS.length}/${faults.length}`);

const hMed = med(hS), iMed = med(iS), fMed = med(fS);
console.log(`      healthy median    ${hMed.toFixed(3)}`);
console.log(`      fault median      ${fMed.toFixed(3)}`);
console.log(`      interferer median ${iMed.toFixed(3)}`);

check('interferers sit FURTHER from healthy than healthy does', iMed > hMed,
  `${iMed.toFixed(3)} vs ${hMed.toFixed(3)}`);
check('faults sit FURTHER from healthy than healthy does', fMed > hMed,
  `${fMed.toFixed(3)} vs ${hMed.toFixed(3)}`);

// Separation expressed as a ratio — a model with no signal scores ~1.0.
const sepFault = fMed / hMed;
const sepInt = iMed / hMed;
check('fault separation is a real margin, not noise', sepFault > 1.10,
  `${sepFault.toFixed(3)}x`);
check('interferer separation is a real margin', sepInt > 1.15, `${sepInt.toFixed(3)}x`);

// AUC — threshold-free, the metric the DCASE work argues for. 0.5 = chance.
function auc(pos, neg) {
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
const aucFault = auc(fS, hS);
const aucInt = auc(iS, hS);
console.log(`      AUC fault-vs-healthy       ${aucFault.toFixed(3)}`);
console.log(`      AUC interferer-vs-healthy  ${aucInt.toFixed(3)}`);

// FLOORS, not targets. Path C's job in shadow mode is to prove it carries
// signal at all; these thresholds catch a model that has DEGRADED, they do not
// certify it is good enough to act on.
//
// Interpreting the measured numbers honestly:
//   * fault-vs-healthy AUC 0.748 is in the same league as the DCASE 2026
//     winner's source-domain AUC of 76.3 — but that system also reported
//     pAUC 56.9, near chance in the low-false-alarm regime this product needs.
//     Comparable AUC therefore does NOT imply usable at Vroomie's operating
//     point.
//   * The healthy anchors were used to FIT this model, so their distances are
//     optimistically low and this AUC is an OVER-estimate. A held-out healthy
//     set would score worse. Faults were never used in fitting, so that side
//     is fair.
//   * Interferer separation (0.862) is much stronger than fault separation,
//     which is expected: an interferer is not an engine at all, whereas a
//     faulty engine is still mostly a healthy engine.
// Together: enough signal to be worth measuring in the field, nowhere near
// enough to gate a user-visible verdict. Hence shadow mode.
check('fault-vs-healthy AUC carries real signal above chance', aucFault > 0.70,
  `${aucFault.toFixed(3)} (chance 0.500; DCASE source-domain reference 0.763)`);
check('interferer-vs-healthy AUC carries real signal', aucInt > 0.70,
  `${aucInt.toFixed(3)}`);
check('fault separation is weaker than interferer separation, as expected',
  sepFault < sepInt, `${sepFault.toFixed(3)}x vs ${sepInt.toFixed(3)}x`);

// ── Calibration sanity ──────────────────────────────────────────────────────
console.log('\n── Calibration ──');
{
  const p99 = art.calibration.healthy_p99;
  const outsideHealthy = hS.filter(d => d > p99).length / hS.length;
  check('at most a sliver of healthy anchors sit beyond p99', outsideHealthy <= 0.05,
    `${(outsideHealthy * 100).toFixed(1)}%`);
  const r = scoreNormality(healthy[0]);
  check('ratio is expressed against healthy_p99',
    Math.abs(r.ratio - r.distance / p99) < 1e-3, `ratio=${r.ratio}`);
  check('band vocabulary is the documented set',
    ['typical', 'elevated', 'outlier'].includes(r.band), r.band);
}

// ── Fail-safe ───────────────────────────────────────────────────────────────
console.log('\n── Fail-safe ──');

check('wrong-length embedding returns null', scoreNormality(new Float32Array(512)) === null);
check('empty input returns null', scoreNormality(new Float32Array(0)) === null);
check('null input returns null', scoreNormality(null) === null);
check('undefined input returns null', scoreNormality(undefined) === null);
{
  // Non-finite values must not produce a NaN score that later compares oddly.
  const bad = Float32Array.from(healthy[0]);
  bad[0] = NaN; bad[1] = Infinity;
  const r = scoreNormality(bad);
  check('non-finite input never yields a finite bogus score',
    r === null || !Number.isFinite(r.distance), r ? String(r.distance) : 'null');
}
{
  resetNormalityModel();
  check('unloaded model scores nothing', scoreNormality(healthy[0]) === null);
  const ok = await loadNormalityModel('/does_not_exist.json');
  check('missing artifact disables Path C rather than throwing', ok === false);
  check('and it still refuses to score', scoreNormality(healthy[0]) === null);
  resetNormalityModel();
  check('reloads cleanly after a failure', await loadNormalityModel('/normality_v1.json'));
}

// ── Session summary ─────────────────────────────────────────────────────────
console.log('\n── Session summary (telemetry shape) ──');
{
  check('empty session summarises to null', summariseNormality([]) === null);
  check('null-safe', summariseNormality(null) === null);
  const windows = healthy.slice(0, 10).map(e => scoreNormality(e));
  const s = summariseNormality(windows);
  check('summary counts windows', s && s.windows === 10, s ? String(s.windows) : 'null');
  check('summary reports median and max', s && s.median > 0 && s.max >= s.median);
  check('summary reports band tally',
    s && typeof s.bands.typical === 'number');
  check('healthy windows are mostly inside the healthy spread',
    s && s.outside_healthy <= 0.2, s ? String(s.outside_healthy) : 'n/a');
  const mixed = summariseNormality([...windows, null, undefined, { distance: NaN }]);
  check('malformed entries are dropped, not counted',
    mixed && mixed.windows === 10, mixed ? String(mixed.windows) : 'null');
}

// ── Isolation: AI Enabled only, and INERT ───────────────────────────────────
console.log('\n── Wiring: AI Enabled only, shadow only ──');

const extractor = read('src/lib/audioFeatureExtractor.js');
const recorder = read('src/components/predictive/AudioRecorder.jsx');

check('Path C is armed only in ml mode',
  /activeDetectionMode === 'ml' && isNormalityReady\(\)/.test(extractor));
check('Path C is loaded only inside the ml branch',
  /if \(activeDetectionMode === 'ml'\) \{[\s\S]{0,200}loadNormalityModel\(\)/.test(extractor));
check('Path C never arms in basic mode',
  !/activeDetectionMode === 'basic'[\s\S]{0,400}loadNormalityModel/.test(extractor));
check('scoring failure is caught and the session continues',
  /\[Normality\] scoring failed, continuing/.test(extractor));
// Path A now runs in BOTH tiers — AI Enabled is Basic plus Path C, never less.
// Disarming Path A for AI Enabled was measured to be a regression; see
// scripts/rca_four_families.mjs and scripts/rca_pathb_separability.mjs.
check('Path A is unaffected by the mode (runs in both tiers)',
  /if \(!constellationFired\) \{/.test(extractor)
  && !/activeDetectionMode === 'basic' && !constellationFired/.test(extractor));

// The critical invariant: nothing Path C produces may influence a verdict.
{
  const outcomeStart = recorder.indexOf('const computeSessionOutcome');
  const outcomeEnd = recorder.indexOf('const startRecording');
  const outcome = recorder.slice(outcomeStart, outcomeEnd);
  check('computeSessionOutcome never reads the normality score',
    !/normality|sessionNormalityRef/i.test(outcome));
  check('the shadow store is telemetry-only, documented as such',
    /Telemetry ONLY[\s\S]{0,140}sessionNormalityRef/.test(recorder));
  check('normality reaches session_diagnostics',
    /normality_shadow: summariseNormality\(sessionNormalityRef\.current\)/.test(recorder));
  // It must be persisted on BOTH the abort and the success path.
  check('shadow telemetry is recorded on aborted sessions too',
    (recorder.match(/normality_shadow:/g) || []).length >= 2,
    `${(recorder.match(/normality_shadow:/g) || []).length} sites`);
}
check('scorer documents that promotion must be earned',
  /SHADOW MODE/.test(read('src/lib/normalityScorer.js'))
  && /pAUC 56\.9/.test(read('src/lib/normalityScorer.js')));

console.log(
  failures === 0
    ? '\nALL PATH C CHECKS PASSED'
    : `\n${failures} PATH C CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
