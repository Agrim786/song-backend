import type { SpeechToText } from "./stt.js";

const URL = "https://api.elevenlabs.io/v1/speech-to-text";

// ElevenLabs Scribe. Same account and key as the singing provider, so no extra
// signup. With a language code it answers in that language's script.
export class ElevenLabsStt implements SpeechToText {
  constructor(private readonly apiKey: string) {}

  async transcribe(audio: Buffer, mime: string, lang?: string): Promise<string | null> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), "name");
    form.append("model_id", "scribe_v2");
    // No language: Scribe detects it (a Hindi speaker's name comes back in Devanagari).
    if (lang) form.append("language_code", lang);
    form.append("tag_audio_events", "false");
    const res = await fetch(URL, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey },
      body: form,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res || !res.ok) return null; // 429/5xx/timeouts degrade to typing
    const json = (await res.json()) as { text?: string };
    return json.text?.trim() || null;
  }
}
