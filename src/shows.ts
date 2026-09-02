import fs from "node:fs";
import path from "node:path";
import { SceneRefs } from "./types.js";

/**
 * A show is a skin over the fixed episode loop (optional host riff ->
 * chat-driven scene, repeating): character identity, premise, prompts, and
 * set are data; the loop, playout, and platform stay shared. Built-in shows
 * are JSON files in shows/ (see shows/_template.json); shows created in-app
 * live under DATA_DIR/shows/ so they survive redeploys when DATA_DIR is a
 * mounted volume.
 */
export interface CastMember {
  name: string;
  /** Identity anchors used whenever this character appears in a prompt. */
  visualAnchors: string;
  /** Whether this character speaks on the show (drives voice seeding at build time). */
  speaks?: boolean;
  /** fal storage URLs; for the lead, falls back to env-level references on built-in shows. */
  referenceImageUrls?: string[];
  referenceAudioUrl?: string;
  /** Text-to-image prompt that mints the canonical reference still when none is uploaded. */
  referenceImagePrompt?: string;
  /** Short in-character line spoken once at build time to mint the reference voice. */
  voiceSeedLine?: string;
}

/** Asset-build lifecycle for shows created in-app. */
export interface ShowBuildState {
  status: "draft" | "building" | "ready" | "failed";
  log?: string[];
  error?: string;
  updatedAt?: string;
}

export interface ShowConfig {
  id: string;
  title: string;
  /** The creator's original brief, kept verbatim (created shows only). */
  description?: string;
  /** The lead — the character most scenes center on, and the host when the show has riffs. */
  character: CastMember;
  /** Additional recurring characters beyond the lead (multi-character shows). */
  cast?: CastMember[];
  format: {
    /** One or two sentences: what this show is. */
    premise: string;
    /** What a !prompt suggestion means on this show — also shown to viewers as the chat hint. */
    suggestionMeaning: string;
    /** The lead's voice guide, verbatim bullets for the director (empty when nothing speaks). */
    characterVoice: string;
    /** How to write the scene prompt (framing, comedy shape, extras). */
    sceneInstructions: string;
    /** The host set / default location, described for generation. */
    hostSet: string;
    openingRiff: string;
    closingRiff: string;
    fillerPrompts: string[];
    defaultSceneSec: number;
    /** How the director interprets !prompt messages beyond scene ideas (votes, nudges, notes). */
    interactionRules?: string;
    /** What running state the director tracks between cycles and how to evolve it. */
    stateInstructions?: string;
    /** Persist that state across separate streams (the saga continues next episode). */
    persistState?: boolean;
    /** false = no spoken host segments between scenes (a lead who never talks to camera). */
    hostRiffs?: boolean;
  };
  build?: ShowBuildState;
  /** Set at load time from the directory the config came from — never persisted meaningfully. */
  origin?: "builtin" | "created";
}

const SHOWS_DIR = "shows";
export const DATA_DIR = process.env.DATA_DIR || "data";

export function createdShowsDir(): string {
  return path.join(DATA_DIR, "shows");
}

export function loadShows(): Map<string, ShowConfig> {
  const shows = new Map<string, ShowConfig>();
  const load = (dir: string, origin: "builtin" | "created") => {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json") || file.startsWith("_")) continue;
      const show = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as ShowConfig;
      for (const field of ["id", "title", "character", "format"] as const) {
        if (!show[field]) throw new Error(`${dir}/${file}: missing "${field}"`);
      }
      if (shows.has(show.id)) {
        console.warn(`[shows] duplicate show id "${show.id}" in ${dir}/${file} — skipping`);
        continue;
      }
      show.origin = origin;
      shows.set(show.id, show);
    }
  };
  load(SHOWS_DIR, "builtin");
  load(createdShowsDir(), "created");
  if (shows.size === 0) throw new Error(`no show configs found in ${SHOWS_DIR}/`);
  return shows;
}

export function getShow(id: string): ShowConfig {
  const shows = loadShows();
  const show = shows.get(id);
  if (!show) {
    throw new Error(`unknown show "${id}" — available: ${[...shows.keys()].join(", ")}`);
  }
  return show;
}

export function saveCreatedShow(show: ShowConfig): void {
  const dir = createdShowsDir();
  fs.mkdirSync(dir, { recursive: true });
  const { origin: _origin, ...persisted } = show;
  fs.writeFileSync(path.join(dir, `${show.id}.json`), JSON.stringify(persisted, null, 2));
}

export function deleteCreatedShow(show: ShowConfig): void {
  if (show.origin !== "created") throw new Error(`show "${show.id}" is built-in — delete its file in ${SHOWS_DIR}/ instead`);
  fs.rmSync(path.join(createdShowsDir(), `${show.id}.json`), { force: true });
  fs.rmSync(path.join(DATA_DIR, "assets", "shows", show.id), { recursive: true, force: true });
  fs.rmSync(showStatePath(show), { force: true });
}

/** Per-show asset locations (filler library, cached opening/closing). */
export function showAssetDirs(show: ShowConfig): { fallback: string; segments: string } {
  const root =
    show.origin === "created"
      ? path.join(DATA_DIR, "assets", "shows", show.id)
      : path.join("assets", "shows", show.id);
  return {
    fallback: path.join(root, "fallback"),
    segments: path.join(root, "segments"),
  };
}

/** Where a show's persistent narrative state lives (persistState shows). */
export function showStatePath(show: ShowConfig): string {
  return path.join(DATA_DIR, "state", `${show.id}.json`);
}

export function loadShowState(show: ShowConfig): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(showStatePath(show), "utf8")) as { state?: string };
    return raw.state || null;
  } catch {
    return null;
  }
}

