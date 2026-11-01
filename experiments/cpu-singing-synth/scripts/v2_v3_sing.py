"""v2 of the per-user name singer. Same pipeline as sing_name.py, better timing:

  v1: the spoken name is stretched evenly to the slot length (consonants smear).
  v2: consonants (unvoiced frames) keep their natural length, like a singer does;
      only the voiced parts (vowels, r/l/m/n/y) are stretched or squeezed to fill
      the slot, and they carry the melody's pitch.

Usage: python sing_v2.py <out_dir> <mode: linear|cv> <say_rate> <name> [...]
"""
import os, subprocess, sys, time
import numpy as np, soundfile as sf, pyworld as pw, librosa

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 44100
FP = 5.0
SLOTS = [(7.58, 8.14), (19.78, 20.34)]  # "यारा" in both hooks, widened into the gaps around it
XF = int(0.012 * SR)

voc, _ = librosa.load(f"{HERE}/sep/htdemucs/hi-pop-01/vocals.wav", sr=SR, mono=False)
mus, _ = librosa.load(f"{HERE}/sep/htdemucs/hi-pop-01/no_vocals.wav", sr=SR, mono=False)

def target(a, b):
    seg = librosa.to_mono(voc[:, int(a * SR):int(b * SR)]).astype(np.float64)
    f0, _ = pw.harvest(seg, SR, f0_floor=120, f0_ceil=900, frame_period=FP)
    v = f0 > 0
    f0 = np.interp(np.arange(len(f0)), np.flatnonzero(v), f0[v])
    return f0, np.sqrt(np.mean(seg ** 2))

TARGETS = [target(a, b) for a, b in SLOTS]

def runs(mask):
    """[(start, end, value)] of consecutive equal values."""
    out, s = [], 0
    for i in range(1, len(mask) + 1):
        if i == len(mask) or mask[i] != mask[s]:
            out.append((s, i, bool(mask[s]))); s = i
    return out

def time_map(voiced, n_out, mode):
    """For each output frame, which input frame (fractional) to read."""
    n_in = len(voiced)
    if mode == "linear":
        return np.linspace(0, n_in - 1, n_out)
    # Merge tiny unvoiced blips (pitch-tracker noise inside a vowel) into the vowel.
    v = voiced.copy()
    for s, e, val in runs(v):
        if not val and e - s < 4 and s > 0 and e < n_in:
            v[s:e] = True
    segs = runs(v)
    cons = sum(e - s for s, e, val in segs if not val)
    vow = n_in - cons
    # Consonants keep natural length, but never take more than 40% of the slot.
    c_scale = min(1.0, 0.4 * n_out / max(cons, 1))
    c_out = cons * c_scale
    v_scale = (n_out - c_out) / max(vow, 1)
    lens = [(e - s) * (c_scale if not val else v_scale) for s, e, val in segs]
    # Piecewise-linear map from output frames back to input frames.
    xo = np.concatenate([[0], np.cumsum(lens)])
    xi = np.array([segs[0][0]] + [e for _, e, _ in segs], dtype=float)
    return np.clip(np.interp(np.arange(n_out) * (xo[-1] / n_out), xo, xi), 0, n_in - 1)

def fit(y, n_samples):
    out = np.zeros(n_samples); out[: min(len(y), n_samples)] = y[:n_samples]; return out

