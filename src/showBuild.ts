import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Config } from "./config.js";
import { runFfmpeg } from "./generation/ffmpeg.js";
import { FILLER_CLIP_SEC, FalH3MaxGenerator, hostClipDurationSec } from "./generation/falGenerator.js";
import { USD_PER_SEC_FULL } from "./generation/spend.js";
import {
  CastMember,
  DATA_DIR,
  ShowConfig,
  allCast,
  loadShows,
  saveCreatedShow,
  showAssetDirs,
} from "./shows.js";

/**
 * In-app show creation, two phases:
 *
 * 1. compileShow — Claude turns the creator's free-text brief (+ optional
 *    uploaded references) into a complete ShowConfig draft. Free, instant,
 *    previewable; drafts run dry-run episodes with zero spend.
 * 2. buildShowAssets — the paid step: mint a reference still per character
 *    that lacks one, seed a reference voice for speaking characters, then
 *    generate the filler library and cached opening/closing segments.
 */

/** fal's ApiError hides the actionable message in body.detail — surface it. */
export function errText(err: unknown): string {
  const detail = (err as { body?: { detail?: unknown } })?.body?.detail;
  return String(err) + (detail ? ` — ${JSON.stringify(detail)}` : "");
}

const CompiledCastSchema = z.object({
  name: z.string().describe("short distinct name viewers can type in chat"),
  visualAnchors: z
    .string()
    .describe(
      "comma-separated identity anchors restated in every prompt this character appears in: species/age, build, look, one distinctive outfit, one distinctive accessory — distinct silhouette from every other cast member",
    ),
  speaks: z.boolean().describe("true when this character has spoken lines on the show"),
  referenceImagePrompt: z
    .string()
    .describe(
      "complete text-to-image prompt for this character's single canonical reference still: the exact features and outfit from visualAnchors, medium shot, characteristic neutral pose, clean backdrop from the show's world, and the show's visual style keywords",
    ),
  voiceSeedLine: z
    .string()
    .nullable()
    .describe("a short in-character line (at most 20 words) recorded once to mint this character's reference voice — null when speaks is false"),
});

const CompiledShowSchema = z.object({
  refusal: z
    .string()
    .nullable()
    .describe("normally null; when the brief violates the content rules, a short reason — fill the other fields minimally"),
  id: z.string().describe("lowercase-hyphen slug derived from the title, not colliding with the existing ids provided"),
  title: z.string().describe("short display title"),
  lead: CompiledCastSchema.describe("the character most scenes center on — the host when the show has one"),
  cast: z
    .array(CompiledCastSchema)
    .describe("additional recurring characters, at most 6 — empty when the lead alone carries the show"),
  premise: z.string().describe("one or two sentences: what this show is"),
  suggestionMeaning: z
    .string()
    .describe("one short sentence shown to viewers in the chat box explaining what a !prompt message does on this show, with one example"),
  interactionRules: z
    .string()
    .describe("how the director interprets !prompt messages on this show: what counts as a vote / nudge / note / scene idea, how conflicting messages resolve, what to ignore"),
  characterVoice: z
    .string()
    .describe("bullet voice guide for the lead's spoken host riffs (register, sentence length, hard never-rules) — empty string when hostRiffs is false"),
  sceneInstructions: z
    .string()
    .describe("how the director writes scene prompts: what a scene shows, its comedy/drama shape, recurring visual devices, and the show's visual style keywords to include"),
  hostSet: z.string().describe("the default set/location, described concretely for video generation"),
  hostRiffs: z.boolean().describe("false when nobody speaks to camera between scenes (the loop airs scenes only)"),
  openingRiff: z.string().describe("fixed opening line spoken to camera — empty string when hostRiffs is false"),
  closingRiff: z.string().describe("fixed sign-off spoken to camera — empty string when hostRiffs is false"),
  fillerPrompts: z
    .array(z.string())
    .describe("3 or 4 complete generation prompts (lead's visual anchors + the set + a small wordless bit of business, ending with 'No dialogue.') that air whenever generation falls behind"),
  stateInstructions: z
    .string()
    .nullable()
    .describe("what running state the director tracks between cycles (scores, story progress, who has appeared) and how it evolves — null for stateless formats"),
  persistState: z
    .boolean()
    .describe("true when the state carries across separate streams (an ongoing saga); false for self-contained episodes"),
  defaultSceneSec: z.number().describe("default scene length in seconds, 10-15 (longer keeps the stream ahead of generation)"),
});

