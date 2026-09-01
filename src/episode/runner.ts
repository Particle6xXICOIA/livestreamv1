import path from "node:path";
import fs from "node:fs";
import { ChatSource, Clip, ClipGenerator, CycleDecision, Director, Suggestion } from "../types.js";
import { Config } from "../config.js";
import { Playout } from "../playout/playout.js";
import { EpisodeArchive, finalizeRecording, freeBytes, pruneEpisodes } from "./archive.js";
import { SpendMeter, USD_PER_SEC_FULL, USD_PER_SEC_TEST } from "../generation/spend.js";
import { normalizeToTs, probeDurationSec, renderCardClip } from "../generation/ffmpeg.js";
import {
  ShowConfig,
  hasHostRiffs,
  loadShowState,
  saveShowState,
  sceneRefsForCast,
  showAssetDirs,
} from "../shows.js";

/** Live snapshot for the producer panel and /healthz. */
export interface EpisodeStatus {
  cycle: number;
  inFlight: number;
  bufferedSec: number;
  live: boolean;
  stopping: "none" | "graceful" | "hard";
  spentUsd: number;
  budgetUsd: number;
  lastError: string | null;
  endsAt: string | null;
}

/** How many suggestions one director call may see (the newest win). */
const MAX_SUGGESTIONS_PER_CYCLE = 40;

export class EpisodeRunner {
  private playout: Playout;
  private archive: EpisodeArchive;
  private stopRequested = false;
  private hardStopRequested = false;
  private hardStopSignal: () => void = () => {};
  private hardStopped = new Promise<void>((r) => (this.hardStopSignal = r));
  private lastError: string | null = null;
  private status: EpisodeStatus = {
    cycle: 0,
    inFlight: 0,
    bufferedSec: 0,
    live: false,
    stopping: "none",
    spentUsd: 0,
    budgetUsd: 0,
    lastError: null,
    endsAt: null,
  };
  /** Optional hook: called after each director decision (e.g. to tell chat). */
  onDecision?: (decision: CycleDecision, cycle: number) => void;
  /** Optional hook: called whenever the live status snapshot changes materially. */
  onStatus?: (status: EpisodeStatus) => void;

  constructor(
    private config: Config,
    private show: ShowConfig,
    private chat: ChatSource,
    private director: Director,
    private generator: ClipGenerator,
    /** Estimated-spend meter the generator charges; gates new cycles at the budget. */
    private spend?: SpendMeter,
  ) {
    this.archive = new EpisodeArchive(config.outDir);
    this.playout = new Playout(
      { rtmpUrl: config.rtmpUrl, hlsDir: config.hlsDir, localPath: path.join(this.archive.dir, "stream.ts") },
      (clip) => this.archive.log("playing", { kind: clip.kind, label: clip.label, sec: clip.durationSec }),
    );
    this.playout.onError = (err) => {
      this.noteError(`playout: ${err.message}`);
      this.archive.log("playout_error", { error: err.message });
    };
    if (config.hlsDir) fs.mkdirSync(config.hlsDir, { recursive: true });
    this.status.budgetUsd = spend?.budgetUsd ?? 0;
  }

  /** Graceful: no new cycles; buffered + in-flight content airs, then the sign-off. */
  requestStop(): void {
    this.stopRequested = true;
    if (this.status.stopping === "none") this.status.stopping = "graceful";
    this.emitStatus();
  }

  /** Immediate: abandon in-flight generation, cut the stream now, keep the recording. */
  requestHardStop(): void {
    this.stopRequested = true;
    this.hardStopRequested = true;
    this.status.stopping = "hard";
    this.hardStopSignal();
    void this.playout.kill();
    this.emitStatus();
  }

  /** Estimated generation spend so far (0 on dry runs). */
  get spentUsd(): number {
    return round2(this.spend?.spentUsd ?? 0);
  }

  get archiveDir(): string {
    return this.archive.dir;
  }

  snapshot(): EpisodeStatus {
    return { ...this.status, spentUsd: this.spentUsd, lastError: this.lastError };
  }

  private emitStatus(): void {
    this.onStatus?.(this.snapshot());
  }

