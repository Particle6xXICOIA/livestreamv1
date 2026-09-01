import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirSizeBytes, freeBytes, pruneEpisodes, recoverOrphanRecordings } from "../../src/episode/archive.js";

function makeEpisode(root: string, id: string, bytes: number): string {
  const dir = path.join(root, "episodes", id);
  fs.mkdirSync(path.join(dir, "clips"), { recursive: true });
  fs.writeFileSync(path.join(dir, "episode.mp4"), Buffer.alloc(bytes));
  fs.writeFileSync(path.join(dir, "log.jsonl"), "");
  return dir;
}

test("pruneEpisodes deletes oldest first, never the kept episode, until under the cap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-"));
  makeEpisode(root, "2026-09-01T10-00-00-000Z", 1000);
  makeEpisode(root, "2026-09-01T11-00-00-000Z", 1000);
  const keep = makeEpisode(root, "2026-09-01T12-00-00-000Z", 1000);
  makeEpisode(root, "2026-09-01T13-00-00-000Z", 1000);

  assert.deepEqual(pruneEpisodes(root, 10_000, keep), [], "under the cap: nothing deleted");
  const deleted = pruneEpisodes(root, 2_100, keep);
  assert.deepEqual(deleted, ["2026-09-01T10-00-00-000Z", "2026-09-01T11-00-00-000Z"]);
  assert.ok(fs.existsSync(keep));
  assert.ok(fs.existsSync(path.join(root, "episodes", "2026-09-01T13-00-00-000Z")));

  // Even a cap smaller than the kept episode never deletes it.
  assert.deepEqual(pruneEpisodes(root, 10, keep), ["2026-09-01T13-00-00-000Z"]);
  assert.ok(fs.existsSync(keep));
  assert.deepEqual(pruneEpisodes(root, 10, null), ["2026-09-01T12-00-00-000Z"], "no keepDir: everything is fair game");
});

test("pruneEpisodes on a missing root is a no-op", () => {
  assert.deepEqual(pruneEpisodes(path.join(os.tmpdir(), "does-not-exist-" + Date.now()), 1, null), []);
});

test("dirSizeBytes sums a tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "size-"));
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", "x"), Buffer.alloc(10));
  fs.writeFileSync(path.join(root, "a", "b", "y"), Buffer.alloc(32));
  assert.equal(dirSizeBytes(root), 42);
});

test("freeBytes works for a not-yet-existing directory (nearest ancestor)", () => {
  const free = freeBytes(path.join(os.tmpdir(), "nope", "deeper", "still-nope"));
  assert.ok(free > 0);
});

test("recoverOrphanRecordings removes empty stream.ts leftovers and reports nothing recovered", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-"));
  const dir = makeEpisode(root, "2026-09-01T10-00-00-000Z", 1);
  fs.rmSync(path.join(dir, "episode.mp4"));
  fs.writeFileSync(path.join(dir, "stream.ts"), "");
  assert.deepEqual(await recoverOrphanRecordings(root), []);
  assert.equal(fs.existsSync(path.join(dir, "stream.ts")), false);
  assert.deepEqual(await recoverOrphanRecordings(path.join(root, "missing")), []);
});
