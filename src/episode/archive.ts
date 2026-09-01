import fs from "node:fs";
import path from "node:path";

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
export function pruneEpisodes(root: string, maxBytes: number, keepDir: string): string[] {
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
    if (path.join(episodesDir, d) === keepDir) continue;
    fs.rmSync(path.join(episodesDir, d), { recursive: true, force: true });
    total -= sizes.get(d) ?? 0;
    deleted.push(d);
  }
  return deleted;
}