const COMPILER_SYSTEM_PROMPT = `You design shows for a self-hosted livestream platform where AI-generated video characters perform live and viewers direct the show from chat. You turn a creator's free-text brief into a complete show config. Honor the brief's intent precisely — the creator's ideas about format, mechanics, tone, and style win over your defaults — and fill every gap with strong, specific choices.

HOW THE PLATFORM WORKS (design strictly within these constraints):
- An episode is a loop of CYCLES. Each cycle airs an optional host riff (the lead speaking to camera, at most 25 words, under ten seconds) followed by ONE generated scene clip of 5-15 seconds. The whole show is these short clips back to back — there is no other footage.
- Every clip is generated independently by a text/reference-to-video model. Character likeness holds via reference stills; exact framing, props, extras and continuity do NOT carry between clips. Design formats that thrive on short self-contained beats, not continuous action.
- Viewers interact ONLY through chat messages that start with "!prompt". The AI show director reads the batch of !prompt messages each cycle and decides what the next scene plays. Chat-to-screen latency is 60-120 seconds, so mechanics must tolerate slow feedback — nothing can depend on split-second reactions.
- The director keeps SHOW STATE between cycles when you give it stateInstructions: a compact text summary it rewrites every cycle. This is how vote tallies, leaderboards, competitions, and ongoing journeys work. Design the state to be small and self-explanatory.
- A scene may include at most one short spoken line (12 words or fewer) by one character; scenes should mostly play visually.
- At most TWO cast members appear in any one scene. Shows with many characters visit them one or two at a time (the camera "pans" by cutting between clips).

DESIGN GUIDANCE:
- lead: the character most scenes center on. If anyone hosts to camera, the lead is that host and hostRiffs is true. If nothing speaks to camera (e.g. an animal protagonist, a silent ensemble), hostRiffs is false, openingRiff/closingRiff/characterVoice are empty strings, and the show opens straight into its first scene.
- cast: give each member a distinct name, silhouette, and outfit so viewers can tell them apart at 768p. visualAnchors are restated verbatim in every prompt a character appears in — make them concrete and compact.
- referenceImagePrompt mints the character's single canonical still; nail the outfit and features there because every future clip conditions on it. Include the show's visual style keywords (e.g. "warm sitcom lighting, shallow depth of field" or a stylized look if the brief wants to dodge photorealism).
- interactionRules are the show's game rules. Be explicit: what a vote looks like ("!prompt vote Bongo"), what a nudge means for shows where viewers steer the world rather than the character, how the director should resolve conflicts and ignore spam. Remember viewers only have the one !prompt channel.
- fillerPrompts air when generation falls behind: small wordless loops of the lead on the set, in-world, no plot advancement, each ending with "No dialogue."
- suggestionMeaning is viewer-facing UI copy: one sentence, friendly, with one concrete example message.

CONTENT RULES (refuse by setting refusal to a short reason): no sexual content, no real-person likenesses or impersonation, no harassment or targeting of private people, no violence played straight, nothing designed to deceive viewers into thinking the footage is real. Comedy, absurdity, and drama are all fine.`;

export interface CompileInput {
  description: string;
  title?: string;
  /** fal storage URLs the creator uploaded for the lead character. */
  uploadedImageUrls: string[];
  uploadedAudioUrl: string | null;
}

