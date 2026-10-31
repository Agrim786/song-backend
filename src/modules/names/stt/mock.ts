import type { SpeechToText } from "./stt.js";

// For load tests and offline dev: echoes the hint (form field "mockName").
export class MockStt implements SpeechToText {
  async transcribe(_a: Buffer, _m: string, _l: string, hint?: string) {
    await new Promise((r) => setTimeout(r, 300));
    return hint || "राहुल";
  }
}