  private noteError(text: string): void {
    this.lastError = text.slice(0, 300);
    this.emitStatus();
  }

  async run(): Promise<void> {
    const { config } = this;
    this.archive.log("episode_start", {
      show: this.show.id,
      dryRun: config.dryRun,
      minutes: config.episodeMinutes,
      budgetUsd: this.spend?.budgetUsd ?? 0,
      output: config.hlsDir ? "hls" : config.rtmpUrl ? "rtmp" : "local file",
    });

    // Make room BEFORE recording starts: prune older episodes to the cap and
    // require headroom on the disk, so a long show can't fill the volume and
    // take the recording (and ffmpeg) down with it.
    try {
      const deleted = pruneEpisodes(config.outDir, config.archiveMaxGB * 1e9, this.archive.dir);
      if (deleted.length) this.archive.log("archive_pruned", { deleted, when: "pre-start" });
    } catch (err) {
      this.archive.log("archive_error", { error: String(err) });
    }
    const freeGB = this.freeGB();
    if (freeGB !== null && freeGB < config.minFreeGB) {
      this.archive.log("episode_end", { cycles: 0, aborted: `only ${freeGB.toFixed(2)} GB free on the archive disk (need ${config.minFreeGB})` });
      await this.finalizeArchive();
      throw new Error(`not enough disk for a recording: ${freeGB.toFixed(2)} GB free, need ${config.minFreeGB} GB (lower ARCHIVE_MAX_GB or grow the volume)`);
    }

    this.playout.setFillers(await this.makeFillers());
    await this.chat.start();

    // The stream does not go live until the opening AND the first cycle are
    // buffered (see releaseReady below) — so it opens on content, not filler.
    // Riff-less shows with no cached opening go straight into the first scene.
    if (this.cachedSegment("opening") || this.show.format.openingRiff.trim()) {
      await this.enqueueGenerated("opening", () =>
        this.cachedSegment("opening") ??
        this.generator.generateHostClip(this.show.format.openingRiff, this.archive.clipsDir, "opening"),
      );
    }

    const endAt = Date.now() + config.episodeMinutes * 60_000;
    this.status.endsAt = new Date(endAt).toISOString();
    const recentCycles: string[] = [];

    // Running show state (scores, story progress) on shows that track it —
    // seeded from disk when the show persists its saga across streams.
    let showState: string | null = this.show.format.stateInstructions
      ? this.show.format.persistState
        ? loadShowState(this.show)
        : null
      : null;
    if (showState) this.archive.log("state_loaded", { state: showState });

    // Pipelined generation: up to maxConcurrentCycles cycles generate at once,
    // and generation runs ahead of playout until bufferTargetSec of content is
    // queued. Clips still air strictly in cycle order — finished cycles wait in
    // `completed` until every earlier cycle has been released to the queue.
    const inFlight = new Map<number, Promise<void>>();
    const completed = new Map<number, Clip[]>();
    let nextToAir = 1;
    let cycle = 0;

    let live = false;
    const releaseReady = () => {
      while (completed.has(nextToAir)) {
        for (const clip of completed.get(nextToAir)!) this.playout.enqueue(clip);
        completed.delete(nextToAir);
        nextToAir++;
      }
      if (!live && nextToAir > 1 && !this.hardStopRequested) {
        live = true;
        this.status.live = true;
        this.archive.log("going_live", { bufferedSec: this.playout.queuedSeconds });
        this.playout.start();
      }
      this.refreshStatus(cycle, inFlight.size, bufferedSec());
    };
    const bufferedSec = () =>
      this.playout.queuedSeconds +
      [...completed.values()].flat().reduce((s, c) => s + c.durationSec, 0);

    // Pre-flight budget gate: generation is charged at submit time, so the
    // gate must refuse any cycle whose WORST-CASE cost would cross the cap —
    // checking after the fact would overshoot by up to a full in-flight
    // cycle. Worst case: 15s scene (+15s host riff on hosted shows).
    const perSec = config.testQuality ? USD_PER_SEC_TEST : USD_PER_SEC_FULL;
    const worstCycleUsd = (hasHostRiffs(this.show) ? 30 : 15) * perSec;

    // Suggestions drained for a director call that failed are carried into
    // the next attempt instead of being lost.
    let carried: Suggestion[] = [];
    let directorFailures = 0;
    let lastDiskCheck = Date.now();

    while (Date.now() < endAt && cycle < config.maxCycles && !this.stopRequested) {
      if (this.playout.failed) {
        this.archive.log("episode_abort", { reason: "playout failed", error: this.playout.error?.message });
        break;
      }
      if (this.spend?.wouldExceed(worstCycleUsd)) {
        this.archive.log("budget_reached", {
          budgetUsd: this.spend.budgetUsd,
          spentUsd: round2(this.spend.spentUsd),
        });
        break;
      }
      if (Date.now() - lastDiskCheck > 30_000) {
        lastDiskCheck = Date.now();
        const free = this.freeGB();
        if (free !== null && free < config.minFreeGB) {
          this.archive.log("disk_low", { freeGB: round2(free), minFreeGB: config.minFreeGB });
          this.noteError(`disk low (${free.toFixed(2)} GB free) — ending the episode`);
          this.requestStop();
          break;
        }
      }
      if (inFlight.size >= config.maxConcurrentCycles || bufferedSec() >= config.bufferTargetSec) {
        await sleep(1000);
        continue;
      }

      cycle++;
      const thisCycle = cycle;
      const suggestions = [...carried, ...this.chat.drainSuggestions()].slice(-MAX_SUGGESTIONS_PER_CYCLE);
      carried = [];
      this.archive.log("cycle_start", { cycle: thisCycle, suggestions });
      this.refreshStatus(cycle, inFlight.size, bufferedSec());

      // Decide before spawning generation so recentCycles stays coherent
      // across overlapping cycles.
      let decision: CycleDecision;
      const tDirector = Date.now();
      try {
        decision = await withTimeout(
          this.director.decide({
            suggestions,
            recentCycles: recentCycles.slice(-8),
            cycleNumber: thisCycle,
            showState,
          }),
          config.directorTimeoutSec * 1000,
          "director",
        );
        directorFailures = 0;
      } catch (err) {
        // The director being down must not spin the loop or lose chat: back
        // off (5s, 10s, 20s, … capped at 60s), keep the suggestions, and let
        // fillers cover the gap. The cycle number is consumed so air order
        // stays simple.
        directorFailures++;
        carried = suggestions;
        const backoffMs = Math.min(60_000, 5_000 * 2 ** (directorFailures - 1));
        this.archive.log("cycle_error", { cycle: thisCycle, stage: "director", error: String(err), backoffMs, directorMs: Date.now() - tDirector });
        this.noteError(`director: ${String(err)}`);
        completed.set(thisCycle, []);
        releaseReady();
        await this.sleepUnlessStopped(backoffMs);
        continue;
      }
      this.archive.log("decision", {
        cycle: thisCycle,
        directorMs: Date.now() - tDirector,
        picked: decision.suggestion,
        riff: decision.hostRiff,
        scenePrompt: decision.scenePrompt,
        sceneSec: decision.sceneDurationSec,
        cast: decision.castNames,
        updatedState: decision.updatedState,
        declined: decision.declined,
      });
      recentCycles.push(
        decision.suggestion ? decision.suggestion.text : `(invented) ${decision.scenePrompt.slice(0, 80)}`,
      );
      if (decision.updatedState !== null && this.show.format.stateInstructions) {
        showState = decision.updatedState;
        if (this.show.format.persistState) {
          try {
            saveShowState(this.show, showState);
          } catch (err) {
            this.archive.log("state_error", { cycle: thisCycle, error: String(err) });
          }
        }
      }
      this.onDecision?.(decision, thisCycle);

      const task = (async () => {
        const tag = `cycle-${String(thisCycle).padStart(3, "0")}`;
        try {
          const t0 = Date.now();
          // Multi-character scenes carry their own reference set; riff-less
          // shows air the scene alone (no host segment between scenes).
          const sceneRefs = sceneRefsForCast(this.show, decision.castNames);
          const riff = decision.hostRiff.trim();
          // A generation that never returns must not block air order forever
          // (everything behind it would wait, and the episode could never
          // end). Past the timeout the cycle is abandoned — fal's own work
          // (already charged) is simply ignored if it finishes later.
          const [host, scene] = await withTimeout(
            Promise.all([
              riff ? this.generator.generateHostClip(riff, this.archive.clipsDir, tag) : null,
              this.generator.generateSceneClip(decision.scenePrompt, decision.sceneDurationSec, this.archive.clipsDir, tag, sceneRefs),
            ]),
            config.generationTimeoutSec * 1000,
            `generation (${tag})`,
          );
          if (this.hardStopRequested) return;
          const clips = [
            ...(host ? [await this.toClip(host.mp4Path, host.durationSec, "host", `${tag} riff`)] : []),
            await this.toClip(scene.mp4Path, scene.durationSec, "scene", `${tag} scene`),
          ];
          this.archive.log("generated", { cycle: thisCycle, generationMs: Date.now() - t0 });
          completed.set(thisCycle, clips);
        } catch (err) {
          // A failed cycle must never kill the show or stall the air order —
          // it releases as zero clips and fillers cover the gap.
          this.archive.log("cycle_error", { cycle: thisCycle, stage: "generation", error: String(err) });
          this.noteError(`generation: ${String(err)}`);
          completed.set(thisCycle, []);
        } finally {
          inFlight.delete(thisCycle);
          releaseReady();
        }
      })();
      inFlight.set(thisCycle, task);
      this.refreshStatus(cycle, inFlight.size, bufferedSec());
    }

    // Let in-flight cycles finish and air before the closing segment — unless
    // a hard stop cuts that short.
    await Promise.race([Promise.allSettled([...inFlight.values()]), this.hardStopped]);
    if (!this.hardStopRequested) releaseReady();

    if (this.hardStopRequested) {
      await this.chat.stop().catch(() => {});
      await this.playout.kill();
      this.archive.log("episode_end", { cycles: cycle, aborted: "hard stop", estimatedSpendUsd: round2(this.spend?.spentUsd ?? 0) });
      await this.finalizeArchive();
      this.status.live = false;
      this.emitStatus();
      return;
    }

    // Stopped before anything aired: cancel outright — no ghost 16s episode.
    if (!live && (this.stopRequested || this.playout.failed)) {
      await this.chat.stop().catch(() => {});
      await this.playout.kill();
      this.archive.log("episode_end", { cycles: cycle, aborted: this.playout.failed ? "playout failed" : "stopped before going live" });
      await this.finalizeArchive();
      this.emitStatus();
      return;
    }

    // A cached closing is free; generating one respects the budget too.
    if (
      !this.playout.failed &&
      (this.cachedSegment("closing") ||
        (this.show.format.closingRiff.trim() && !this.spend?.wouldExceed(15 * perSec)))
    ) {
      await this.enqueueGenerated("closing", () =>
        this.cachedSegment("closing") ??
        this.generator.generateHostClip(this.show.format.closingRiff, this.archive.clipsDir, "closing"),
      );
    }
    // Degenerate episode (zero cycles aired): still go live to play what exists.
    if (!live && !this.playout.failed) this.playout.start();

    await this.chat.stop().catch(() => {});
    await this.playout.drainAndStop();
    this.archive.log("episode_end", {
      cycles: cycle,
      estimatedSpendUsd: round2(this.spend?.spentUsd ?? 0),
      ...(this.playout.failed ? { aborted: "playout failed" } : {}),
    });
    await this.finalizeArchive();
    this.status.live = false;
    this.emitStatus();
    console.log(`\nEpisode archive: ${this.archive.dir}`);
  }