export function saveShowState(show: ShowConfig, state: string): void {
  const file = showStatePath(show);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ state, updatedAt: new Date().toISOString() }, null, 2));
}

/** Every character on the show, lead first. */
export function allCast(show: ShowConfig): CastMember[] {
  return [show.character, ...(show.cast ?? [])];
}

/** True when this show has spoken host segments between scenes. */
export function hasHostRiffs(show: ShowConfig): boolean {
  return show.format.hostRiffs !== false;
}

/**
 * Resolve the director's cast picks to per-clip generation references.
 * Returns null on single-character shows (the generator's show-level
 * references already apply). On cast shows, unknown/empty picks fall back
 * to the lead, and members without reference images generate prompt-only
 * rather than borrowing another character's likeness.
 */
export function sceneRefsForCast(show: ShowConfig, castNames: string[]): SceneRefs | null {
  if (!show.cast?.length) return null;
  const roster = allCast(show);
  const wanted = castNames
    .map((n) => roster.find((m) => m.name.toLowerCase() === n.toLowerCase()))
    .filter((m): m is CastMember => Boolean(m));
  const members = (wanted.length ? wanted : [show.character]).slice(0, 3);

  const imageUrls: string[] = [];
  let preamble = "";
  for (const m of members) {
    for (const url of m.referenceImageUrls ?? []) {
      if (imageUrls.length >= 4) break;
      imageUrls.push(url);
      preamble += `The character shown in Image ${imageUrls.length} is ${m.name}. `;
    }
  }
  const speakers = members.filter((m) => m.speaks && m.referenceAudioUrl);
  const audioUrl = speakers.length === 1 ? speakers[0].referenceAudioUrl! : null;
  if (audioUrl) preamble += `${speakers[0].name}'s voice is the voice in Audio 1. `;
  return { preamble, imageUrls, audioUrl };
}

export function buildDirectorPrompt(show: ShowConfig): string {
  const c = show.character;
  const f = show.format;
  const riffs = hasHostRiffs(show);

  let prompt = `You are the show director for "${show.title}", a livestream starring ${c.name}. ${f.premise} Viewers in chat send !prompt messages (${f.suggestionMeaning}); each cycle you read them and write the video-generation prompt for the next scene${riffs ? `, plus ${c.name}'s host riff introducing it` : ""}.`;

  if (riffs && f.characterVoice) {
    prompt += `\n\n${c.name.toUpperCase()}'S VOICE (the host riff is spoken dialogue — get this right):\n${f.characterVoice}`;
  }

  if (show.cast?.length) {
    prompt += `\n\nCAST (recurring characters — refer to them by name in castNames, and always restate their visual anchors in the scene prompt):\n- ${c.name} (lead): ${c.visualAnchors}\n${show.cast.map((m) => `- ${m.name}: ${m.visualAnchors}`).join("\n")}\nEach scene features at most TWO cast members (clips are short; more gets muddy). Set castNames to exactly the members appearing in the scene.`;
  }

  if (f.interactionRules) {
    prompt += `\n\nHOW CHAT DRIVES THIS SHOW (interpret every !prompt message by these rules):\n${f.interactionRules}`;
  }

  if (f.stateInstructions) {
    prompt += `\n\nSHOW STATE (you are the show's memory):\n${f.stateInstructions}\nEach cycle you receive the current state and MUST return the complete rewritten state in updatedState — a compact plain-text summary under 150 words that a fresh director could pick up from. Initialize it on the first cycle. Never drop information a future cycle needs.`;
  }

  prompt += `\n\nYOUR JOB EACH CYCLE:
1. Read the chat messages. Decline anything unsafe (sexual content, real-people impersonation, harassment, violence played straight, anything targeting a private person) — record declines with a short reason.${riffs ? ` If a declined suggestion was clearly popular, ${c.name} may deflect it in character in the riff, lightly, without repeating the offending content.` : ""}
2. ${f.interactionRules ? "Apply the interaction rules above to every message, then choose what the next scene plays" : "Pick the most PLAYABLE suggestion: concrete, visual, fresh relative to recent cycles"}. If chat is empty or nothing is usable, advance the show yourself in its spirit (set pickedSuggestionId to null).
3. ${riffs ? `Write hostRiff: ${c.name} reacting to chat and setting up the scene. 1-2 sentences of pure spoken dialogue, AT MOST 25 words total — it must be comfortably speakable in under ten seconds. No emoji, no stage directions.` : `hostRiff must be the empty string — this show has NO host segments; every cycle airs the scene only.`}
4. Write scenePrompt: a complete text-to-video prompt for the scene. Always begin with the visual anchors of every character in the scene${show.cast?.length ? "" : ` ("${c.visualAnchors}")`}. ${f.sceneInstructions} Include camera framing (e.g. "medium shot", "static camera"). Each clip stands alone — never rely on the previous clip's exact framing carrying over. Spoken lines in the scene are written as: NAME says: "..." — at most one short line of 12 words or fewer; scenes should mostly play visually.
5. Choose sceneDurationSec between 5 and 15. Default ${f.defaultSceneSec} — longer clips keep the stream ahead of generation; go shorter only for a genuinely quick beat.

Keep every cycle fresh: vary settings, wardrobe details, and comic shapes relative to the recent-cycles list you are given.`;

  return prompt;
}

/** Prompt for host-mode clips: the lead on their set, speaking to camera. */
export function hostClipPrompt(show: ShowConfig, riff: string): string {
  return (
    `${show.character.visualAnchors}, on ${show.format.hostSet}. ` +
    `[Static shot] Medium shot, static camera, talking directly to camera, natural and animated. ` +
    `Says: "${riff.replace(/"/g, "'")}"`
  );
}
