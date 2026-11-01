// Songs are content-addressed (same name + template = same key), so they can be
// cached forever at the CDN.
export interface FileStorage {
  put(
    key: string,
    data: Buffer,
    contentType: string,
    opts?: { immutable?: boolean },
  ): Promise<void>;
  get(key: string): Promise<Buffer>;
  url(key: string): string;
}