  private refreshStatus(cycle: number, inFlight: number, bufferedSec: number): void {
    const next = { ...this.status, cycle, inFlight, bufferedSec: Math.round(bufferedSec) };
    const changed =
      next.cycle !== this.status.cycle ||
      next.inFlight !== this.status.inFlight ||
      Math.abs(next.bufferedSec - this.status.bufferedSec) >= 5;
    this.status = next;
    if (changed) this.emitStatus();
  }

  private freeGB(): number | null {
    try {
      return freeBytes(this.config.outDir) / 1e9;
    } catch {
      return null;
    }
  }

  private async sleepUnlessStopped(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until && !this.stopRequested) await sleep(Math.min(500, until - Date.now()));
  }

  /**
   * Turn the playout's continuous stream.ts recording into a downloadable
   * episode.mp4, drop the derivable working files (normalized .ts copies of
   * every clip), and keep the archive under its size cap. The raw generated
   * mp4 clips stay — they're the paid outputs, reusable for recutting.
   */
  private async finalizeArchive(): Promise<void> {
    try {
      const saved = await finalizeRecording(this.archive.dir);
      if (saved) this.archive.log("recording_saved", saved);
      for (const f of fs.readdirSync(this.archive.clipsDir)) {
        if (f.endsWith(".ts")) fs.rmSync(path.join(this.archive.clipsDir, f), { force: true });
      }
      const deleted = pruneEpisodes(this.config.outDir, this.config.archiveMaxGB * 1e9, this.archive.dir);
      if (deleted.length) this.archive.log("archive_pruned", { deleted });
    } catch (err) {
      this.archive.log("archive_error", { error: String(err) });
    }
  }

  async abort(): Promise<void> {
    this.requestHardStop();
    await this.chat.stop().catch(() => {});
    await this.playout.kill();
  }

  private async enqueueGenerated(
    kind: "opening" | "closing",
    gen: () => Promise<{ mp4Path: string; durationSec: number }>,
  ): Promise<void> {
    try {
      const raw = await withTimeout(gen(), this.config.generationTimeoutSec * 1000, `generation (${kind})`);
      if (this.hardStopRequested) return;
      this.playout.enqueue(await this.toClip(raw.mp4Path, raw.durationSec, kind, kind));
    } catch (err) {
      this.archive.log("segment_error", { kind, error: String(err) });
      this.noteError(`${kind}: ${String(err)}`);
    }
  }

  /** Returns the pre-generated segment clip when the show's library has it, else null. */
  private cachedSegment(kind: "opening" | "closing"): Promise<{ mp4Path: string; durationSec: number }> | null {
    const mp4Path = path.join(showAssetDirs(this.show).segments, `${kind}-host.mp4`);
    return fs.existsSync(mp4Path) ? Promise.resolve({ mp4Path, durationSec: 0 }) : null;
  }

  private async toClip(mp4Path: string, _durationSec: number, kind: Clip["kind"], label: string): Promise<Clip> {
    const tsPath = await normalizeToTs(mp4Path, this.config.video);
    // Exact duration of the normalized output — playout uses it as the
    // running timestamp offset, so it must match the actual media.
    const durationSec = await probeDurationSec(tsPath);
    return { tsPath, durationSec, kind, label };
  }

  /**
   * Filler clips that air whenever the queue runs dry. Pre-generated H3 Max
   * clips dropped in assets/fallback/ are used when present; otherwise a
   * rendered card keeps the stream alive.
   */
  private async makeFillers(): Promise<Clip[]> {
    const fillers: Clip[] = [];
    const fallbackDir = showAssetDirs(this.show).fallback;
    if (fs.existsSync(fallbackDir)) {
      for (const f of fs.readdirSync(fallbackDir).filter((f) => f.endsWith(".mp4"))) {
        fillers.push(await this.toClip(path.join(fallbackDir, f), 0, "filler", `fallback ${f}`));
      }
    }
    if (fillers.length === 0) {
      const cardPath = path.join(this.archive.clipsDir, "filler-card.mp4");
      await renderCardClip({
        text: `${this.show.title.toUpperCase()}\n\n${this.show.character.name} is thinking.\n\nType your suggestion in chat.`,
        durationSec: 6,
        outPath: cardPath,
        video: this.config.video,
        background: "0x2d1e40",
      });
      fillers.push(await this.toClip(cardPath, 6, "filler", "thinking card"));
    }
    return fillers;
  }
}

/** Reject after `ms` with a descriptive error; the underlying promise keeps running. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
