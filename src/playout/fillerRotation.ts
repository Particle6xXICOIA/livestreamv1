import { Clip } from "../types.js";

/**
 * What airs when the queue runs dry. Two sources, interleaved:
 *
 *  - the show's filler LIBRARY (pre-generated "vamping on set" clips, or the
 *    rendered card when a show has none), rotated in order;
 *  - RERUNS of scene clips that already aired this episode — free, on-theme,
 *    and far less repetitive than cycling five library clips for minutes.
 *
 * A rerun is only eligible once it is at least `minAgeMs` old (replaying the
 * scene that just aired reads as a glitch), and the least-recently-replayed
 * eligible scene goes first. Library clips always get every other slot so a
 * long stall still shows the host on set between reruns.
 */
export class FillerRotation {
  private libraryIdx = 0;
  private slot = 0;
  private reruns: { clip: Clip; airedAt: number; lastRerunAt: number }[] = [];

  constructor(
    private library: Clip[],
    private opts: { minAgeMs: number; maxReruns: number } = { minAgeMs: 4 * 60_000, maxReruns: 12 },
  ) {}

  setLibrary(library: Clip[]): void {
    this.library = library;
  }

  /** Record a clip that just aired; only scenes become rerun candidates. */
  noteAired(clip: Clip, now = Date.now()): void {
    if (clip.kind !== "scene") return;
    if (this.reruns.some((r) => r.clip.tsPath === clip.tsPath)) return;
    this.reruns.push({ clip, airedAt: now, lastRerunAt: 0 });
    if (this.reruns.length > this.opts.maxReruns) this.reruns.shift();
  }

  get rerunCount(): number {
    return this.reruns.length;
  }

  next(now = Date.now()): Clip | undefined {
    const eligible = this.reruns.filter((r) => now - r.airedAt >= this.opts.minAgeMs);
    const wantRerun = this.slot++ % 2 === 1 || this.library.length === 0;
    if (wantRerun && eligible.length) {
      eligible.sort((a, b) => a.lastRerunAt - b.lastRerunAt || a.airedAt - b.airedAt);
      const pick = eligible[0];
      pick.lastRerunAt = now;
      return { ...pick.clip, kind: "filler", label: `rerun ${pick.clip.label}` };
    }
    if (this.library.length === 0) return undefined;
    const clip = this.library[this.libraryIdx % this.library.length];
    this.libraryIdx++;
    return clip;
  }
}
