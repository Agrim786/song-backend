// Returns the name as heard, or null when unavailable. Null is a normal outcome:
// the app then asks the user to type their name instead of failing.
export interface SpeechToText {
  transcribe(audio: Buffer, mime: string, lang: string, hint?: string): Promise<string | null>;
}
