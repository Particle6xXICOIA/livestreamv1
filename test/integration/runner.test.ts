/**
 * Runner integration tests: the real EpisodeRunner + real Playout (ffmpeg,
 * local file output) with fake chat/director/generator so a whole episode
 * runs in a few seconds and costs nothing. Skipped when ffmpeg is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, Config } from "../../src/config.js";
import { EpisodeRunner } from "../../src/episode/runner.js";
import { renderCardClip } from "../../src/generation/ffmpeg.js";
import { SpendMeter } from "../../src/generation/spend.js";
import { getShow } from "../../src/shows.js";
import { ChatSource, ClipGenerator, CycleDecision, Director, RawClip, Suggestion } from "../../src/types.js";
import { Screener } from "../../src/director/screener.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const show = getShow("tilly-improv");

function testConfig(outDir: string, over: Partial<Config> = {}): Config {
  const c = loadConfig(["--dry-run", "--minutes", "0.25", "--out", outDir]);
  return {
    ...c,
    // Tiny clips and a tiny buffer so an episode is over in seconds.
    bufferTargetSec: 4,
    maxConcurrentCycles: 2,
    generationTimeoutSec: 3,
    directorTimeoutSec: 3,
    minFreeGB: 0,
    archiveMaxGB: 100,
    video: { width: 320, height: 180, fps: 15, vBitrateK: 300 },
    ...over,
  };
}

class FakeChat implements ChatSource {
  queue: Suggestion[] = [];
  async start() {}
  async stop() {}
  drainSuggestions() {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}

class FakeDirector implements Director {
  calls: { cycleNumber: number; suggestions: Suggestion[] }[] = [];
  /** Cycle numbers whose decide() call should throw. */
  failOn = new Set<number>();
  async decide(input: { suggestions: Suggestion[]; recentCycles: string[]; cycleNumber: number; showState: string | null }): Promise<CycleDecision> {
    this.calls.push({ cycleNumber: input.cycleNumber, suggestions: input.suggestions });
    if (this.failOn.has(input.cycleNumber)) throw new Error("director down");
    return {
      suggestion: input.suggestions[0] ?? null,
      hostRiff: "",
      scenePrompt: `scene ${input.cycleNumber}`,
      sceneDurationSec: 5,
      castNames: [],
      updatedState: null,
      declined: [],
      usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 800, cacheWriteTokens: 0 },
    };
  }
}

class FakeGenerator implements ClipGenerator {
  /** Cycle tags whose scene generation never resolves. */
  hangOn = new Set<string>();
  generated: string[] = [];
  constructor(private video: Config["video"]) {}
  async generateHostClip(riff: string, workDir: string, tag: string): Promise<RawClip> {
    return this.card(`${tag}-host`, workDir, riff);
  }
  async generateSceneClip(prompt: string, _sec: number, workDir: string, tag: string): Promise<RawClip> {
    if (this.hangOn.has(tag)) return new Promise(() => {});
    return this.card(`${tag}-scene`, workDir, prompt);
  }
  private async card(name: string, workDir: string, text: string): Promise<RawClip> {
    const mp4Path = path.join(workDir, `${name}.mp4`);
    await renderCardClip({ text, durationSec: 1, outPath: mp4Path, video: this.video });
    this.generated.push(name);
    return { mp4Path, durationSec: 1 };
  }
}