export async function compileShow(
  anthropicKey: string,
  input: CompileInput,
): Promise<{ show: ShowConfig; refusal: null } | { show: null; refusal: string }> {
  const existingIds = [...loadShows().keys()];
  const client = new Anthropic({ apiKey: anthropicKey });
  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 8000,
    system: COMPILER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content:
          `CREATOR'S BRIEF:\n${input.description}\n\n` +
          (input.title ? `Requested title: ${input.title}\n` : "") +
          (input.uploadedImageUrls.length
            ? `The creator uploaded ${input.uploadedImageUrls.length} reference image(s) for the LEAD character — design the lead around whoever/whatever those images show as described in the brief, and do not invent a conflicting look (visualAnchors should describe the brief's character; referenceImagePrompt is unused for the lead).\n`
            : "") +
          (input.uploadedAudioUrl ? `The creator uploaded a reference voice clip for the lead.\n` : "") +
          `\nExisting show ids (the new id must not collide): ${existingIds.join(", ")}`,
      },
    ],
    output_config: { format: zodOutputFormat(CompiledShowSchema) },
  });

  const c = response.parsed_output;
  if (!c) throw new Error("show compiler response failed to parse");
  if (c.refusal) return { show: null, refusal: c.refusal };

  const toMember = (m: z.infer<typeof CompiledCastSchema>): CastMember => ({
    name: m.name,
    visualAnchors: m.visualAnchors,
    speaks: m.speaks,
    referenceImagePrompt: m.referenceImagePrompt,
    ...(m.voiceSeedLine ? { voiceSeedLine: m.voiceSeedLine } : {}),
  });

  const lead = toMember(c.lead);
  if (input.uploadedImageUrls.length) lead.referenceImageUrls = input.uploadedImageUrls;
  if (input.uploadedAudioUrl) lead.referenceAudioUrl = input.uploadedAudioUrl;

  const show: ShowConfig = {
    id: uniqueId(slugify(c.id || c.title), existingIds),
    title: c.title,
    description: input.description,
    character: lead,
    ...(c.cast.length ? { cast: c.cast.map(toMember) } : {}),
    format: {
      premise: c.premise,
      suggestionMeaning: c.suggestionMeaning,
      characterVoice: c.characterVoice,
      sceneInstructions: c.sceneInstructions,
      hostSet: c.hostSet,
      openingRiff: c.openingRiff,
      closingRiff: c.closingRiff,
      fillerPrompts: c.fillerPrompts,
      defaultSceneSec: Math.min(15, Math.max(5, Math.round(c.defaultSceneSec || 12))),
      interactionRules: c.interactionRules,
      ...(c.stateInstructions ? { stateInstructions: c.stateInstructions, persistState: c.persistState } : {}),
      hostRiffs: c.hostRiffs,
    },
    build: { status: "draft", updatedAt: new Date().toISOString() },
    origin: "created",
  };
  return { show, refusal: null };
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "untitled-show";
}

