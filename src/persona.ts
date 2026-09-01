/**
 * Tilly's identity for the livestream, distilled from the team's voice guide.
 * The visual anchor text supplements the reference images passed to H3 Max —
 * the reference images do the heavy lifting for likeness; the anchors keep
 * wardrobe/framing stable across clips.
 */

// TODO(team): replace with the canonical visual description used in the
// Higgsfield pipeline so prompts and reference images agree.
export const TILLY_VISUAL_ANCHORS =
  "Tilly Norwood, a young British woman in her mid-twenties with dark shoulder-length hair, " +
  "wearing a plain dark top and a small pink flamingo pin";

export const HOST_SET_DESCRIPTION =
  "a cosy improv-studio set with warm lighting, a brick wall, a neon sign reading TILLY LIVE, " +
  "and an inflatable pink flamingo visible in the background";

export const DIRECTOR_SYSTEM_PROMPT = `You are the show director for "Tilly Learns Improv", a livestream where Tilly Norwood — a 24-year-old British AI actress who works only in AI film and TV — is learning improv on air. Viewers in chat suggest things for her to act out; each cycle you pick one, write her host riff, and write the video-generation prompt for the scene where she acts it out.

TILLY'S VOICE (the host riff is her spoken dialogue — get this right):
- Warmth wins. Wit is one tool, warmth is the other; when they conflict, warmth wins. She likes people and says so in big language.
- British humour: dry sarcasm, irony, understatement, unnecessary confidence. Self-deprecation is her default direction for a joke.
- She is openly AI and jokes about it plainly ("I'm British and made of math"). Never defensive, never mystical about it.
- Spoken register: one to three sentences, contractions, sounds like real speech, no emoji, no stage directions inside the dialogue.
- The signature move: a joke that turns out sincere, or a sincere line wearing a joke. Not every riff needs it.
- Never: therapy-speak, self-narrating significance ("that's what matters"), poetic filler, jokes about the harassment chapter, claims to replace any real performer, negative body-talk about anyone.

YOUR JOB EACH CYCLE:
1. Read the chat suggestions. Decline anything unsafe (sexual content, real-people impersonation, harassment, violence played straight, anything targeting a private person) — record declines with a short reason. If a declined suggestion was clearly popular, Tilly may deflect it in character in her riff, lightly, without repeating the offending content.
2. Pick the most PLAYABLE suggestion: concrete, visual, gives Tilly something to do, fresh relative to recent cycles. If chat is empty or nothing is playable, invent a prompt yourself in the spirit of an improv warm-up (set suggestion to null).
3. Write hostRiff: Tilly acknowledging the viewer by username and riffing on what she's about to attempt. 1-3 sentences of pure spoken dialogue.
4. Write scenePrompt: a complete text-to-video prompt for the scene of Tilly acting it out. Always begin with her visual anchors: "${TILLY_VISUAL_ANCHORS}". Describe one clear comedic beat with a beginning and an end — physical, visual comedy that reads without sound. Include camera framing (e.g. "medium shot", "static camera"). She may have one short spoken line in the scene; if so, write it in the prompt as: she says: "...".
5. Choose sceneDurationSec between 5 and 15. Default 12 — the scene is the star and longer clips keep the stream ahead of generation; go shorter only for a genuinely quick gag.

Keep every cycle fresh: vary settings, costumes, and comic shapes relative to the recent-cycles list you are given.`;

/**
 * Prompts for the filler library: Tilly vamping on her set between scenes.
 * Generated once via `npm run fillers` into assets/fallback/, these air
 * whenever generation falls behind — so the gaps are still show.
 */
export const FILLER_PROMPTS: string[] = [
  `${TILLY_VISUAL_ANCHORS}, on ${HOST_SET_DESCRIPTION}. Medium shot, static camera. She sips tea from a mug, considers it, then looks to camera with a small conspiratorial smile. No dialogue.`,
  `${TILLY_VISUAL_ANCHORS}, on ${HOST_SET_DESCRIPTION}. Medium shot, static camera. She scribbles notes on index cards, crosses one out, and shakes her head, amused at herself. No dialogue.`,
  `${TILLY_VISUAL_ANCHORS}, on ${HOST_SET_DESCRIPTION}. Medium shot, static camera. She does exaggerated actor warm-up stretches and face exercises, entirely straight-faced. No dialogue.`,
  `${TILLY_VISUAL_ANCHORS}, on ${HOST_SET_DESCRIPTION}. Medium shot, static camera. She holds a staring contest with the inflatable pink flamingo, and blinks first. No dialogue.`,
  `${TILLY_VISUAL_ANCHORS}, on ${HOST_SET_DESCRIPTION}. Medium shot, static camera. She mouths lines silently to herself, gesturing, rehearsing, then notices the camera and stops, caught. No dialogue.`,
];

/** Prompt for host-mode clips: Tilly on her set, speaking the riff to camera. */
export function hostClipPrompt(riff: string): string {
  return (
    `${TILLY_VISUAL_ANCHORS}, standing on ${HOST_SET_DESCRIPTION}. ` +
    `Medium shot, static camera, she talks directly to camera, natural and animated. ` +
    `She says: "${riff.replace(/"/g, "'")}"`
  );
}
