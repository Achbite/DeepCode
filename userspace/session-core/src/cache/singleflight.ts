export class SingleflightDeduper<T> {
  private inflight = new Map<string, Promise<T>>();

  run(cacheKey: string, factory: () => Promise<T>): Promise<T> {
    const current = this.inflight.get(cacheKey);
    if (current) return current;
    const next = factory().finally(() => {
      this.inflight.delete(cacheKey);
    });
    this.inflight.set(cacheKey, next);
    return next;
  }
}
