// Returns the name as heard, or null when unavailable. Null is a normal outcome:
// the app then asks the user to type their name instead of failing.
// lang is optional: the app asks for the name before the song language, so the
// provider may have to detect the spoken language itself.
export interface SpeechToText {
  transcribe(audio: Buffer, mime: string, lang?: string, hint?: string): Promise<string | null>;
}
