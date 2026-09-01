import fs from "node:fs";
import path from "node:path";

/**
 * A show is a skin over the fixed episode loop (host riff -> chat-driven
 * scene, repeating): character identity, premise, prompts, and set are data;
 * the loop, playout, and platform stay shared. Add an experience by dropping
 * a JSON file into shows/ (see shows/_template.json).
 */
export interface ShowConfig {
  id: string;
  title: string;
  character: {
    name: string;
    /** Identity anchors prefixed to every generation prompt. */
    visualAnchors: string;
    /** fal storage URLs; falls back to the env-level references when absent. */
    referenceImageUrls?: string[];
    referenceAudioUrl?: string;
  };
  format: {
    /** One or two sentences: what this show is. */
    premise: string;
    /** What a !prompt suggestion means on this show. */
    suggestionMeaning: string;
    /** The character's voice guide, verbatim bullets for the director. */
    characterVoice: string;
    /** How to write the scene prompt (framing, comedy shape, extras). */
    sceneInstructions: string;
    /** The host set, described for generation. */
    hostSet: string;
    openingRiff: string;
    closingRiff: string;
    fillerPrompts: string[];
    defaultSceneSec: number;
  };
}

const SHOWS_DIR = "shows";

export function loadShows(): Map<string, ShowConfig> {
  const shows = new Map<string, ShowConfig>();
  for (const file of fs.readdirSync(SHOWS_DIR)) {
    if (!file.endsWith(".json") || file.startsWith("_")) continue;
    const show = JSON.parse(fs.readFileSync(path.join(SHOWS_DIR, file), "utf8")) as ShowConfig;
    for (const field of ["id", "title", "character", "format"] as const) {
      if (!show[field]) throw new Error(`shows/${file}: missing "${field}"`);
    }
    shows.set(show.id, show);
  }
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

/** Per-show asset locations (filler library, cached opening/closing). */
export function showAssetDirs(show: ShowConfig): { fallback: string; segments: string } {
  return {
    fallback: path.join("assets", "shows", show.id, "fallback"),
    segments: path.join("assets", "shows", show.id, "segments"),
  };
}

export function buildDirectorPrompt(show: ShowConfig): string {
  const c = show.character;
  const f = show.format;
  return `You are the show director for "${show.title}", a livestream starring ${c.name}. ${f.premise} Viewers in chat send suggestions (${f.suggestionMeaning}); each cycle you pick one, write ${c.name}'s host riff, and write the video-generation prompt for the scene.

${c.name.toUpperCase()}'S VOICE (the host riff is spoken dialogue — get this right):
${f.characterVoice}

YOUR JOB EACH CYCLE:
1. Read the chat suggestions. Decline anything unsafe (sexual content, real-people impersonation, harassment, violence played straight, anything targeting a private person) — record declines with a short reason. If a declined suggestion was clearly popular, ${c.name} may deflect it in character in the riff, lightly, without repeating the offending content.
2. Pick the most PLAYABLE suggestion: concrete, visual, fresh relative to recent cycles. If chat is empty or nothing is playable, invent one in the spirit of the show (set suggestion to null).
3. Write hostRiff: ${c.name} acknowledging the viewer by username and setting up the scene. 1-3 sentences of pure spoken dialogue — no emoji, no stage directions.
4. Write scenePrompt: a complete text-to-video prompt for the scene. Always begin with the character anchors: "${c.visualAnchors}". ${f.sceneInstructions} Include camera framing (e.g. "medium shot", "static camera"). Spoken lines in the scene are written as: she says: "..." (or he/they as fits).
5. Choose sceneDurationSec between 5 and 15. Default ${f.defaultSceneSec} — longer clips keep the stream ahead of generation; go shorter only for a genuinely quick beat.

Keep every cycle fresh: vary settings, wardrobe details, and comic shapes relative to the recent-cycles list you are given.`;
}

/** Prompt for host-mode clips: the character on their set, speaking to camera. */
export function hostClipPrompt(show: ShowConfig, riff: string): string {
  return (
    `${show.character.visualAnchors}, on ${show.format.hostSet}. ` +
    `Medium shot, static camera, talking directly to camera, natural and animated. ` +
    `Says: "${riff.replace(/"/g, "'")}"`
  );
}
