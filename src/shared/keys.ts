// Every Redis key in one place, so naming stays consistent across API and workers.
export const keys = {
  song: (songId: string) => `song:${songId}`,
  songPrefix: () => "song:",
  pool: (lang: string, nameKey: string) => `pool:${lang}:${nameKey}`,
  // Songs waiting to be sung, per template, oldest first. A worker claims several
  // at once from here to batch them into one provider call.
  pending: (templateId: string) => `pending:${templateId}`,
  idempotency: (key: string) => `idem:${key}`,
  sttWindow: (minute: number) => `stt:${minute}`,
  singSecondsEwma: () => "stats:sing:ewma",
  mockActive: () => "mock:active",
};
