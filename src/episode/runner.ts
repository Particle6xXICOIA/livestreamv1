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
    let cycle = 0;

    while (Date.now() < endAt && cycle < this.config.maxCycles && !this.stopRequested) {
      cycle++;
      const suggestions = this.chat.drainSuggestions();
      this.archive.log("cycle_start", { cycle, suggestions });

      try {
        const decision = await this.director.decide({
          suggestions,
          recentCycles: recentCycles.slice(-8),
          cycleNumber: cycle,
        });
        this.archive.log("decision", {
          cycle,
          picked: decision.suggestion,
          riff: decision.hostRiff,
          scenePrompt: decision.scenePrompt,
          sceneSec: decision.sceneDurationSec,
          declined: decision.declined,
        });
        recentCycles.push(
          decision.suggestion ? decision.suggestion.text : `(invented) ${decision.scenePrompt.slice(0, 80)}`,
        );

        // Generate host + scene in parallel; enqueue in show order.
        const tag = `cycle-${String(cycle).padStart(3, "0")}`;
        const t0 = Date.now();
        const [host, scene] = await Promise.all([
          this.generator.generateHostClip(decision.hostRiff, this.archive.clipsDir, tag),
          this.generator.generateSceneClip(decision.scenePrompt, decision.sceneDurationSec, this.archive.clipsDir, tag),
        ]);
        this.archive.log("generated", { cycle, generationMs: Date.now() - t0 });

        this.playout.enqueue(await this.toClip(host.mp4Path, host.durationSec, "host", `${tag} riff`));
        this.playout.enqueue(await this.toClip(scene.mp4Path, scene.durationSec, "scene", `${tag} scene`));
      } catch (err) {
        // A failed cycle must never kill the show — fillers cover the gap.
        this.archive.log("cycle_error", { cycle, error: String(err) });
      }

      // Pacing: don't generate (and pay for) content faster than it airs.
      await this.playout.waitForQueueBelow(2);
    }

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
