/** Per-key promise memo: one build per key and process, forgotten when it rejects so the next call retries. */
export function memoAsync<T>(): (key: string, build: () => Promise<T>) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key, build) => {
    let p = cache.get(key);
    if (!p) {
      p = build();
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    return p;
  };
}
