# Experiment: CPU-only singing synthesizer (tried and rejected)

**Question:** can we sing a user's name into a template on our own CPU, with no
provider call, so a spike of brand-new names costs milliseconds per user instead
of a slot on the provider's 2-call limit?

**Answer:** it is fast enough (about 0.15 to 0.2 s of CPU per name) but it does not
sound good enough. The name sounds pasted in, because it is a different voice from
the template's singer. Rejected for now. Run on 1 Nov 2026.

## How it works

1. **Once per template:** split `hi-pop-01` into vocals and music (Demucs), and find
   where the placeholder word "yaara" is sung (ElevenLabs speech-to-text word
   timestamps): 7.66 to 8.06 s and 19.86 to 20.28 s.
2. **Per user:** speak the name with the Mac's built-in Hindi voice (Lekha), retune
   it onto the placeholder's exact pitch curve and length with the WORLD vocoder,
   swap it into the vocal track, and mix it back with the music.

## Versions

| Version   | Change                                                              | Files                                              |
| --------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| v1        | Whole spoken name stretched evenly onto the melody                  | `audio/v1-retuned-*.mp3`                           |
| v2        | Consonants keep natural length; only vowels stretch                 | `audio/v2-consonants-kept-*.mp3`                   |
| v3        | Same melody notes, one octave lower, near the voice's natural pitch | `audio/v3-octave-lower-*.mp3`                      |
| Reference | ElevenLabs re-singing the name line (what we ship)                  | `audio/reference-elevenlabs-*.mp3`                 |
| Original  | The template with its placeholder word                              | `audio/00-template-original-placeholder-yaara.mp3` |

## Measured

Intelligibility = ElevenLabs speech-to-text on the first name spot, 12 names per
version (`scripts/score_intelligibility.mjs`).

| Version                                          | Names exactly right | Average similarity |
| ------------------------------------------------ | ------------------- | ------------------ |
| v1                                               | 3 / 12              | 55%                |
| v2                                               | 2 / 12              | 47%                |
| v3                                               | 7 / 12              | 80%                |
| Control: plain spoken name pasted in, no singing | 9 / 12              | 83%                |
| Control: through the vocoder, original pitch     | 10 / 12             | 91%                |

The controls showed the music and the vocoder were not the problem; the pitch jump
was. The template singer sings around 415 Hz and the speaking voice sits around
190 Hz, and pushing speech up more than an octave smears consonants. v3 fixed
intelligibility, but by ear the name is now clearly a different, deeper voice.

CPU cost per name: about 0.15 to 0.2 s for retune and mix, plus about 0.45 s for
the system voice and about 0.3 s for the MP3 encode, on an Apple M4.

## Why it was rejected and what would fix it

Speech-to-text measures whether the name is understandable, not whether it sounds
like the same singer. Tuning one traded away the other. A natural result needs the
name sung in the template singer's own voice: a singing-voice model trained on that
singer, or sung units taken from the singer (see the syllable-bank idea in the
design doc).

## Reproduce

Scripts are in `scripts/` and expect a Python 3.12 virtualenv with `demucs pyworld
librosa soundfile numpy "setuptools<81"`, plus a `sep/htdemucs/hi-pop-01/` folder
made by `python -m demucs --two-stems vocals -n htdemucs -o sep hi-pop-01.mp3`.
