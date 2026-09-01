import fs from "node:fs";
import { loadConfig } from "./config.js";
import { FILLER_PROMPTS } from "./persona.js";
import { StubGenerator } from "./generation/stubGenerator.js";
import { FalH3MaxGenerator } from "./generation/falGenerator.js";

/**
 * One-off: generate the filler library into assets/fallback/. Episodes pick
 * these up automatically, so gaps in generation air as Tilly vamping on set
 * instead of a title card. Run once per look change:
 *
 *   npm run fillers            # all 5 prompts (~$5 with references)
 *   npm run fillers -- --count 2
 */
const config = loadConfig(process.argv.slice(2));
const count = Math.min(
  FILLER_PROMPTS.length,
  Number(process.argv.includes("--count") ? process.argv[process.argv.indexOf("--count") + 1] : FILLER_PROMPTS.length),
);

const generator = config.falKey
  ? new FalH3MaxGenerator(
      config.falKey,
      config.tillyReferenceImageUrls,
      config.tillyReferenceAudioUrl,
      config.video,
    )
  : (console.warn("[fillers] FAL_KEY not set — generating placeholder cards"),
    new StubGenerator(config.video));

const outDir = "assets/fallback";
fs.mkdirSync(outDir, { recursive: true });

for (let i = 0; i < count; i++) {
  const tag = `filler-${String(i + 1).padStart(2, "0")}`;
  console.log(`[fillers] generating ${tag}…`);
  const clip = await generator.generateSceneClip(FILLER_PROMPTS[i], 8, outDir, tag);
  console.log(`[fillers] wrote ${clip.mp4Path} (${clip.durationSec}s)`);
}
console.log(`[fillers] done — ${count} clip(s) in ${outDir}/`);