function readLog(outDir: string): { type: string; [k: string]: unknown }[] {
  const episodes = fs.readdirSync(path.join(outDir, "episodes"));
  assert.equal(episodes.length, 1);
  const dir = path.join(outDir, "episodes", episodes[0]);
  return fs
    .readFileSync(path.join(dir, "log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function airedLabels(log: { type: string; [k: string]: unknown }[]): string[] {
  return log.filter((e) => e.type === "playing").map((e) => String(e.label));
}

test("a full episode airs in cycle order, ends on time, and finalizes its recording", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-"));
  const config = testConfig(outDir, { maxCycles: 3 });
  const chat = new FakeChat();
  chat.queue.push({ id: "s1", username: "sam", text: "do a thing", at: Date.now() });
  const director = new FakeDirector();
  const generator = new FakeGenerator(config.video);
  const runner = new EpisodeRunner(config, show, chat, director, generator, new SpendMeter(0));
  const statuses: string[] = [];
  runner.onStatus = (s) => statuses.push(`${s.cycle}/${s.inFlight}/${s.live}`);

  await runner.run();

  const log = readLog(outDir);
  const aired = airedLabels(log);
  // Fillers may interleave, but generated content airs strictly in order.
  const scenes = aired.filter((l) => l.endsWith(" scene"));
  assert.deepEqual(scenes, ["cycle-001 scene", "cycle-002 scene", "cycle-003 scene"]);
  assert.ok(log.some((e) => e.type === "going_live"));
  assert.equal(director.calls[0].suggestions[0]?.text, "do a thing");
  const end = log.find((e) => e.type === "episode_end")!;
  assert.equal(end.cycles, 3);
  assert.equal(end.aborted, undefined);
  const saved = log.find((e) => e.type === "recording_saved")!;
  assert.ok(saved, "recording finalized");
  assert.ok(fs.existsSync(String(saved.path)));
  assert.ok(Number(saved.durationSec) > 2);
  assert.ok(statuses.some((s) => s.endsWith("/true")), "status reported live");
  // Working .ts copies are cleaned; the paid mp4s stay.
  const clips = fs.readdirSync(path.join(runner.archiveDir, "clips"));
  assert.ok(clips.every((f) => !f.endsWith(".ts")));
  assert.ok(clips.some((f) => f.endsWith(".mp4")));
});

test("a hung generation is abandoned at the timeout and later cycles still air", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-"));
  const config = testConfig(outDir, { maxCycles: 3, generationTimeoutSec: 2 });
  const director = new FakeDirector();
  const generator = new FakeGenerator(config.video);
  generator.hangOn.add("cycle-002");
  const runner = new EpisodeRunner(config, show, new FakeChat(), director, generator, new SpendMeter(0));
  const t0 = Date.now();
  await runner.run();

  const log = readLog(outDir);
  const timeout = log.find((e) => e.type === "cycle_error" && e.cycle === 2)!;
  assert.match(String(timeout.error), /generation \(cycle-002\) timed out after 2s/);
  const scenes = airedLabels(log).filter((l) => l.endsWith(" scene"));
  assert.deepEqual(scenes, ["cycle-001 scene", "cycle-003 scene"]);
  assert.ok(Date.now() - t0 < 60_000, "the episode ended instead of waiting on the hung cycle");
  assert.match(String(runner.snapshot().lastError), /timed out/);
});

test("director failures back off and carry the chat into the next attempt", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-"));
  const config = testConfig(outDir, { maxCycles: 3 });
  const chat = new FakeChat();
  chat.queue.push({ id: "s1", username: "sam", text: "keep me", at: Date.now() });
  const director = new FakeDirector();
  director.failOn.add(1);
  const generator = new FakeGenerator(config.video);
  const runner = new EpisodeRunner(config, show, chat, director, generator, new SpendMeter(0));
  const t0 = Date.now();
  await runner.run();

  assert.equal(director.calls[0].cycleNumber, 1);
  assert.equal(director.calls[1].cycleNumber, 2);
  assert.equal(director.calls[1].suggestions[0]?.text, "keep me", "suggestions from the failed call were carried over");
  const log = readLog(outDir);
  const err = log.find((e) => e.type === "cycle_error")!;
  assert.equal(err.stage, "director");
  assert.equal(err.backoffMs, 5000);
  assert.ok(Date.now() - t0 >= 5000, "the loop actually backed off");
  assert.deepEqual(airedLabels(log).filter((l) => l.endsWith(" scene")), ["cycle-002 scene", "cycle-003 scene"]);
});

