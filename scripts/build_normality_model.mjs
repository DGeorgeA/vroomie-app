/**
 * build_normality_model.mjs — offline builder for PATH C, the normality model.
 *
 * Paths A and B can only find faults somebody recorded. Path C learns what a
 * HEALTHY engine sounds like and scores deviation from it, so it can flag a
 * fault nobody has catalogued. That directly attacks DATA-1.
 *
 * NO NEW DATA REQUIRED: the 78 healthy anchor embeddings already ship inside
 * public/fingerprints_v9.json. This script reads them, fits a Gaussian to the
 * healthy manifold in a reduced space, and writes the inverse covariance the
 * runtime needs. It touches neither the bucket nor TF Hub.
 *
 * WHY MAHALANOBIS RATHER THAN COSINE
 * Cosine weights all 1024 dimensions equally, but across healthy engines some
 * dimensions vary enormously (engine size, RPM, mic response) and some barely
 * move. The Engineering Reference records the consequence: a healthy idling car
 * scores 0.892-0.918 cosine against power-steering references — higher than
 * several genuine faults. Mahalanobis whitens by the covariance of normal data,
 * so ordinary variation is discounted and unusual variation is amplified.
 *
 * WHY PCA FIRST
 * A full 1024x1024 inverse covariance is 4.2 MB in float32 — it would nearly
 * double the app's precache on its own, and 78 samples cannot estimate 1024
 * dimensions anyway (the covariance would be singular). Projecting to PCA_DIMS
 * first makes the estimate well-posed AND the artifact small.
 *
 * SHRINKAGE
 * Even in the reduced space, 78 samples is modest. Ledoit-Wolf style shrinkage
 * toward a scaled identity keeps the inverse numerically stable rather than
 * letting the smallest eigenvalue dominate the distance.
 *
 * Output: public/normality_v1.json
 * Usage:  node scripts/build_normality_model.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'fingerprints_v9.json');
const OUT = path.join(ROOT, 'public', 'normality_v1.json');

// 32 dims keeps the covariance well-conditioned at 78 samples (>2 samples per
// dimension) and the artifact at ~4 KB. Raising this without more anchors
// makes the estimate worse, not better.
const PCA_DIMS = 32;
const SHRINKAGE = 0.15;   // toward scaled identity
const POWER_ITERS = 220;  // per component

const dequantize = (q) => {
  const bin = Buffer.from(q.b64, 'base64');
  const emb = new Float64Array(bin.length);
  for (let i = 0; i < bin.length; i++) emb[i] = q.min + bin[i] * q.scale;
  return emb;
};

// ── Load healthy anchors ────────────────────────────────────────────────────
const art = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const healthy = art.anchors.filter(a => a.kind === 'healthy').map(a => dequantize(a.q));
if (healthy.length < PCA_DIMS * 2) {
  console.error(`[normality] FATAL: ${healthy.length} healthy anchors is too few for ${PCA_DIMS} dims`);
  process.exit(1);
}
const D = healthy[0].length;
const N = healthy.length;
console.log(`[normality] ${N} healthy anchors, ${D} dims -> PCA ${PCA_DIMS}`);

// ── Mean-centre ─────────────────────────────────────────────────────────────
const mean = new Float64Array(D);
for (const v of healthy) for (let i = 0; i < D; i++) mean[i] += v[i] / N;
const X = healthy.map(v => {
  const c = new Float64Array(D);
  for (let i = 0; i < D; i++) c[i] = v[i] - mean[i];
  return c;
});

// ── PCA by power iteration with deflation ───────────────────────────────────
// Full eigendecomposition of a 1024x1024 matrix is unnecessary: we only need
// the top PCA_DIMS directions, and power iteration on the (small) N x N Gram
// matrix recovers them without ever forming the 1024x1024 covariance.
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Gram matrix G = X X^T  (N x N) — its eigenvectors map to PCA directions.
const G = [];
for (let i = 0; i < N; i++) {
  G.push(new Float64Array(N));
  for (let j = 0; j <= i; j++) {
    const v = dot(X[i], X[j]);
    G[i][j] = v;
    if (i !== j) G[j] = G[j] || new Float64Array(N);
  }
}
for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) G[i][j] = G[j][i];

let deflated = G.map(r => Float64Array.from(r));
const components = [];   // each: Float64Array(D), unit length
const eigenvalues = [];

// Deterministic seed so the artifact is reproducible run to run.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

for (let c = 0; c < PCA_DIMS; c++) {
  let u = new Float64Array(N);
  for (let i = 0; i < N; i++) u[i] = rnd() * 2 - 1;
  let lambda = 0;
  for (let it = 0; it < POWER_ITERS; it++) {
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += deflated[i][j] * u[j]; w[i] = s; }
    const norm = Math.sqrt(dot(w, w));
    if (norm < 1e-12) break;
    for (let i = 0; i < N; i++) w[i] /= norm;
    u = w;
    lambda = norm;
  }
  if (lambda <= 1e-10) { console.warn(`[normality] component ${c} degenerate — stopping early`); break; }

  // Map the Gram eigenvector back to a direction in the 1024-d space.
  const dir = new Float64Array(D);
  for (let i = 0; i < N; i++) for (let k = 0; k < D; k++) dir[k] += u[i] * X[i][k];
  const dn = Math.sqrt(dot(dir, dir));
  if (dn < 1e-12) break;
  for (let k = 0; k < D; k++) dir[k] /= dn;

  components.push(dir);
  eigenvalues.push(lambda / (N - 1));

  // Deflate so the next iteration finds the next direction.
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) deflated[i][j] -= lambda * u[i] * u[j];
}
const K = components.length;
console.log(`[normality] recovered ${K} components; variance retained ${(eigenvalues.reduce((a, b) => a + b, 0)).toExponential(3)}`);

// ── Project anchors, fit covariance in the reduced space ────────────────────
const project = (centred) => {
  const p = new Float64Array(K);
  for (let c = 0; c < K; c++) p[c] = dot(centred, components[c]);
  return p;
};
const P = X.map(project);

const pMean = new Float64Array(K);
for (const p of P) for (let c = 0; c < K; c++) pMean[c] += p[c] / N;

const cov = Array.from({ length: K }, () => new Float64Array(K));
for (const p of P) {
  for (let a = 0; a < K; a++) {
    const da = p[a] - pMean[a];
    for (let b = 0; b < K; b++) cov[a][b] += (da * (p[b] - pMean[b])) / (N - 1);
  }
}
// Shrink toward a scaled identity — keeps the inverse stable at N=78.
let trace = 0;
for (let a = 0; a < K; a++) trace += cov[a][a];
const target = trace / K;
for (let a = 0; a < K; a++) {
  for (let b = 0; b < K; b++) cov[a][b] *= (1 - SHRINKAGE);
  cov[a][a] += SHRINKAGE * target;
}

// ── Invert by Gauss-Jordan (K is small) ─────────────────────────────────────
const inv = Array.from({ length: K }, (_, i) => {
  const r = new Float64Array(K); r[i] = 1; return r;
});
const A = cov.map(r => Float64Array.from(r));
for (let col = 0; col < K; col++) {
  let piv = col;
  for (let r = col + 1; r < K; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
  if (Math.abs(A[piv][col]) < 1e-14) { console.error('[normality] FATAL: covariance singular'); process.exit(1); }
  [A[col], A[piv]] = [A[piv], A[col]];
  [inv[col], inv[piv]] = [inv[piv], inv[col]];
  const d = A[col][col];
  for (let j = 0; j < K; j++) { A[col][j] /= d; inv[col][j] /= d; }
  for (let r = 0; r < K; r++) {
    if (r === col) continue;
    const f = A[r][col];
    if (f === 0) continue;
    for (let j = 0; j < K; j++) { A[r][j] -= f * A[col][j]; inv[r][j] -= f * inv[col][j]; }
  }
}

// ── Calibration: what does a HEALTHY clip actually score? ────────────────────
// Shipped so the runtime can express deviation in interpretable units rather
// than raw distance. Leave-one-out would be stricter; with N=78 and shrinkage
// the in-sample spread is already the conservative direction for a shadow score.
const mahal = (p) => {
  const d = new Float64Array(K);
  for (let a = 0; a < K; a++) d[a] = p[a] - pMean[a];
  let s = 0;
  for (let a = 0; a < K; a++) { let acc = 0; for (let b = 0; b < K; b++) acc += inv[a][b] * d[b]; s += d[a] * acc; }
  return Math.sqrt(Math.max(0, s));
};
const scores = P.map(mahal).sort((a, b) => a - b);
const pct = (q) => scores[Math.min(scores.length - 1, Math.floor(q * scores.length))];
const calib = {
  healthy_median: +pct(0.50).toFixed(4),
  healthy_p90: +pct(0.90).toFixed(4),
  healthy_p99: +pct(0.99).toFixed(4),
  healthy_max: +scores[scores.length - 1].toFixed(4),
};
console.log('[normality] healthy Mahalanobis:', JSON.stringify(calib));

// Interferer anchors are a useful sanity reference — they should score HIGHER
// than healthy engines, because they are not engines at all.
const interf = art.anchors.filter(a => a.kind === 'interferer').map(a => dequantize(a.q));
if (interf.length) {
  const iScores = interf.map(v => {
    const c = new Float64Array(D);
    for (let i = 0; i < D; i++) c[i] = v[i] - mean[i];
    return mahal(project(c));
  }).sort((a, b) => a - b);
  console.log(`[normality] interferer Mahalanobis: median ${iScores[Math.floor(iScores.length / 2)].toFixed(3)} (healthy median ${calib.healthy_median})`);
}

const f32 = (arr) => Buffer.from(Float32Array.from(arr).buffer).toString('base64');
const artifact = {
  version: 'normality_v1',
  generated_by: 'scripts/build_normality_model.mjs',
  source_artifact: 'public/fingerprints_v9.json',
  anchor_count: N,
  dim: D,
  pca_dims: K,
  shrinkage: SHRINKAGE,
  calibration: calib,
  mean: f32(mean),
  proj: f32(components.flatMap(c => Array.from(c))),  // K x D, row-major
  p_mean: f32(pMean),
  inv_cov: f32(inv.flatMap(r => Array.from(r))),      // K x K, row-major
};
fs.writeFileSync(OUT, JSON.stringify(artifact));
console.log(`[normality] wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
