/**
 * Per-episode spend guard. Generation is the only meaningful cost, so the
 * fal generator charges an ESTIMATE for every clip at submit time (in-flight
 * work counts immediately) and the episode loop stops starting new cycles
 * once the budget is spent — buffered content and the cached sign-off still
 * air, so the cap ends the show gracefully rather than cutting the stream.
 *
 * Estimates are deliberately conservative (charged at the highest plausible
 * rate) so the real fal bill lands at or under the cap:
 *   full quality  $0.08/s  (reference-to-video list price; text-to-video is
 *                           billed the same here even though it's currently
 *                           promo-priced lower)
 *   test quality  $0.05/s  (the post-promo 480p rate from 7 Sep 2026)
 */
export class SpendMeter {
  private spent = 0;

  /** budgetUsd <= 0 means uncapped. */
  constructor(readonly budgetUsd: number) {}

  charge(usd: number): void {
    this.spent += usd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get exhausted(): boolean {
    return this.budgetUsd > 0 && this.spent >= this.budgetUsd;
  }

  /** True when spending `usd` more would cross the cap — the pre-flight gate. */
  wouldExceed(usd: number): boolean {
    return this.budgetUsd > 0 && this.spent + usd > this.budgetUsd;
  }
}

export const USD_PER_SEC_FULL = 0.08;
export const USD_PER_SEC_TEST = 0.05;
