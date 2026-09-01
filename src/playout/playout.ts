import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Clip } from "../types.js";

/**
 * Continuous playout: one persistent ffmpeg process reads normalized MPEG-TS
 * from stdin (paced to realtime with -re) and pushes to RTMP, or to a local
 * file when no RTMP URL is configured. Because every clip is normalized to
 * identical codec parameters, clips are byte-concatenated straight into the
 * pipe; pipe backpressure is what paces the producer loop.
 *
 * If the queue runs dry, filler clips play so the stream never freezes.
 */
export class Playout {
  private proc: ChildProcess | null = null;
  private queue: Clip[] = [];
  private fillers: Clip[] = [];
  private fillerIdx = 0;
  private running = false;
  private stopping = false;
  private pumpDone: Promise<void> | null = null;

  constructor(
    private target: { rtmpUrl: string | null; localPath: string },
    private onPlay: (clip: Clip) => void,
  ) {}

  setFillers(fillers: Clip[]) {
    this.fillers = fillers;
  }

  start(): void {
    const output = this.target.rtmpUrl
      ? ["-c", "copy", "-f", "flv", this.target.rtmpUrl]
      : ["-c", "copy", "-f", "mpegts", this.target.localPath];
    this.proc = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-re", "-f", "mpegts", "-i", "pipe:0", "-y", ...output],
      { stdio: ["pipe", "ignore", "inherit"] },
    );
    this.running = true;
    this.pumpDone = this.pump();
  }

  enqueue(clip: Clip): void {
    this.queue.push(clip);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** Seconds of content waiting in the queue (excludes the clip currently airing). */
  get queuedSeconds(): number {
    return this.queue.reduce((s, c) => s + c.durationSec, 0);
  }

  /** Producer pacing: resolves once the queue is at or below `n` clips. */
  async waitForQueueBelow(n: number): Promise<void> {
    while (this.running && this.queue.length > n) {
      await sleep(500);
    }
  }

  private async pump(): Promise<void> {
    while (this.running) {
      let clip = this.queue.shift();
      if (!clip) {
        if (this.stopping) break; // drained — finish up
        clip = this.nextFiller();
        if (!clip) {
          await sleep(250);
          continue;
        }
      }
      this.onPlay(clip);
      try {
        await this.writeClip(clip.tsPath);
      } catch (err) {
        if (this.running) throw err;
        break; // stream closed during shutdown
      }
    }
    this.proc?.stdin?.end();
  }

  private nextFiller(): Clip | undefined {
    if (this.fillers.length === 0) return undefined;
    const clip = this.fillers[this.fillerIdx % this.fillers.length];
    this.fillerIdx++;
    return clip;
  }

  private writeClip(tsPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (!stdin || stdin.destroyed) return reject(new Error("playout stdin closed"));
      const rs = fs.createReadStream(tsPath);
      const onStdinError = (err: Error) => {
        rs.destroy();
        reject(err);
      };
      const done = (err?: Error) => {
        stdin.off("error", onStdinError);
        err ? reject(err) : resolve();
      };
      stdin.once("error", onStdinError);
      rs.pipe(stdin, { end: false });
      rs.on("end", () => done());
      rs.on("error", (err) => done(err));
    });
  }

  /** Play out everything still queued, then close the stream cleanly. */
  async drainAndStop(): Promise<void> {
    this.stopping = true;
    await this.pumpDone;
    this.running = false;
    await new Promise<void>((resolve) => {
      if (!this.proc || this.proc.exitCode !== null) return resolve();
      this.proc.on("close", () => resolve());
    });
  }

  /** Immediate abort (SIGINT path). */
  async kill(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.proc?.stdin?.destroy();
    this.proc?.kill("SIGTERM");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
