import fs from "node:fs";
import { loadConfig } from "./config.js";
import { getShow, showAssetDirs } from "./shows.js";
import { StubGenerator } from "./generation/stubGenerator.js";
import { FalH3MaxGenerator } from "./generation/falGenerator.js";
import { envFallbackRefs } from "./components.js";

/**
 * One-off per show: generate its filler library and cached opening/closing
 * segments. Episodes pick these up automatically, so generation gaps air as
 * the character vamping on set instead of a title card, and the stream opens
 * instantly on the cached opening. Run once per show (or look change):
 *
 *   npm run fillers -- --show tilly-improv
 *   npm run fillers -- --show tilly-improv --count 2
 */
const config = loadConfig(process.argv.slice(2));
const show = getShow(config.show);
const dirs = showAssetDirs(show);
const prompts = show.format.fillerPrompts;
const count = Math.min(
  prompts.length,
  Number(process.argv.includes("--count") ? process.argv[process.argv.indexOf("--count") + 1] : prompts.length),
);

const generator = config.falKey
  ? new FalH3MaxGenerator(config.falKey, show, envFallbackRefs(config, show), config.video)
  : (console.warn("[fillers] FAL_KEY not set — generating placeholder cards"),
    new StubGenerator(config.video));

fs.mkdirSync(dirs.fallback, { recursive: true });
for (let i = 0; i < count; i++) {
  const tag = `filler-${String(i + 1).padStart(2, "0")}`;
  console.log(`[fillers] ${show.id}: generating ${tag}…`);
  const clip = await generator.generateSceneClip(prompts[i], 8, dirs.fallback, tag);
  console.log(`[fillers] wrote ${clip.mp4Path} (${clip.durationSec}s)`);
}

// Fixed opening/closing segments, reused by every episode of this show.
fs.mkdirSync(dirs.segments, { recursive: true });
for (const [tag, riff] of [
  ["opening", show.format.openingRiff],
  ["closing", show.format.closingRiff],
] as const) {
  if (!riff?.trim()) {
    console.log(`[fillers] ${show.id}: no ${tag} riff (riff-less show) — skipping`);
    continue;
  }
  if (fs.existsSync(`${dirs.segments}/${tag}-host.mp4`)) {
    console.log(`[fillers] ${show.id}: ${tag} segment already exists — skipping`);
    continue;
  }
  console.log(`[fillers] ${show.id}: generating ${tag} segment…`);
  const clip = await generator.generateHostClip(riff, dirs.segments, tag);
  console.log(`[fillers] wrote ${clip.mp4Path}`);
}
console.log(`[fillers] done — ${show.id}: ${count} filler clip(s) + segments`);
