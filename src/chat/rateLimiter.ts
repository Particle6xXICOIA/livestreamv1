/**
 * Per-connection chat rate limit: a token bucket of `burst` messages that
 * refills `perSec` per second. Keeps one keyboard from flooding the director
 * (and everyone's chat pane) — a courtesy limit, not a security boundary.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private burst = 5,
    private perSec = 0.5,
    private now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  allow(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