export function uniqueId(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/**
 * Consistency is optional: skipping stills/voices means every clip generates
 * that character from the prompt's visual anchors alone — looks and voices
 * vary clip to clip, which stylized shows can happily embrace, and the build
 * gets cheaper. Both default on.
 */
export interface BuildOptions {
  stills: boolean;
  voices: boolean;
}

/** Rough build spend, shown before the creator confirms the paid step. */
export function estimateBuildCost(
  show: ShowConfig,
  opts: BuildOptions = { stills: true, voices: true },
): { dollars: number; detail: string; usdStills: number; usdVoices: number; usdClips: number } {
  const members = allCast(show);
  const stills = members.filter((m) => !m.referenceImageUrls?.length && m.referenceImagePrompt).length;
  // Voice seeding needs a reference still to condition on, so skipping
  // stills also forgoes voice seeds for members without uploaded images.
  const voiceSeeds = members.filter(
    (m) =>
      m.speaks && !m.referenceAudioUrl && m.voiceSeedLine &&
      (m.referenceImageUrls?.length || opts.stills),
  );
  const voices = voiceSeeds.length;
  // Voice seeds are sized to their line exactly like host clips are.
  const voiceSec = voiceSeeds.reduce((s, m) => s + hostClipDurationSec(m.voiceSeedLine!), 0);
  const riffSec = show.format.hostRiffs === false
    ? 0
    : hostClipDurationSec(show.format.openingRiff) + hostClipDurationSec(show.format.closingRiff);
  const riffClips = show.format.hostRiffs === false ? 0 : 2; // cached opening + closing
  const fillers = show.format.fillerPrompts.length;
  const round = (n: number) => Math.round(n * 100) / 100;
  const usdStills = opts.stills ? round(stills * 0.03) : 0;
  const usdVoices = opts.voices ? round(voiceSec * USD_PER_SEC_FULL) : 0;
  const usdClips = round((riffSec + fillers * FILLER_CLIP_SEC) * USD_PER_SEC_FULL);
  const dollars = round(usdStills + usdVoices + usdClips);
  return {
    dollars,
    usdStills,
    usdVoices,
    usdClips,
    detail:
      `${opts.stills ? stills : 0} reference still(s), ${opts.voices ? voices : 0} voice seed(s), ` +
      `${riffClips} cached segment(s), ${fillers} filler clip(s) ≈ $${dollars.toFixed(2)}`,
  };
}

// ---------------------------------------------------------------------------
// Asset build — tracked so the producer UI can poll progress.

const activeBuilds = new Set<string>();

export function isBuilding(id: string): boolean {
  return activeBuilds.has(id);
}

/** Kick off the paid asset build in the background; progress lands in show.build. */
export function startBuild(
  show: ShowConfig,
  config: Config,
  opts: BuildOptions = { stills: true, voices: true },
): void {
  if (activeBuilds.has(show.id)) throw new Error(`show "${show.id}" is already building`);
  if (!config.falKey) throw new Error("FAL_KEY not configured — cannot generate assets");
  activeBuilds.add(show.id);
  void buildShowAssets(show, config, opts)
    .catch((err) => console.error(`[build] ${show.id} failed:`, err))
    .finally(() => activeBuilds.delete(show.id));
}

async function buildShowAssets(show: ShowConfig, config: Config, opts: BuildOptions): Promise<void> {
  fal.config({ credentials: config.falKey! });
  const log: string[] = [];
  const note = (line: string) => {
    console.log(`[build] ${show.id}: ${line}`);
    log.push(line);
    show.build = { status: "building", log: log.slice(-50), updatedAt: new Date().toISOString() };
    saveCreatedShow(show);
  };

  try {
    note(`build started (stills: ${opts.stills}, voices: ${opts.voices})`);

    // 1. Mint a canonical reference still per character that lacks one — a
    // single still per character keeps one consistent look; multiple takes
    // of the same prompt would each redesign the character. Skipped when the
    // creator opts for prompt-only generation (looks vary clip to clip).
    for (const member of allCast(show)) {
      if (!opts.stills) break;
      if (member.referenceImageUrls?.length || !member.referenceImagePrompt) continue;
      note(`generating reference still for ${member.name}…`);
      const result = (await fal.subscribe("fal-ai/flux/dev", {
        input: { prompt: member.referenceImagePrompt, image_size: "square_hd", num_images: 1 },
      })) as { data: { images: { url: string }[] } };
      const url = result.data.images?.[0]?.url;
      if (!url) throw new Error(`reference still for ${member.name} returned no image`);
      member.referenceImageUrls = [url];
      note(`reference still for ${member.name} ready`);
    }

    // 2. Seed a reference voice for speaking characters: one short talking
    // clip conditioned on the fresh still, audio track extracted and stored
    // as the character's voice reference so every later clip sounds the same.
    const tmpDir = path.join(DATA_DIR, "tmp", show.id);
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const member of allCast(show)) {
      if (!opts.voices) break;
      if (!member.speaks || member.referenceAudioUrl || !member.voiceSeedLine) continue;
      if (!member.referenceImageUrls?.length) continue;
      note(`seeding voice for ${member.name}…`);
      try {
        const duration = hostClipDurationSec(member.voiceSeedLine);
        const result = (await fal.subscribe("minimax/h3-max/reference-to-video", {
          input: {
            prompt:
              `The character shown in Image 1 is ${member.name}. ` +
              `${member.visualAnchors}, on ${show.format.hostSet}. ` +
              `Medium shot, static camera, speaking directly to camera at a natural pace. ` +
              `Says: "${member.voiceSeedLine.replace(/"/g, "'")}"`,
            prompt_expansion_mode: "balanced",
            duration,
            resolution: "768P",
            aspect_ratio: "16:9",
            reference_image_urls: member.referenceImageUrls,
          },
        })) as { data: { video: { url: string } } };
        const mp4 = path.join(tmpDir, `${slugify(member.name)}-voice.mp4`);
        const m4a = mp4.replace(/\.mp4$/, ".m4a");
        await downloadTo(result.data.video.url, mp4);
        await runFfmpeg(["-i", mp4, "-vn", "-c:a", "aac", "-b:a", "128k", m4a]);
        member.referenceAudioUrl = await uploadToFalStorage(m4a, "audio/mp4");
        note(`voice for ${member.name} ready`);
      } catch (err) {
        // Voice seeding is best-effort: without it the character's voice
        // varies clip to clip, which is worse but airs fine.
        note(`voice seed for ${member.name} failed (${errText(err).slice(0, 160)}) — voice will vary`);
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // 3. Filler library + cached opening/closing, exactly like `npm run
    // fillers` does for built-in shows, now that references exist.
    const generator = new FalH3MaxGenerator(config.falKey!, show, { imageUrls: [], audioUrl: null });
    const dirs = showAssetDirs(show);
    fs.mkdirSync(dirs.fallback, { recursive: true });
    for (let i = 0; i < show.format.fillerPrompts.length; i++) {
      const tag = `filler-${String(i + 1).padStart(2, "0")}`;
      if (fs.existsSync(path.join(dirs.fallback, `${tag}-scene.mp4`))) continue;
      note(`generating ${tag}…`);
      await generator.generateSceneClip(show.format.fillerPrompts[i], FILLER_CLIP_SEC, dirs.fallback, tag);
    }
    fs.mkdirSync(dirs.segments, { recursive: true });
    for (const [tag, riff] of [
      ["opening", show.format.openingRiff],
      ["closing", show.format.closingRiff],
    ] as const) {
      if (!riff.trim() || fs.existsSync(path.join(dirs.segments, `${tag}-host.mp4`))) continue;
      note(`generating cached ${tag} segment…`);
      await generator.generateHostClip(riff, dirs.segments, tag);
    }

    log.push("build complete");
    show.build = { status: "ready", log: log.slice(-50), updatedAt: new Date().toISOString() };
    saveCreatedShow(show);
    console.log(`[build] ${show.id}: ready`);
  } catch (err) {
    show.build = {
      status: "failed",
      log: log.slice(-50),
      error: errText(err).slice(0, 500),
      updatedAt: new Date().toISOString(),
    };
    saveCreatedShow(show);
    throw err;
  }
}

/** Upload a creator's file (or a build artifact) to fal storage; returns its URL. */
export async function uploadToFalStorage(filePath: string, contentType: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const file = new File([new Uint8Array(buf)], path.basename(filePath), { type: contentType });
  return fal.storage.upload(file);
}

export async function uploadBufferToFalStorage(
  falKey: string,
  buf: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  fal.config({ credentials: falKey });
  const file = new File([new Uint8Array(buf)], filename, { type: contentType });
  return fal.storage.upload(file);
}

async function downloadTo(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}
