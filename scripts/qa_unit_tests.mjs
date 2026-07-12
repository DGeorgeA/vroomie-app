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
// Replicates the engine formula; the source-text check below guards drift.
const ANCHOR_MARGIN = 0.05;
const marginToConfidence = (m) => Math.max(0.70, Math.min(0.97, 0.70 + 1.08 * (m - ANCHOR_MARGIN)));
check('possibility at qualifying margin (0.05) is exactly 70%', marginToConfidence(0.05) === 0.70);
check('possibility at decisive margin (0.30) saturates at 97%', marginToConfidence(0.30) === 0.97);
check('possibility never below 70% for any confirmed anomaly', marginToConfidence(-1) === 0.70 && marginToConfidence(0) === 0.70);
check('possibility never above 97%', marginToConfidence(5) === 0.97);
check('mapping is monotonic', marginToConfidence(0.10) > marginToConfidence(0.05) && marginToConfidence(0.20) > marginToConfidence(0.10));

const engineSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'mlEmbeddingEngine.js'), 'utf8');
check('engine source contains the tested formula constants',
  engineSrc.includes('0.70 + 1.08 * (margin - ANCHOR_MARGIN)') && engineSrc.includes('const ANCHOR_MARGIN = 0.05'));

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

// ─── QA-2: fail-open wiring in the recorder ─────────────────────────────────
check('anomaly suppression requires motion data to be AVAILABLE',
  recorderSrc.includes("m.available && m.verdict === 'still'"));
check('suppression only applies to sessions WITH anomalies',
  recorderSrc.includes('realAnomalies.length > 0 && isAnomalySuppressedByStillness()'));

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
