import { spawn, ChildProcess } from "node:child_process";
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
    private target: { rtmpUrl: string | null; hlsDir: string | null; localPath: string },
    private onPlay: (clip: Clip) => void,
  ) {}

  setFillers(fillers: Clip[]) {
    this.fillers = fillers;
  }

  start(): void {
    // Target precedence: self-hosted HLS > RTMP (YouTube/Twitch) > local file.
    const output = this.target.hlsDir
      ? [
          "-c", "copy", "-f", "hls",
          "-hls_time", "4", "-hls_list_size", "10",
          "-hls_delete_threshold", "8",
          "-hls_flags", "delete_segments+append_list",
          `${this.target.hlsDir}/live.m3u8`,
        ]
      : this.target.rtmpUrl
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
        await this.writeClip(clip);
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

  /** Running timestamp offset so the concatenated stream is monotonic. */
  private tsOffsetSec = 0;

  /**
   * Every normalized clip's timestamps start near zero, so raw byte
   * concatenation produces a timestamp reset at every clip boundary —
   * "Non-monotonic DTS" in the muxer and stutters/stalls in players.
   * Each clip is therefore remuxed on the way in (-c copy, cheap) with a
   * running -output_ts_offset, making the combined stream continuous.
   */
  private writeClip(clip: Clip): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (!stdin || stdin.destroyed) return reject(new Error("playout stdin closed"));
      const remux = spawn(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error",
          "-i", clip.tsPath,
          "-c", "copy", "-muxdelay", "0", "-muxpreload", "0",
          "-output_ts_offset", this.tsOffsetSec.toFixed(3),
          "-f", "mpegts", "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      remux.stderr.on("data", (d) => (stderr += d.toString()));
      const onStdinError = (err: Error) => {
        remux.kill("SIGKILL");
        reject(err);
      };
      stdin.once("error", onStdinError);
      remux.stdout.pipe(stdin, { end: false });
      remux.on("error", (err) => {
        stdin.off("error", onStdinError);
        reject(err);
      });
      remux.on("close", (code) => {
        stdin.off("error", onStdinError);
        if (code === 0) {
          this.tsOffsetSec += clip.durationSec;
          resolve();
        } else {
          reject(new Error(`clip remux exited ${code}: ${stderr.slice(-400)}`));
        }
      });
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
