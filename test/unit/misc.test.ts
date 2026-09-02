import { test } from "node:test";
import assert from "node:assert/strict";
import { hostClipDurationSec } from "../../src/generation/falGenerator.js";
import { RateLimiter } from "../../src/chat/rateLimiter.js";
import { withTimeout } from "../../src/episode/runner.js";
import { estimateBuildCost, slugify, uniqueId } from "../../src/showBuild.js";
import { ShowConfig } from "../../src/shows.js";

test("hostClipDurationSec scales with the line and clamps to 6–15s", () => {
  assert.equal(hostClipDurationSec("Hi."), 6);
  assert.equal(hostClipDurationSec("one two three four five six seven eight nine ten"), 7); // ceil(10/2.3)=5, +2
  const twentyFive = Array(25).fill("word").join(" ");
  assert.equal(hostClipDurationSec(twentyFive), 13);
  const fifty = Array(50).fill("word").join(" ");
  assert.equal(hostClipDurationSec(fifty), 15);
  assert.equal(hostClipDurationSec("   "), 6);
});

test("RateLimiter allows a burst then refills over time", () => {
  let t = 0;
  const rl = new RateLimiter(3, 1, () => t);
  assert.deepEqual([rl.allow(), rl.allow(), rl.allow(), rl.allow()], [true, true, true, false]);
  t = 500;
  assert.equal(rl.allow(), false, "half a token is not enough");
  t = 1000;
  assert.equal(rl.allow(), true);
  assert.equal(rl.allow(), false);
  t = 60_000;
  assert.deepEqual([rl.allow(), rl.allow(), rl.allow(), rl.allow()], [true, true, true, false], "never above the burst");
});

test("withTimeout rejects late promises and passes through fast ones", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, "x"), 7);
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "slow thing"), /slow thing timed out after 0s/);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 50, "x"), /boom/);
  assert.equal(await withTimeout(Promise.resolve(1), 0, "x"), 1, "0 disables the timeout");
});

test("slugify and uniqueId produce stable, non-colliding ids", () => {
  assert.equal(slugify("Infinite Monkeys!! (S2)"), "infinite-monkeys-s2");
  assert.equal(slugify("---"), "untitled-show");
  assert.equal(slugify("x".repeat(80)).length, 48);
  assert.equal(uniqueId("show", ["other"]), "show");
  assert.equal(uniqueId("show", ["show", "show-2"]), "show-3");
});

test("estimateBuildCost sizes voice seeds and riffs from their lines and honours the toggles", () => {
  const show: ShowConfig = {
    id: "m",
    title: "Monkeys",
    character: { name: "Host", visualAnchors: "a monkey", speaks: true, referenceImagePrompt: "p", voiceSeedLine: "Welcome to the show, friends." },
    cast: [
      { name: "Quiet", visualAnchors: "a quiet monkey", speaks: false, referenceImagePrompt: "p" },
      { name: "Uploaded", visualAnchors: "x", speaks: true, referenceImageUrls: ["https://x/u.jpg"], voiceSeedLine: Array(30).fill("w").join(" ") },
    ],
    format: {
      premise: "",
      suggestionMeaning: "",
      characterVoice: "",
      sceneInstructions: "",
      hostSet: "",
      openingRiff: "Hello there.",
      closingRiff: "Goodbye.",
      fillerPrompts: ["a", "b", "c"],
      defaultSceneSec: 12,
    },
  };
  const full = estimateBuildCost(show);
  assert.equal(full.usdStills, 0.06, "two members need stills (Uploaded has one)");
  // Host seed 6s + Uploaded seed 15s (30 words → capped) = 21s × $0.08
  assert.equal(full.usdVoices, 1.68);
  // riffs 6s + 6s + fillers 3 × 8s = 36s × $0.08
  assert.equal(full.usdClips, 2.88);
  assert.equal(full.dollars, 4.62);

  const noStills = estimateBuildCost(show, { stills: false, voices: true });
  assert.equal(noStills.usdStills, 0);
  assert.equal(noStills.usdVoices, 1.2, "without stills only the member with uploaded images gets a voice seed");

  const noVoices = estimateBuildCost(show, { stills: true, voices: false });
  assert.equal(noVoices.usdVoices, 0);
  assert.equal(noVoices.usdClips, 2.88);
});
