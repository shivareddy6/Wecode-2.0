// Minimal in-memory token bucket, keyed by an arbitrary string (an IP, a
// socket id, ...). Shared by connectionLimits.ts (per-IP connect
// attempts) and eventRateLimit.ts (per-socket event emission) so both
// rate-limiting needs use the same primitive rather than two ad hoc
// implementations.
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  // Returns true if a token was available and consumed.
  consume(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? {
      tokens: this.capacity,
      lastRefill: now,
    };

    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsedSeconds * this.refillPerSecond,
    );
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  delete(key: string): void {
    this.buckets.delete(key);
  }
}
