/**
 * normalityScorer.js — PATH C, the normality model. AI ENABLED ONLY.
 *
 * Paths A and B match against libraries of KNOWN faults, so they are blind to
 * anything nobody recorded. Path C inverts the question: it models what a
 * HEALTHY engine sounds like and scores how far the live audio sits from that
 * manifold. It can therefore flag a fault that has never been catalogued.
 *
 * Scoring is a Mahalanobis distance in a 32-dimensional PCA space fitted to the
 * 78 healthy anchor embeddings that already ship in fingerprints_v9.json — see
 * scripts/build_normality_model.mjs. Mahalanobis rather than cosine because
 * cosine weights all 1024 dimensions equally, and the Engineering Reference
 * measured the consequence: a healthy idling car scores 0.892-0.918 cosine
 * against power-steering references, higher than several genuine faults.
 * Whitening by the covariance of normal audio discounts the variation that is
 * ordinary among healthy engines.
 *
 * ── SHADOW MODE ────────────────────────────────────────────────────────────
 * This module currently INFLUENCES NOTHING. Its score is computed, attached to
 * the per-window result and persisted in session_diagnostics for measurement.
 * It does not gate, suppress, or create a verdict.
 *
 * That is deliberate. Path C is a sensitivity increase by construction, and the
 * DCASE 2026 winning system reports pAUC 56.9 — near coin-flip in the very
 * low-false-alarm regime this product must operate in — describing it as "the
 * bottleneck under every calibration strategy we tried". Promotion to a
 * user-visible tier must be earned against the 140-clip healthy sweep on real
 * handsets, not assumed.
 *
 * FAIL-SAFE: every failure path returns null. A missing or malformed artifact
 * disables Path C silently; it must never break a scan.
 */
import { Logger } from './logger.js';

const ARTIFACT_URL = '/normality_v1.json';

let model = null;         // {mean, proj, pMean, invCov, dim, k, calibration}
let loadPromise = null;
let loadFailed = false;

/** Decode a base64 float32 payload into a Float32Array. */
function decodeF32(b64) {
  const bin = typeof atob === 'function'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Load the normality artifact. Idempotent; safe to call repeatedly.
 * @returns {Promise<boolean>} true when the model is usable.
 */
export async function loadNormalityModel(url = ARTIFACT_URL) {
  if (model) return true;
  if (loadFailed) return false;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const a = await res.json();

      const dim = a.dim | 0;
      const k = a.pca_dims | 0;
      if (!dim || !k) throw new Error('missing dim/pca_dims');

      const mean = decodeF32(a.mean);
      const proj = decodeF32(a.proj);
      const pMean = decodeF32(a.p_mean);
      const invCov = decodeF32(a.inv_cov);

      // Shape validation — a truncated artifact must disable Path C, not
      // silently produce nonsense distances.
      if (mean.length !== dim) throw new Error(`mean ${mean.length} != ${dim}`);
      if (proj.length !== k * dim) throw new Error(`proj ${proj.length} != ${k * dim}`);
      if (pMean.length !== k) throw new Error(`p_mean ${pMean.length} != ${k}`);
      if (invCov.length !== k * k) throw new Error(`inv_cov ${invCov.length} != ${k * k}`);

      model = { dim, k, mean, proj, pMean, invCov, calibration: a.calibration || null };
      Logger.info(`[Normality] Path C model ready — ${k}d over ${a.anchor_count} healthy anchors`);
      return true;
    } catch (err) {
      loadFailed = true;
      Logger.warn('[Normality] model unavailable — Path C disabled:', err?.message);
      return false;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

export const isNormalityReady = () => model !== null;

/** Drop the loaded model (tests / artifact refresh). */
export function resetNormalityModel() {
  model = null;
  loadPromise = null;
  loadFailed = false;
}

/**
 * Score one embedding against the healthy manifold.
 *
 * @param {ArrayLike<number>} embedding 1024-d YAMNet mean embedding
 * @returns {{distance:number, ratio:number, band:string}|null} null when the
 *          model is unavailable or the input is the wrong shape.
 *          - distance: Mahalanobis distance from the healthy centroid
 *          - ratio:    distance / healthy_p99, so 1.0 is the edge of the
 *                      healthy anchor spread and >1 is outside it
 *          - band:     'typical' | 'elevated' | 'outlier', for logging only
 */
export function scoreNormality(embedding) {
  if (!model || !embedding || embedding.length !== model.dim) return null;

  const { dim, k, mean, proj, pMean, invCov } = model;

  // Centre, then project onto the K principal directions (K x D, row-major).
  const p = new Float64Array(k);
  for (let c = 0; c < k; c++) {
    const base = c * dim;
    let acc = 0;
    for (let i = 0; i < dim; i++) acc += (embedding[i] - mean[i]) * proj[base + i];
    p[c] = acc - pMean[c];
  }

  // d^T . invCov . d
  let sum = 0;
  for (let a = 0; a < k; a++) {
    const row = a * k;
    let acc = 0;
    for (let b = 0; b < k; b++) acc += invCov[row + b] * p[b];
    sum += p[a] * acc;
  }

  const distance = Math.sqrt(Math.max(0, sum));
  const p99 = model.calibration?.healthy_p99 || 0;
  const ratio = p99 > 0 ? distance / p99 : 0;

  return {
    distance: +distance.toFixed(4),
    ratio: +ratio.toFixed(4),
    band: ratio <= 1 ? 'typical' : ratio <= 1.5 ? 'elevated' : 'outlier',
  };
}

/**
 * Aggregate per-window scores into a session-level summary for
 * session_diagnostics. Shadow-mode telemetry only — no verdict.
 *
 * @param {Array<{distance:number, ratio:number, band:string}>} windows
 */
export function summariseNormality(windows) {
  const valid = (windows || []).filter(w => w && Number.isFinite(w.distance));
  if (valid.length === 0) return null;

  const sorted = valid.map(w => w.distance).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bands = { typical: 0, elevated: 0, outlier: 0 };
  for (const w of valid) if (bands[w.band] !== undefined) bands[w.band]++;

  return {
    windows: valid.length,
    median: +median.toFixed(4),
    max: +sorted[sorted.length - 1].toFixed(4),
    p99_reference: model?.calibration?.healthy_p99 ?? null,
    bands,
    // Fraction of accepted windows sitting outside the healthy anchor spread.
    outside_healthy: +(valid.filter(w => w.ratio > 1).length / valid.length).toFixed(3),
  };
}
