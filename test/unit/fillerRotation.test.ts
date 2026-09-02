import { test } from "node:test";
import assert from "node:assert/strict";
import { FillerRotation } from "../../src/playout/fillerRotation.js";
import { percentiles } from "../../src/episode/runner.js";
import { Clip } from "../../src/types.js";

const lib = (n: number): Clip[] =>
  Array.from({ length: n }, (_, i) => ({ tsPath: `/lib/${i}.ts`, durationSec: 8, kind: "filler" as const, label: `lib${i}` }));
const scene = (i: number): Clip => ({ tsPath: `/ep/scene${i}.ts`, durationSec: 12, kind: "scene", label: `cycle-00${i} scene` });

test("FillerRotation rotates the library and ignores reruns until they are old enough", () => {
  const r = new FillerRotation(lib(2), { minAgeMs: 1000, maxReruns: 5 });
  r.noteAired(scene(1), 0);
  r.noteAired({ ...scene(9), kind: "host" }, 0); // hosts never rerun
  assert.equal(r.rerunCount, 1);
  assert.equal(r.next(10)?.label, "lib0");
  assert.equal(r.next(20)?.label, "lib1", "rerun slot, but the scene is too fresh: library again");
  assert.equal(r.next(30)?.label, "lib0");
});

test("FillerRotation interleaves reruns with library clips, oldest replay first", () => {
  const r = new FillerRotation(lib(1), { minAgeMs: 1000, maxReruns: 5 });
  r.noteAired(scene(1), 0);
  r.noteAired(scene(2), 500);
  const picks = [r.next(5000), r.next(5001), r.next(5002), r.next(5003), r.next(5004), r.next(5005)].map((c) => c?.label);
  assert.deepEqual(picks, ["lib0", "rerun cycle-001 scene", "lib0", "rerun cycle-002 scene", "lib0", "rerun cycle-001 scene"]);
  const rerun = r.next(6000);
  assert.equal(rerun?.label, "lib0");
  const rr = r.next(6001)!;
  assert.equal(rr.kind, "filler", "reruns air as fillers, keeping the original tsPath");
  assert.equal(rr.tsPath, "/ep/scene2.ts");
});

test("FillerRotation with no library uses reruns only, and nothing when there is nothing", () => {
  const r = new FillerRotation([], { minAgeMs: 0, maxReruns: 2 });
  assert.equal(r.next(0), undefined);
  r.noteAired(scene(1), 0);
  r.noteAired(scene(1), 0); // duplicate ignored
  r.noteAired(scene(2), 0);
  r.noteAired(scene(3), 0); // evicts the oldest beyond maxReruns
  assert.equal(r.rerunCount, 2);
  assert.match(r.next(1)!.label, /rerun cycle-00[23] scene/);
});

test("percentiles reports p50/p95/max and null for no samples", () => {
  assert.equal(percentiles([]), null);
  assert.deepEqual(percentiles([5]), { n: 1, p50: 5, p95: 5, max: 5 });
  const p = percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])!;
  assert.equal(p.p50, 50);
  assert.equal(p.p95, 100);
  assert.equal(p.max, 100);
  assert.equal(p.n, 10);
});
