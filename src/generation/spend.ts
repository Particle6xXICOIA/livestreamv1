import fs from "node:fs";
import path from "node:path";

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

  /**
   * budgetUsd <= 0 means uncapped. `onCharge` mirrors every charge somewhere
   * durable (the daily ledger) so spend survives the episode object.
   */
  constructor(
    readonly budgetUsd: number,
    private onCharge?: (usd: number) => void,
  ) {}

  charge(usd: number): void {
    this.spent += usd;
    this.onCharge?.(usd);
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

/**
 * Cross-episode spend ledger: one JSON file per UTC day under
 * DATA_DIR/spend/. The per-episode cap bounds a single Start; this bounds
 * the day, because the ~$80 day was many Starts, not one. Every estimated
 * charge is appended as it happens, so a crash mid-episode loses nothing.
 */
export class DailySpendLedger {
  constructor(
    private dir: string,
    /** <= 0 means uncapped. */
    readonly dailyBudgetUsd: number,
    private now: () => Date = () => new Date(),
  ) {}

  private file(day = this.today()): string {
    return path.join(this.dir, `${day}.json`);
  }

  today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  spentToday(): number {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as { spentUsd?: number };
      return Number(raw.spentUsd) || 0;
    } catch {
      return 0;
    }
  }

  /** Dollars still spendable today; Infinity when uncapped. */
  remainingToday(): number {
    if (this.dailyBudgetUsd <= 0) return Infinity;
    return Math.max(0, this.dailyBudgetUsd - this.spentToday());
  }

  record(usd: number, note?: string): void {
    if (!(usd > 0)) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file();
    let entry: { day: string; spentUsd: number; charges: number; updatedAt: string; lastNote?: string } = {
      day: this.today(),
      spentUsd: 0,
      charges: 0,
      updatedAt: "",
    };
    try {
      entry = { ...entry, ...(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<typeof entry>) };
    } catch {}
    entry.spentUsd = Math.round((entry.spentUsd + usd) * 10000) / 10000;
    entry.charges += 1;
    entry.updatedAt = this.now().toISOString();
    if (note) entry.lastNote = note;
    fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  }

  /**
   * The cap a new episode may run under: its own budget, tightened to what
   * is left of the day. 0 (uncapped episode) inherits the daily remainder.
   * Returns null when nothing is left today.
   */
  episodeCap(requestedUsd: number): number | null {
    const remaining = this.remainingToday();
    if (remaining === Infinity) return requestedUsd;
    if (remaining <= 0) return null;
    return requestedUsd > 0 ? Math.min(requestedUsd, remaining) : remaining;
  }
}
