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
