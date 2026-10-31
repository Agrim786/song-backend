import type { SpeechToText } from "./stt.js";

const URL = "https://api.sarvam.ai/speech-to-text";

export class SarvamStt implements SpeechToText {
  constructor(private readonly apiKey: string) {}

  async transcribe(audio: Buffer, mime: string, lang: string): Promise<string | null> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), "name");
    form.append("model", "saaras:v3");
    form.append("mode", "transcribe");
    form.append("language_code", `${lang}-IN`);
    const res = await fetch(URL, {
      method: "POST",
      headers: { "api-subscription-key": this.apiKey },
      body: form,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res || !res.ok) return null; // 429/503/timeouts degrade to typing
    const json = (await res.json()) as { transcript?: string };
    return json.transcript?.trim() || null;
  }
}
