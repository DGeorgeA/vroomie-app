/**
 * constellationMatcher.js — Shazam-style acoustic fingerprint fast path.
 *
 * WHAT THIS IS: spectral-peak constellation hashing (Wang 2003). The
 * spectrogram is reduced to per-band local maxima; peaks are paired into
 * (f1, df, dt) hashes; matching is decided by TIME-OFFSET COHERENCE — a true
 * match spikes at a single offset while unrelated audio scatters uniformly.
 *
 * WHAT IT IS FOR: identifying a KNOWN REFERENCE RECORDING heard through a
 * speaker, microphone and room — exactly the bench-test case, and exactly what
 * Shazam solves. It reports in <= 5 s.
 *
 * WHAT IT IS NOT: a generaliser. Like Shazam (which identifies the studio
 * track but not a cover version), this cannot recognise a DIFFERENT vehicle
 * with the same fault — a real customer's failing alternator is a different
 * waveform and produces no hash matches. That case is why the YAMNet
 * embedding pipeline remains the primary engine; this runs in front of it as
 * an additive fast path and never suppresses it.
 *
 * MEASURED OPERATING POINT (scripts/proto_constellation_sensitivity.mjs):
 *   42/42 references identified across close/30cm/50cm/1m/tiny-speaker at 3 s
 *   and 5 s, zero misidentifications. Worst negative across 115 held-out
 *   healthy clips + speech/music/fan/traffic: score 237, normalized 0.024.
 *   Thresholds below sit ~2.1x above that and ~2.5x below the worst accepted
 *   positive. Raw score ALONE is not separable (worst positive 208 < worst
 *   negative 237) — the normalized criterion is what makes this safe.
 *
 * This module is self-contained: no imports, no side effects, no thresholds
 * shared with the embedding engine.
 */

export const SR = 16000;
const NFFT = 1024;          // 64 ms @16k — 31.25 Hz/bin
const HOP = 256;            // 16 ms frame advance
const NBINS = NFFT / 2;
const BANDS = [0, 20, 40, 80, 160, 320, NBINS];
const PEAK_FACTOR = 1.6;    // peak must exceed its band's mean by this factor
const FANOUT = 6;           // targets paired per anchor peak
const DT_MIN = 1, DT_MAX = 48, DF_MAX = 160;

// Decision thresholds — BOTH must hold (see measured operating point above).
export const MIN_COHERENT_SCORE = 400;
export const MIN_NORMALIZED_SCORE = 0.05;
/** Rolling listen window. Shazam-like: identify from a few seconds of audio. */
export const LISTEN_SECONDS = 5;
/** Do not attempt a match before this much audio has accumulated. */
export const MIN_LISTEN_SECONDS = 3;

const HANN = (() => {
  const w = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NFFT - 1));
  return w;
})();

/** In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Per-frame, per-band strongest bin that stands above the band mean. */
function constellation(pcm) {
  const peaks = [];
  const frames = Math.floor((pcm.length - NFFT) / HOP) + 1;
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), mag = new Float64Array(NBINS);
  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    for (let i = 0; i < NFFT; i++) { re[i] = pcm[off + i] * HANN[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < NBINS; i++) mag[i] = Math.hypot(re[i], im[i]);
    for (let b = 0; b < BANDS.length - 1; b++) {
      const lo = BANDS[b], hi = BANDS[b + 1];
      let best = -1, bestI = -1, sum = 0;
      for (let i = lo; i < hi; i++) { sum += mag[i]; if (mag[i] > best) { best = mag[i]; bestI = i; } }
      if (best > (sum / (hi - lo)) * PEAK_FACTOR && best > 1e-6) peaks.push(t, bestI);
    }
  }
  return peaks;   // flat [t0,f0, t1,f1, ...] — avoids per-peak object churn
}

const packHash = (f1, df, dt) => ((f1 & 0x1ff) << 15) | (((df + 256) & 0x1ff) << 6) | (dt & 0x3f);

/**
 * Fingerprint PCM (mono, 16 kHz). Returns {h: Int32Array, t: Int32Array}.
 * IDENTICAL code path is used to build the index and to query it — sharing
 * this function is what guarantees index/query hashing parity.
 */
