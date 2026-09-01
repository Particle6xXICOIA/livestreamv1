import path from "node:path";
import fs from "node:fs";
import { ChatSource, Clip, ClipGenerator, Director } from "../types.js";
import { Config } from "../config.js";
import { Playout } from "../playout/playout.js";
import { EpisodeArchive } from "./archive.js";
import { normalizeToTs, renderCardClip } from "../generation/ffmpeg.js";

const OPENING_RIFF =
  "Hello, you've reached Tilly Learns Improv, where I attempt acting suggestions from strangers " +
  "with no rehearsal and, being made of math, no excuse. Type an idea in chat and I'll have a go.";

const CLOSING_RIFF =
  "That's the whole show. I'd say I'll do better next time, but honestly some of that felt dangerously " +
  "close to competent. Same time soon. Tilly out.";

export class EpisodeRunner {
  private playout: Playout;
  private archive: EpisodeArchive;
  private stopRequested = false;

  constructor(
    private config: Config,
    private chat: ChatSource,
    private director: Director,
    private generator: ClipGenerator,
  ) {
    this.archive = new EpisodeArchive(config.outDir);
    this.playout = new Playout(
      { rtmpUrl: config.rtmpUrl, localPath: path.join(this.archive.dir, "stream.ts") },
      (clip) => this.archive.log("playing", { kind: clip.kind, label: clip.label, sec: clip.durationSec }),
    );
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  async run(): Promise<void> {
    const { config } = this;
    this.archive.log("episode_start", {
      dryRun: config.dryRun,
      minutes: config.episodeMinutes,
      rtmp: config.rtmpUrl ? "configured" : "local file",
    });

    this.playout.setFillers(await this.makeFillers());
    this.playout.start();
    await this.chat.start();

    // Opening segment plays while the first cycle generates.
    await this.enqueueGenerated("opening", () =>
      this.generator.generateHostClip(OPENING_RIFF, this.archive.clipsDir, "opening"),
    );

    const endAt = Date.now() + config.episodeMinutes * 60_000;
    const recentCycles: string[] = [];

    // Pipelined generation: up to maxConcurrentCycles cycles generate at once,
    // and generation runs ahead of playout until bufferTargetSec of content is
    // queued. Clips still air strictly in cycle order — finished cycles wait in
    // `completed` until every earlier cycle has been released to the queue.
    const inFlight = new Map<number, Promise<void>>();
    const completed = new Map<number, Clip[]>();
    let nextToAir = 1;
    let cycle = 0;

    const releaseReady = () => {
      while (completed.has(nextToAir)) {
        for (const clip of completed.get(nextToAir)!) this.playout.enqueue(clip);
        completed.delete(nextToAir);
        nextToAir++;
      }
    };
    const bufferedSec = () =>
      this.playout.queuedSeconds +
      [...completed.values()].flat().reduce((s, c) => s + c.durationSec, 0);

    while (Date.now() < endAt && cycle < config.maxCycles && !this.stopRequested) {
      if (inFlight.size >= config.maxConcurrentCycles || bufferedSec() >= config.bufferTargetSec) {
        await sleep(1000);
        continue;
      }

      cycle++;
      const thisCycle = cycle;
      const suggestions = this.chat.drainSuggestions();
      this.archive.log("cycle_start", { cycle: thisCycle, suggestions });

      // Decide before spawning generation so recentCycles stays coherent
      // across overlapping cycles.
      let decision;
      try {
        decision = await this.director.decide({
          suggestions,
          recentCycles: recentCycles.slice(-8),
          cycleNumber: thisCycle,
        });
      } catch (err) {
        this.archive.log("cycle_error", { cycle: thisCycle, error: String(err) });
        completed.set(thisCycle, []);
        releaseReady();
        continue;
      }
      this.archive.log("decision", {
        cycle: thisCycle,
        picked: decision.suggestion,
        riff: decision.hostRiff,
        scenePrompt: decision.scenePrompt,
        sceneSec: decision.sceneDurationSec,
        declined: decision.declined,
      });
      recentCycles.push(
        decision.suggestion ? decision.suggestion.text : `(invented) ${decision.scenePrompt.slice(0, 80)}`,
      );

      const task = (async () => {
        const tag = `cycle-${String(thisCycle).padStart(3, "0")}`;
        try {
          const t0 = Date.now();
          const [host, scene] = await Promise.all([
            this.generator.generateHostClip(decision.hostRiff, this.archive.clipsDir, tag),
            this.generator.generateSceneClip(decision.scenePrompt, decision.sceneDurationSec, this.archive.clipsDir, tag),
          ]);
          const clips = [
            await this.toClip(host.mp4Path, host.durationSec, "host", `${tag} riff`),
            await this.toClip(scene.mp4Path, scene.durationSec, "scene", `${tag} scene`),
          ];
          this.archive.log("generated", { cycle: thisCycle, generationMs: Date.now() - t0 });
          completed.set(thisCycle, clips);
        } catch (err) {
          // A failed cycle must never kill the show or stall the air order —
          // it releases as zero clips and fillers cover the gap.
          this.archive.log("cycle_error", { cycle: thisCycle, error: String(err) });
          completed.set(thisCycle, []);
        } finally {
          inFlight.delete(thisCycle);
          releaseReady();
        }
      })();
      inFlight.set(thisCycle, task);
    }

    // Let in-flight cycles finish and air before the closing segment.
    await Promise.allSettled([...inFlight.values()]);
    releaseReady();

    await this.enqueueGenerated("closing", () =>
      this.generator.generateHostClip(CLOSING_RIFF, this.archive.clipsDir, "closing"),
    );

    await this.chat.stop();
    await this.playout.drainAndStop();
    this.archive.log("episode_end", { cycles: cycle });
    console.log(`\nEpisode archive: ${this.archive.dir}`);
  }

  async abort(): Promise<void> {
    await this.chat.stop().catch(() => {});
    await this.playout.kill();
  }

  private async enqueueGenerated(
    kind: "opening" | "closing",
    gen: () => Promise<{ mp4Path: string; durationSec: number }>,
  ): Promise<void> {
    try {
      const raw = await gen();
      this.playout.enqueue(await this.toClip(raw.mp4Path, raw.durationSec, kind, kind));
    } catch (err) {
      this.archive.log("segment_error", { kind, error: String(err) });
    }
  }

  private async toClip(mp4Path: string, durationSec: number, kind: Clip["kind"], label: string): Promise<Clip> {
    return { tsPath: await normalizeToTs(mp4Path, this.config.video), durationSec, kind, label };
  }

  /**
   * Filler clips that air whenever the queue runs dry. Pre-generated H3 Max
   * clips dropped in assets/fallback/ are used when present; otherwise a
   * rendered card keeps the stream alive.
   */
  private async makeFillers(): Promise<Clip[]> {
    const fillers: Clip[] = [];
    const fallbackDir = "assets/fallback";
    if (fs.existsSync(fallbackDir)) {
      for (const f of fs.readdirSync(fallbackDir).filter((f) => f.endsWith(".mp4"))) {
        fillers.push(await this.toClip(path.join(fallbackDir, f), 0, "filler", `fallback ${f}`));
      }
    }
    if (fillers.length === 0) {
      const cardPath = path.join(this.archive.clipsDir, "filler-card.mp4");
      await renderCardClip({
        text: "TILLY LEARNS IMPROV\n\nTilly is thinking. This takes longer when you're made of math.\n\nType your suggestion in chat.",
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
