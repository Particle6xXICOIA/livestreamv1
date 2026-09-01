import { spawn, ChildProcess } from "node:child_process";
import { Clip } from "../types.js";

/**
 * Continuous playout: one persistent ffmpeg process reads normalized MPEG-TS
 * from stdin (paced to realtime with -re) and pushes to HLS/RTMP, or to a
 * local file when neither is configured. Because every clip is normalized to
 * identical codec parameters, clips are remuxed straight into the pipe with a
 * running timestamp offset; pipe backpressure is what paces the producer.
 *
 * If the queue runs dry, filler clips play so the stream never freezes.
 *
 * Failure model: a remux error or the ffmpeg process dying is reported via
 * `onError`, the playout marks itself failed and stops pumping — it never
 * surfaces as an unhandled rejection (which would take the whole platform
 * process down mid-show). The runner decides how to end the episode.
 */
export class Playout {
  private proc: ChildProcess | null = null;
  private queue: Clip[] = [];
  private fillers: Clip[] = [];
  private fillerIdx = 0;
  private running = false;
  private stopping = false;
  private pumpDone: Promise<void> | null = null;
  private _error: Error | null = null;
  /** Called once if playout dies mid-show. */
  onError?: (err: Error) => void;

  constructor(
    private target: { rtmpUrl: string | null; hlsDir: string | null; localPath: string },
    private onPlay: (clip: Clip) => void,
  ) {}

  setFillers(fillers: Clip[]) {
    this.fillers = fillers;
  }

  /** Set when playout has died; the episode cannot continue airing. */
  get failed(): boolean {
    return this._error !== null;
  }

  get error(): Error | null {
    return this._error;
  }

  start(): void {
    // Target precedence: self-hosted HLS > RTMP (YouTube/Twitch) > local file.
    const primary = this.target.hlsDir
      ? [
          "-c", "copy", "-f", "hls",
          "-hls_time", "4", "-hls_list_size", "10",
          "-hls_delete_threshold", "8",
          "-hls_flags", "delete_segments+append_list",
          `${this.target.hlsDir}/live.m3u8`,
        ]
      : this.target.rtmpUrl
        ? ["-c", "copy", "-f", "flv", this.target.rtmpUrl]
        : null;
    // The aired stream also tees to localPath as a continuous MPEG-TS
    // recording (HLS segments delete themselves as the stream advances, so
    // this is the only complete copy). The runner remuxes it to episode.mp4
    // when the show ends. -c copy: no extra encode cost.
    const record = ["-c", "copy", "-f", "mpegts", this.target.localPath];
    const output = primary ? [...primary, ...record] : record;
    const proc = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-re", "-f", "mpegts", "-i", "pipe:0", "-y", ...output],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    this.proc = proc;
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-2000);
      process.stderr.write(d);
    });
    // stdin errors (EPIPE when ffmpeg dies) must have a listener or Node
    // throws them as uncaught exceptions.
    proc.stdin?.on("error", (err) => this.fail(new Error(`playout stdin: ${err.message}`)));
    proc.on("error", (err) => this.fail(new Error(`playout ffmpeg failed to start: ${err.message}`)));
    proc.on("exit", (code, signal) => {
      if (this.running && !this.stopping) {
        this.fail(new Error(`playout ffmpeg exited unexpectedly (${signal ?? code}): ${stderr.slice(-400)}`));
      }
    });
    this.running = true;
    this.pumpDone = this.pump().catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))));
  }

  private fail(err: Error): void {
    if (this._error || !this.running) return;
    this._error = err;
    this.running = false;
    this.stopping = true;
    this.proc?.stdin?.destroy();
    this.proc?.kill("SIGTERM");
    this.onError?.(err);
  }

  enqueue(clip: Clip): void {
    this.queue.push(clip);
  }

  /** Seconds of content waiting in the queue (excludes the clip currently airing). */
  get queuedSeconds(): number {
    return this.queue.reduce((s, c) => s + c.durationSec, 0);
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
    await this.waitForExit(15_000);
  }

  /** Immediate abort (hard stop / SIGINT path). The recording is left as-is. */
  async kill(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.proc?.stdin?.destroy();
    this.proc?.kill("SIGTERM");
    await this.waitForExit(5_000);
  }

  private waitForExit(graceMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const proc = this.proc;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, graceMs);
      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
