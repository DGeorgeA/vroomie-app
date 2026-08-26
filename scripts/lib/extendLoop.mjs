/**
 * extendLoop.mjs — crossfade-loop extension for short reference recordings.
 *
 * Shared by scripts/build_constellation_index.mjs (which applies it) and
 * scripts/qa_basic_path.mjs (which asserts it reproduces the shipped index),
 * so the builder and its test cannot drift.
 *
 * Port of the retired scripts/extend_reference_wavs.py. That script wrote to a
 * hard-coded Windows path outside the repository, which made the shipped index
 * unreproducible anywhere else; doing the extension in memory lets the Supabase
 * `anomaly-patterns` bucket be the builder's only input.
 *
 * WHY EXTEND AT ALL: constellation matching scales with reference duration —
 * more frames means more hashes means a stronger time-offset coherence spike —
 * and most bucket originals are 1-2 s, below MIN_REF_SECONDS. These are
 * steady-state mechanical sounds, so seamless looping is acoustically faithful:
 * a 2 s alternator whine and a 10 s alternator whine are the same signal.
 *
 * WHY EQUAL-POWER: a linear crossfade dips in perceived loudness at the
 * midpoint, producing an amplitude notch that shifts peak-picking inside
 * constellation(). A cos/sin pair holds power constant across the overlap.
 * A naive concatenation is worse still — the click registers as spurious
 * spectral peaks and pollutes the constellation.
 */

export const TARGET_SECONDS = 10.0;
export const XFADE_SECONDS = 0.05;

/**
 * @param {Float32Array} pcm  mono audio at `sr`
 * @param {number} targetSec  desired length in seconds
 * @param {number} sr         sample rate
 * @param {number} xfadeSec   crossfade overlap in seconds
 * @returns {Float32Array} `pcm` unchanged when already long enough, else a
 *          looped copy of exactly targetSec * sr samples.
 */
export function extendByCrossfadeLoop(pcm, targetSec, sr, xfadeSec = XFADE_SECONDS) {
  const target = Math.floor(targetSec * sr);
  if (pcm.length >= target) return pcm;

  const xf = Math.min(Math.floor(xfadeSec * sr), Math.floor(pcm.length / 2));
  if (xf < 1) {
    // Too short to crossfade — a plain repeat still beats dropping the file.
    const out = new Float32Array(target);
    for (let i = 0; i < target; i++) out[i] = pcm[i % pcm.length];
    return out;
  }

  const out = new Float32Array(target);
  out.set(pcm.subarray(0, Math.min(pcm.length, target)));
  let filled = Math.min(pcm.length, target);

  while (filled < target) {
    const start = filled - xf;            // overlap the tail already written
    const room = target - start;
    const take = Math.min(pcm.length, room);
    for (let i = 0; i < take; i++) {
      const dst = start + i;
      if (dst >= target) break;
      if (i < xf) {
        const t = (i + 1) / (xf + 1);
        out[dst] = out[dst] * Math.cos(t * Math.PI / 2) + pcm[i] * Math.sin(t * Math.PI / 2);
      } else {
        out[dst] = pcm[i];
      }
    }
    filled = Math.min(target, start + take);
    if (take <= xf) break;                // no forward progress possible
  }
  return out;
}
