import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ShowConfig,
  buildDirectorPrompt,
  hasHostRiffs,
  hostClipPrompt,
  loadShows,
  sceneRefsForCast,
} from "../../src/shows.js";

function baseShow(over: Partial<ShowConfig> = {}): ShowConfig {
  return {
    id: "t",
    title: "Test Show",
    character: { name: "Lead", visualAnchors: "a tall lead", referenceImageUrls: ["https://x/lead.jpg"], referenceAudioUrl: "https://x/lead.mp3", speaks: true },
    format: {
      premise: "A test.",
      suggestionMeaning: "things to do",
      characterVoice: "- dry",
      sceneInstructions: "One beat.",
      hostSet: "a set",
      openingRiff: "Hello.",
      closingRiff: "Bye.",
      fillerPrompts: ["p1"],
      defaultSceneSec: 12,
    },
    ...over,
  };
}

test("built-in show configs load and the template is skipped", () => {
  const shows = loadShows();
  assert.ok(shows.has("tilly-improv"));
  assert.ok(!shows.has("my-show-id"), "_template.json must not load as a show");
  for (const s of shows.values()) {
    assert.ok(s.format.fillerPrompts.length > 0, `${s.id} has filler prompts`);
    assert.ok(s.format.defaultSceneSec >= 5 && s.format.defaultSceneSec <= 15);
  }
});

test("sceneRefsForCast returns null on single-character shows", () => {
  assert.equal(sceneRefsForCast(baseShow(), ["Lead"]), null);
});

test("sceneRefsForCast binds named cast references, falls back to the lead, caps at 4 images", () => {
  const show = baseShow({
    cast: [
      { name: "Bongo", visualAnchors: "a monkey", speaks: true, referenceImageUrls: ["https://x/b1.jpg", "https://x/b2.jpg"], referenceAudioUrl: "https://x/b.mp3" },
      { name: "Silent", visualAnchors: "a mime", speaks: false, referenceImageUrls: ["https://x/s1.jpg", "https://x/s2.jpg", "https://x/s3.jpg"] },
      { name: "Nobody", visualAnchors: "unreferenced", speaks: true },
    ],
  });

  const one = sceneRefsForCast(show, ["bongo"])!;
  assert.deepEqual(one.imageUrls, ["https://x/b1.jpg", "https://x/b2.jpg"]);
  assert.equal(one.audioUrl, "https://x/b.mp3", "a single speaking member with a voice gets the audio reference");
  assert.match(one.preamble, /Image 1 is Bongo/);
  assert.match(one.preamble, /Bongo's voice is the voice in Audio 1/);

  const two = sceneRefsForCast(show, ["Bongo", "Silent"])!;
  assert.equal(two.imageUrls.length, 4, "never more than 4 reference images");
  assert.equal(two.audioUrl, "https://x/b.mp3", "only Bongo speaks, so the audio is unambiguous");

  const twoSpeakers = sceneRefsForCast(show, ["Lead", "Bongo"])!;
  assert.equal(twoSpeakers.audioUrl, null, "two speakers with voices: no single audio reference");

  const unknown = sceneRefsForCast(show, ["Zorp"])!;
  assert.deepEqual(unknown.imageUrls, ["https://x/lead.jpg"], "unknown names fall back to the lead");

  const promptOnly = sceneRefsForCast(show, ["Nobody"])!;
  assert.deepEqual(promptOnly.imageUrls, [], "a member without references generates prompt-only");
  assert.equal(promptOnly.audioUrl, null);
});

test("buildDirectorPrompt reflects the show's mechanics", () => {
  const hosted = buildDirectorPrompt(baseShow());
  assert.match(hosted, /LEAD'S VOICE/);
  assert.match(hosted, /AT MOST 25 words/);
  assert.doesNotMatch(hosted, /CAST \(/);

  const show = baseShow({
    cast: [{ name: "Bongo", visualAnchors: "a monkey", speaks: false }],
    format: {
      ...baseShow().format,
      hostRiffs: false,
      characterVoice: "",
      interactionRules: "votes look like !prompt vote X",
      stateInstructions: "track the leaderboard",
    },
  });
  const p = buildDirectorPrompt(show);
  assert.match(p, /CAST \(recurring characters/);
  assert.match(p, /- Bongo: a monkey/);
  assert.match(p, /HOW CHAT DRIVES THIS SHOW/);
  assert.match(p, /votes look like !prompt vote X/);
  assert.match(p, /SHOW STATE/);
  assert.match(p, /hostRiff must be the empty string/);
  assert.doesNotMatch(p, /LEAD'S VOICE/);
  assert.equal(hasHostRiffs(show), false);
});

test("hostClipPrompt embeds the riff with quotes neutralised", () => {
  const p = hostClipPrompt(baseShow(), 'She said "hi" to me');
  assert.match(p, /a tall lead, on a set/);
  assert.match(p, /Says: "She said 'hi' to me"/);
});
