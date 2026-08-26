"""
extend_reference_wavs.py — extend the six source reference recordings to 10 s.

Why: (a) constellation fingerprinting scales with reference duration — more
frames means more hashes means a stronger time-offset coherence spike; (b) the
embedding factory picks more chunk positions from a longer file, improving
coverage. These are steady-state mechanical sounds, so seamless looping is
acoustically faithful — a 2 s alternator whine and a 10 s alternator whine are
the same physical signal.

Method: repeated equal-power crossfade loop (50 ms), which avoids the click
discontinuity a naive concatenation produces. Click transients would register
as spurious spectral peaks and pollute the constellation.

Originals are NOT modified — output goes to audio_files/extended_10s/.
"""
import os
import struct
import sys
import wave

import math

SRC_DIR = r"C:\Users\Deepak G A\Desktop\GoFriday_App\Vroomie\audio_files"
OUT_DIR = os.path.join(SRC_DIR, "extended_10s")
TARGET_SEC = 10.0
XFADE_SEC = 0.05


def read_wav(path):
    with wave.open(path, "rb") as w:
        n, sr, ch, sw = w.getnframes(), w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw != 2:
        raise ValueError(f"{path}: expected 16-bit, got {sw*8}-bit")
    samples = list(struct.unpack("<%dh" % (len(raw) // 2), raw))
    if ch > 1:                                   # downmix
        samples = [sum(samples[i:i + ch]) // ch for i in range(0, len(samples) - ch + 1, ch)]
    return samples, sr


def write_wav(path, samples, sr):
    data = struct.pack("<%dh" % len(samples), *[max(-32768, min(32767, int(s))) for s in samples])
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data)


def crossfade_extend(src, sr, target_sec, xfade_sec):
    """Loop `src` with equal-power crossfades until target length."""
    target = int(target_sec * sr)
    xf = min(int(xfade_sec * sr), len(src) // 4)
    if len(src) >= target:
        return src[:target]
    out = list(src)
    while len(out) < target:
        head, tail = out[:-xf], out[-xf:]
        blended = []
        for i in range(xf):
            t = i / max(xf - 1, 1)
            # equal-power (constant-energy) crossfade — linear would dip in level
            g_out, g_in = math.cos(t * math.pi / 2), math.sin(t * math.pi / 2)
            blended.append(tail[i] * g_out + src[i] * g_in)
        out = head + blended + list(src[xf:])
    return out[:target]


def main():
    if not os.path.isdir(SRC_DIR):
        print("source dir missing:", SRC_DIR)
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)
    names = sorted(f for f in os.listdir(SRC_DIR)
                   if f.lower().endswith(".wav") and os.path.isfile(os.path.join(SRC_DIR, f)))
    if not names:
        print("no .wav files found in", SRC_DIR)
        return 1
    for name in names:
        src_path = os.path.join(SRC_DIR, name)
        try:
            samples, sr = read_wav(src_path)
        except Exception as e:
            print(f"SKIP {name}: {e}")
            continue
        before = len(samples) / sr
        extended = crossfade_extend(samples, sr, TARGET_SEC, XFADE_SEC)
        out_path = os.path.join(OUT_DIR, name)
        write_wav(out_path, extended, sr)
        print(f"{name:32s} {before:5.2f}s -> {len(extended)/sr:5.2f}s  ({sr} Hz, mono, 16-bit)")
    print("\nwrote", OUT_DIR)
    print("originals untouched — upload the extended_10s/ files to the anomaly-patterns bucket")
    return 0


if __name__ == "__main__":
    sys.exit(main())