export function computeConstellationHashes(pcm) {
  const p = constellation(pcm);
  const hs = [], ts = [];
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const at = p[i * 2], af = p[i * 2 + 1];
    let paired = 0;
    for (let j = i + 1; j < n && paired < FANOUT; j++) {
      const bt = p[j * 2], bf = p[j * 2 + 1];
      const dt = bt - at;
      if (dt < DT_MIN) continue;
      if (dt > DT_MAX) break;
      const df = bf - af;
      if (df > DF_MAX || df < -DF_MAX) continue;
      hs.push(packHash(af, df, dt));
      ts.push(at);
      paired++;
    }
  }
  return { h: Int32Array.from(hs), t: Int32Array.from(ts) };
}

// ── index ───────────────────────────────────────────────────────────────────
let index = null;      // Map<hash, Int32Array of packed (refId<<20 | t)>
let refs = [];         // [{label, fault_type, severity, source_file}]
let loadFailed = false;

const b64ToInt32 = (b64) => {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

/** Build the runtime lookup from the compact artifact form. */
export function hydrateIndex(artifact) {
  const keys = b64ToInt32(artifact.keys);
  const vals = b64ToInt32(artifact.vals);
  const map = new Map();
  // keys/vals are parallel and grouped by key; collect runs into typed arrays
  let i = 0;
  while (i < keys.length) {
    const k = keys[i];
    let j = i;
    while (j < keys.length && keys[j] === k) j++;
    map.set(k, vals.subarray(i, j));
    i = j;
  }
  index = map;
  refs = artifact.refs || [];
  return { hashes: map.size, refs: refs.length };
}

export async function loadConstellationIndex(url = '/constellation_v1.json') {
  if (index || loadFailed) return !!index;
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    hydrateIndex(await res.json());
    return true;
  } catch (e) {
    // Fail SAFE: the embedding pipeline is unaffected when this is unavailable.
    loadFailed = true;
    index = null;
    return false;
  }
}

export const isIndexReady = () => !!index;

/**
 * Match fingerprinted audio against the index by time-offset coherence.
 * Returns the best reference and whether it clears BOTH thresholds.
 */
export function matchHashes(fp) {
  if (!index || fp.h.length === 0) return { matched: false, score: 0, normalized: 0, ref: null };
  const perRef = new Map();     // refId -> Map(offset -> count)
  for (let i = 0; i < fp.h.length; i++) {
    const hits = index.get(fp.h[i]);
    if (!hits) continue;
    const qt = fp.t[i];
    for (let k = 0; k < hits.length; k++) {
      const packed = hits[k];
      const refId = packed >>> 20;
      const rt = packed & 0xfffff;
      let m = perRef.get(refId);
      if (!m) { m = new Map(); perRef.set(refId, m); }
      const off = rt - qt;
      m.set(off, (m.get(off) || 0) + 1);
    }
  }
  let bestId = -1, bestScore = 0, secondScore = 0;
  for (const [refId, m] of perRef) {
    let local = 0;
    for (const c of m.values()) if (c > local) local = c;
    if (local > bestScore) { secondScore = bestScore; bestScore = local; bestId = refId; }
    else if (local > secondScore) secondScore = local;
  }
  const normalized = bestScore / fp.h.length;
  const ref = bestId >= 0 ? refs[bestId] : null;
  return {
    matched: !!ref && bestScore >= MIN_COHERENT_SCORE && normalized >= MIN_NORMALIZED_SCORE,
    score: bestScore, secondScore, normalized, ref,
  };
}

/**
 * Rolling listener: feed 16 kHz PCM chunks, ask for a verdict.
 * Keeps only the most recent LISTEN_SECONDS of audio.
 */
export function createRollingMatcher() {
  const cap = SR * LISTEN_SECONDS;
  const buf = new Float32Array(cap);
  let filled = 0, write = 0, totalFed = 0;
  return {
    push(chunk) {
      totalFed += chunk.length;
      for (let i = 0; i < chunk.length; i++) {
        buf[write] = chunk[i];
        write = (write + 1) % cap;
      }
      filled = Math.min(filled + chunk.length, cap);
    },
    secondsBuffered: () => filled / SR,
    /** Null until enough audio has accumulated or the index is unavailable. */
    tryMatch() {
      if (!index || filled < SR * MIN_LISTEN_SECONDS) return null;
      // linearise the ring buffer oldest-first
      const lin = new Float32Array(filled);
      const start = (write - filled + cap) % cap;
      for (let i = 0; i < filled; i++) lin[i] = buf[(start + i) % cap];
      return matchHashes(computeConstellationHashes(lin));
    },
    reset() { filled = 0; write = 0; totalFed = 0; },
  };
}