def sing(speech, f0_t, rms_t, mode):
    n_samples = int(len(f0_t) * FP / 1000 * SR)
    if mode == "dry":
        y = fit(speech, n_samples)
        return y * rms_t / (np.sqrt(np.mean(y ** 2)) + 1e-9)
    f0, t = pw.harvest(speech, SR, f0_floor=70, f0_ceil=500, frame_period=FP)
    if mode == "world":
        y = fit(pw.synthesize(f0, pw.cheaptrick(speech, f0, t, SR), pw.d4c(speech, f0, t, SR), SR, frame_period=FP), n_samples)
        return y * rms_t / (np.sqrt(np.mean(y ** 2)) + 1e-9)
    sp = pw.cheaptrick(speech, f0, t, SR)
    ap = pw.d4c(speech, f0, t, SR)
    n = len(f0_t)
    idx = time_map(f0 > 0, n, mode)
    lo = np.floor(idx).astype(int); hi = np.minimum(lo + 1, len(f0) - 1); w = (idx - lo)[:, None]
    sp2 = sp[lo] * (1 - w) + sp[hi] * w
    ap2 = ap[lo] * (1 - w) + ap[hi] * w
    voiced = f0[np.round(idx).astype(int)] > 0
    vib = 1 + 0.008 * np.sin(2 * np.pi * 5.5 * np.arange(n) * FP / 1000)
    # PITCH=melody: template notes as sung. octfit: same notes, shifted by whole
    # octaves to sit near the speaker's natural pitch. speech: keep spoken pitch.
    pm = os.environ.get("PITCH", "melody")
    src = f0[np.round(idx).astype(int)]
    if pm == "speech":
        f02 = src * 1.0
    else:
        tgt = f0_t.copy()
        if pm == "octfit":
            spk = np.median(f0[f0 > 0])
            tgt = tgt * 2.0 ** np.round(np.log2(spk / np.median(tgt)))
        f02 = np.where(voiced, tgt * vib, 0.0)
    if os.environ.get("DEBUG"): print(f"  speaker median f0 {np.median(f0[f0>0]):.0f} Hz, melody median {np.median(f0_t):.0f} Hz, used median {np.median(f02[f02>0]):.0f} Hz", file=sys.stderr)
    y = pw.synthesize(np.ascontiguousarray(f02), np.ascontiguousarray(sp2), np.ascontiguousarray(ap2), SR, frame_period=FP)
    y *= rms_t / (np.sqrt(np.mean(y ** 2)) + 1e-9)
    ir = np.random.default_rng(0).standard_normal(int(0.25 * SR)) * np.exp(-np.linspace(0, 9, int(0.25 * SR)))
    wet = np.convolve(y, ir)[: len(y)]
    return 0.8 * y + 0.2 * wet * (np.std(y) / (np.std(wet) + 1e-9))

def render(name, out_dir, mode, rate):
    t0 = time.perf_counter()
    tmp = f"{out_dir}/_{name}.aiff"
    subprocess.run(["say", "-v", "Lekha", "-r", str(rate), "-o", tmp, name], check=True)
    y, _ = librosa.load(tmp, sr=SR, mono=True)
    speech = librosa.effects.trim(y, top_db=int(os.environ.get("TRIM_DB", "35")))[0].astype(np.float64)
    t1 = time.perf_counter()
    new_voc = voc.copy()
    for (a, b), (f0_t, rms_t) in zip(SLOTS, TARGETS):
        s = sing(speech, f0_t, rms_t, mode)
        i0 = int(a * SR); i1 = i0 + len(s)
        fade = np.ones(len(s)); fade[:XF] = np.linspace(0, 1, XF); fade[-XF:] = np.linspace(1, 0, XF)
        new_voc[:, i0:i1] = new_voc[:, i0:i1] * (1 - fade) + s * fade
    mix = new_voc + mus
    mix /= max(1.0, np.abs(mix).max() / 0.98)
    t2 = time.perf_counter()
    wav = f"{out_dir}/_{name}.wav"
    sf.write(wav, mix.T, SR)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-b:a", "192k", f"{out_dir}/{name}.mp3"], check=True)
    os.remove(wav); os.remove(tmp)
    return len(speech) / SR, (t1 - t0) * 1000, (t2 - t1) * 1000

if __name__ == "__main__":
    out, mode, rate, names = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4:]
    os.makedirs(out, exist_ok=True)
    for nm in names:
        dur, speak_ms, sing_ms = render(nm, out, mode, rate)
        print(f"{nm}\tspoken {dur:.2f}s\tspeak {speak_ms:.0f}ms\tsing+mix {sing_ms:.0f}ms")
