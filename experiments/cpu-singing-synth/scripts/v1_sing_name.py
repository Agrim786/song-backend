"""Per-user step of the "sing only the name" idea, CPU only, no provider.

  speak the name (local TTS) -> retune it onto the placeholder's exact notes and
  length (WORLD vocoder) -> swap it into the vocal stem -> mix with the music stem.

Usage: python sing_name.py <out_dir> <name> [<name> ...]
"""
import subprocess, sys, time, os
import numpy as np, soundfile as sf, pyworld as pw, librosa

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 44100
FP = 5.0  # WORLD frame period, ms
# Where the placeholder "यारा" is sung (from word timestamps, once per template),
# widened a little into the gap before the next word.
SLOTS = [(7.62, 8.14), (19.82, 20.34)]
XF = int(0.015 * SR)  # 15 ms crossfades

# ---- once per template (would be precomputed and stored with the template) ----
voc, _ = librosa.load(f"{HERE}/sep/htdemucs/hi-pop-01/vocals.wav", sr=SR, mono=False)
mus, _ = librosa.load(f"{HERE}/sep/htdemucs/hi-pop-01/no_vocals.wav", sr=SR, mono=False)

def target_pitch(a, b):
    seg = librosa.to_mono(voc[:, int(a * SR):int(b * SR)]).astype(np.float64)
    f0, t = pw.harvest(seg, SR, f0_floor=120, f0_ceil=900, frame_period=FP)
    voiced = f0 > 0
    if voiced.sum() < 2:
        raise RuntimeError("no pitch found in slot")
    # Fill gaps so every frame of the name gets a note from the melody.
    f0 = np.interp(np.arange(len(f0)), np.flatnonzero(voiced), f0[voiced])
    rms = np.sqrt(np.mean(seg ** 2))
    return f0, rms

TARGETS = [target_pitch(a, b) for a, b in SLOTS]

# ---- per user ----
def speak(name, path):
    subprocess.run(["say", "-v", "Lekha", "-r", "150", "-o", path, name], check=True)
    y, _ = librosa.load(path, sr=SR, mono=True)
    y, _ = librosa.effects.trim(y, top_db=35)
    return y.astype(np.float64)

def sing(speech, f0_target, rms_target):
    f0, t = pw.harvest(speech, SR, f0_floor=70, f0_ceil=500, frame_period=FP)
    sp = pw.cheaptrick(speech, f0, t, SR)
    ap = pw.d4c(speech, f0, t, SR)
    n = len(f0_target)
    # Stretch the spoken name to exactly the slot length.
    idx = np.linspace(0, len(f0) - 1, n)
    lo = np.floor(idx).astype(int); hi = np.minimum(lo + 1, len(f0) - 1); w = (idx - lo)[:, None]
    sp2 = sp[lo] * (1 - w) + sp[hi] * w
    ap2 = ap[lo] * (1 - w) + ap[hi] * w
    voiced = f0[np.round(idx).astype(int)] > 0
    # Keep consonants unvoiced; put every voiced sound on the melody's pitch,
    # with a touch of vibrato so it doesn't sound like a flat robot.
    vib = 1 + 0.008 * np.sin(2 * np.pi * 5.5 * np.arange(n) * FP / 1000)
    f02 = np.where(voiced, f0_target * vib, 0.0)
    y = pw.synthesize(np.ascontiguousarray(f02), np.ascontiguousarray(sp2), np.ascontiguousarray(ap2), SR, frame_period=FP)
    y *= rms_target / (np.sqrt(np.mean(y ** 2)) + 1e-9)
    # Short room tail so a dry voice sits in a wet mix.
    ir = np.random.default_rng(0).standard_normal(int(0.25 * SR)) * np.exp(-np.linspace(0, 9, int(0.25 * SR)))
    wet = np.convolve(y, ir)[: len(y)]
    return 0.8 * y + 0.2 * wet * (np.std(y) / (np.std(wet) + 1e-9))

def render(name, out_dir):
    t0 = time.perf_counter()
    tmp = f"{out_dir}/_{name}.aiff"
    speech = speak(name, tmp)
    t_tts = time.perf_counter() - t0
    new_voc = voc.copy()
    for (a, b), (f0_t, rms_t) in zip(SLOTS, TARGETS):
        s = sing(speech, f0_t, rms_t)
        i0 = int(a * SR); i1 = i0 + len(s)
        fade = np.ones(len(s)); fade[:XF] = np.linspace(0, 1, XF); fade[-XF:] = np.linspace(1, 0, XF)
        for ch in range(new_voc.shape[0]):
            new_voc[ch, i0:i1] = new_voc[ch, i0:i1] * (1 - fade) + s * fade
    mix = new_voc + mus
    mix /= max(1.0, np.abs(mix).max() / 0.98)
    t_dsp = time.perf_counter() - t0
    wav = f"{out_dir}/{name}.wav"
    sf.write(wav, mix.T, SR)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-b:a", "192k", f"{out_dir}/svs-{name}.mp3"], check=True)
    os.remove(wav); os.remove(tmp)
    return t_tts, t_dsp, time.perf_counter() - t0

if __name__ == "__main__":
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    for nm in sys.argv[2:]:
        tts, dsp, total = render(nm, out)
        print(f"{nm}: speak {tts*1000:.0f} ms, sing+mix {dsp*1000:.0f} ms, incl. mp3 encode {total*1000:.0f} ms")
