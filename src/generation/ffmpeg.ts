import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { Config } from "../config.js";

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`)),
    );
  });
}

/**
 * Transcode any input clip to the playout format: MPEG-TS with uniform
 * codec/resolution/fps/audio, so clips can be byte-concatenated into the
 * RTMP pipe without renegotiation.
 */
/**
 * EBU R128 single-pass loudness normalisation: -16 LUFS integrated (the
 * common streaming target), -1.5 dBTP true-peak ceiling, 11 LU loudness
 * range. Single-pass is the live-safe choice: two-pass needs the whole clip
 * measured first, which we could do, but the dynamic mode is what keeps a
 * quiet ambient clip from being boosted into hiss.
 */
export const LOUDNORM_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11";

export async function normalizeToTs(inputPath: string, video: Config["video"]): Promise<string> {
  const tsPath = inputPath.replace(/\.[^.]+$/, "") + ".ts";
  // Some generated clips have no audio track; inject silence for those so the
  // TS stream always carries exactly one audio elementary stream.
  const [hasAudio, durationSec] = await Promise.all([probeHasAudio(inputPath), probeDurationSec(inputPath)]);
  // loudnorm measures over a 3s window: shorter inputs produce NaN samples
  // and the AAC encoder aborts, so such clips (and anything that trips the
  // filter for another reason) are normalised without it rather than lost.
  const loudnorm = hasAudio && durationSec >= LOUDNORM_MIN_SEC;
  try {
    await runFfmpeg(normalizeArgs(inputPath, tsPath, video, hasAudio, loudnorm));
  } catch (err) {
    if (!loudnorm) throw err;
    console.warn(`[ffmpeg] loudnorm failed for ${inputPath} — normalising without it: ${String(err).slice(0, 200)}`);
    await runFfmpeg(normalizeArgs(inputPath, tsPath, video, hasAudio, false));
  }
  return tsPath;
}

/** Clips shorter than this skip loudness normalisation (see normalizeToTs). */
export const LOUDNORM_MIN_SEC = 3;

function normalizeArgs(inputPath: string, tsPath: string, video: Config["video"], hasAudio: boolean, loudnorm: boolean): string[] {
  const args = ["-i", inputPath];
  if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  args.push(
    "-map", "0:v:0", "-map", hasAudio ? "0:a:0" : "1:a:0",
    ...(hasAudio ? [] : ["-shortest"]),
    "-vf", `scale=${video.width}:${video.height}:force_original_aspect_ratio=decrease,` +
      `pad=${video.width}:${video.height}:(ow-iw)/2:(oh-ih)/2,fps=${video.fps},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${video.vBitrateK}k`,
    "-x264-params", `keyint=${video.fps * 2}:min-keyint=${video.fps * 2}`,
    // Every clip is generated independently, so loudness varies clip to clip
    // (a host riff next to a scene with a score). Single-pass EBU R128
    // normalisation to the streaming target evens them out; injected silence
    // is left alone (nothing to normalise, and loudnorm would only add work).
    ...(loudnorm ? ["-af", LOUDNORM_FILTER] : []),
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
    "-muxdelay", "0", "-muxpreload", "0",
    "-f", "mpegts", tsPath,
  );
  return args;
}

export function probeDurationSec(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inputPath,
    ]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(Number(out.trim()) || 0));
  });
}

function probeHasAudio(inputPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error", "-select_streams", "a",
      "-show_entries", "stream=codec_type", "-of", "csv=p=0", inputPath,
    ]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(out.trim().length > 0));
  });
}

/**
 * Render a placeholder clip (title card style) — used by the stub generator
 * and as a last-resort filler when no pre-generated filler clips exist.
 */
export async function renderCardClip(opts: {
  text: string;
  durationSec: number;
  outPath: string;
  video: Config["video"];
  background?: string;
}): Promise<void> {
  const { text, durationSec, outPath, video } = opts;
  const textFile = path.join(path.dirname(outPath), path.basename(outPath) + ".txt");
  // drawtext has hostile escaping rules; a textfile sidesteps them entirely.
  fs.writeFileSync(textFile, wrapText(text, 48));
  await runFfmpeg([
    "-f", "lavfi", "-i",
    `color=c=${opts.background ?? "0x1a1a2e"}:s=${video.width}x${video.height}:r=${video.fps}:d=${durationSec}`,
    "-f", "lavfi", "-i", `anullsrc=r=44100:cl=stereo:d=${durationSec}`,
    "-vf",
    `drawtext=textfile='${textFile}':fontcolor=white:fontsize=36:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=12:` +
      `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", outPath,
  ]);
  fs.unlinkSync(textFile);
}

function wrapText(text: string, width: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}
