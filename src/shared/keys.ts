// Every Redis key in one place, so naming stays consistent across API and workers.
export const keys = {
  song: (songId: string) => `song:${songId}`,
  pool: (lang: string, nameKey: string) => `pool:${lang}:${nameKey}`,
  idempotency: (key: string) => `idem:${key}`,
  recording: (id: string) => `rec:${id}`,
  preview: (id: string) => `preview:${id}`,
  sttWindow: (minute: number) => `stt:${minute}`,
  singSecondsEwma: () => "stats:sing:ewma",
  mockActive: () => "mock:active",
};
