import fs from "node:fs";
import path from "node:path";
import { probeDurationSec, runFfmpeg } from "../generation/ffmpeg.js";

/**
 * Per-episode record: everything needed to review the show afterwards —
 * suggestions, decisions, prompts, clip paths, timings — as JSONL events.
 * This is the artifact the Tilly iteration workflow reviews.
 */
export class EpisodeArchive {
  readonly dir: string;
  private logPath: string;

  constructor(outDir: string) {
    const id = new Date().toISOString().replace(/[:.]/g, "-");
    this.dir = path.join(outDir, "episodes", id);
    fs.mkdirSync(path.join(this.dir, "clips"), { recursive: true });
    this.logPath = path.join(this.dir, "log.jsonl");
  }

  get clipsDir(): string {
    return path.join(this.dir, "clips");
  }

  log(type: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ t: new Date().toISOString(), type, ...data });
    fs.appendFileSync(this.logPath, line + "\n");
    console.log(`[${type}]`, summarize(data));
  }
}

function summarize(data: Record<string, unknown>): string {
  const s = JSON.stringify(data);
  return s.length > 220 ? s.slice(0, 220) + "…" : s;
}

/** Total size of a directory tree in bytes. */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(p) : fs.statSync(p).size;
  }
  return total;
}

/**
 * Keep the episode archive under its size cap: delete oldest episodes
 * (dir names are ISO timestamps, so lexical order is chronological) until
 * the total fits, never touching `keepDir`. Returns the ids deleted.
 */
export function pruneEpisodes(root: string, maxBytes: number, keepDir: string | null): string[] {
  const episodesDir = path.join(root, "episodes");
  if (!fs.existsSync(episodesDir)) return [];
  const dirs = fs
    .readdirSync(episodesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const sizes = new Map(dirs.map((d) => [d, dirSizeBytes(path.join(episodesDir, d))]));
  let total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const deleted: string[] = [];
  for (const d of dirs) {
    if (total <= maxBytes) break;
    if (keepDir && path.join(episodesDir, d) === keepDir) continue;
    fs.rmSync(path.join(episodesDir, d), { recursive: true, force: true });
    total -= sizes.get(d) ?? 0;
    deleted.push(d);
  }
  return deleted;
}

/** Free bytes on the filesystem holding `dir` (nearest existing ancestor). */
export function freeBytes(dir: string): number {
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const st = fs.statfsSync(probe);
  return Number(st.bavail) * Number(st.bsize);
}

/**
 * Turn an episode's continuous stream.ts recording into a seekable
 * episode.mp4 (-c copy remux; aac_adtstoasc converts the TS's ADTS audio
 * framing to what the mp4 container requires), then drop the .ts. Returns
 * null when there is nothing to finalize.
 */
export async function finalizeRecording(
  episodeDir: string,
): Promise<{ path: string; durationSec: number; sizeMB: number } | null> {
  const streamTs = path.join(episodeDir, "stream.ts");
  const episodeMp4 = path.join(episodeDir, "episode.mp4");
  if (!fs.existsSync(streamTs) || fs.statSync(streamTs).size === 0) {
    fs.rmSync(streamTs, { force: true });
    return null;
  }
  await runFfmpeg(["-i", streamTs, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", episodeMp4]);
  const durationSec = await probeDurationSec(episodeMp4);
  fs.rmSync(streamTs, { force: true });
  return { path: episodeMp4, durationSec, sizeMB: Math.round(fs.statSync(episodeMp4).size / 1e6) };
}

/**
 * A process restart mid-episode leaves a stream.ts that never became an
 * episode.mp4. Called at server boot: finalize any such orphan so the
 * recording is still watchable. Returns the episode ids recovered.
 */
export async function recoverOrphanRecordings(root: string): Promise<string[]> {
  const episodesDir = path.join(root, "episodes");
  if (!fs.existsSync(episodesDir)) return [];
  const recovered: string[] = [];
  for (const id of fs.readdirSync(episodesDir).sort()) {
    const dir = path.join(episodesDir, id);
    if (!fs.existsSync(path.join(dir, "stream.ts"))) continue;
    try {
      const result = await finalizeRecording(dir);
      if (result) {
        fs.appendFileSync(
          path.join(dir, "log.jsonl"),
          JSON.stringify({ t: new Date().toISOString(), type: "recording_saved", ...result, recovered: true }) + "\n",
        );
        recovered.push(id);
      }
    } catch (err) {
      console.warn(`[archive] could not recover recording in ${dir}: ${String(err)}`);
    }
  }
  return recovered;
}