test("a hard stop ends a live episode immediately and keeps the recording", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-"));
  const config = testConfig(outDir, { episodeMinutes: 5, bufferTargetSec: 60, maxConcurrentCycles: 1 });
  const director = new FakeDirector();
  const generator = new FakeGenerator(config.video);
  const runner = new EpisodeRunner(config, show, new FakeChat(), director, generator, new SpendMeter(0));
  let stopAt = 0;
  runner.onStatus = (s) => {
    if (s.live && !stopAt) {
      stopAt = Date.now();
      setTimeout(() => runner.requestHardStop(), 1500);
    }
  };
  await runner.run();
  assert.ok(stopAt > 0, "went live");
  assert.ok(Date.now() - stopAt < 20_000, "ended promptly after the hard stop");
  const log = readLog(outDir);
  const end = log.find((e) => e.type === "episode_end")!;
  assert.equal(end.aborted, "hard stop");
  assert.ok(!airedLabels(log).includes("closing"), "no sign-off on a hard stop");
  assert.equal(runner.snapshot().stopping, "hard");
  const saved = log.find((e) => e.type === "recording_saved");
  assert.ok(saved, "the partial recording is still finalized");
});

test("a graceful stop before going live cancels without a ghost episode", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-"));
  const config = testConfig(outDir);
  const runner = new EpisodeRunner(config, show, new FakeChat(), new FakeDirector(), new FakeGenerator(config.video), new SpendMeter(0));
  runner.requestStop();
  await runner.run();
  const log = readLog(outDir);
  assert.equal(log.find((e) => e.type === "episode_end")!.aborted, "stopped before going live");
  assert.ok(!log.some((e) => e.type === "going_live"));
  assert.ok(!log.some((e) => e.type === "recording_saved"));
});

test("the budget gate stops new cycles before the cap and still airs the cached content", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-"));
  const config = testConfig(outDir, { dryRun: false, maxCycles: 10 });
  const spend = new SpendMeter(2.5); // worst case per cycle (hosted show) = 30s × $0.08 = $2.40
  const generator = new FakeGenerator(config.video);
  const charging: ClipGenerator = {
    generateHostClip: (r, w, t) => generator.generateHostClip(r, w, t),
    generateSceneClip: (p, s, w, t, refs) => {
      spend.charge(1.2);
      return generator.generateSceneClip(p, s, w, t, refs);
    },
  };
  const runner = new EpisodeRunner(config, show, new FakeChat(), new FakeDirector(), charging, spend);
  await runner.run();
  const log = readLog(outDir);
  const reached = log.find((e) => e.type === "budget_reached")!;
  assert.ok(reached, "budget gate fired");
  assert.equal(log.find((e) => e.type === "episode_end")!.cycles, 1, "one cycle fit; a second worst-case cycle would cross $2.50");
  assert.equal(runner.spentUsd, 1.2);
});

test("the output screen drops a refused cycle before generation and the summary carries timing evidence", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-"));
  const config = testConfig(outDir, { maxCycles: 3 });
  const generator = new FakeGenerator(config.video);
  const screener: Screener = {
    async screen(decision) {
      return decision.scenePrompt === "scene 2" ? { ok: false, reason: "test refusal" } : { ok: true, reason: null };
    },
  };
  const runner = new EpisodeRunner(config, show, new FakeChat(), new FakeDirector(), generator, new SpendMeter(0), screener);
  await runner.run();

  const log = readLog(outDir);
  const refused = log.find((e) => e.type === "screened_out")!;
  assert.equal(refused.cycle, 2);
  assert.equal(refused.reason, "test refusal");
  assert.ok(!generator.generated.some((g) => g.startsWith("cycle-002")), "nothing was generated for the refused cycle");
  assert.deepEqual(airedLabels(log).filter((l) => l.endsWith(" scene")), ["cycle-001 scene", "cycle-003 scene"]);

  const end = log.find((e) => e.type === "episode_end")! as { screenedOut?: number; timing?: { generationMs?: { n: number; p95: number } }; director?: { calls: number; cacheReadTokens: number } };
  assert.equal(end.screenedOut, 1);
  assert.equal(end.timing?.generationMs?.n, 2);
  assert.ok((end.timing?.generationMs?.p95 ?? 0) > 0);
  assert.equal(end.director?.calls, 3);
  assert.equal(end.director?.cacheReadTokens, 2400, "cache reads are summed so caching is provable from the log");
});
