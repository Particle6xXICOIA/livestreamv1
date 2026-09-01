import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DailySpendLedger, SpendMeter } from "../../src/generation/spend.js";

test("SpendMeter gates on worst-case cost and reports exhaustion", () => {
  const charges: number[] = [];
  const m = new SpendMeter(5, (usd) => charges.push(usd));
  assert.equal(m.wouldExceed(5), false);
  assert.equal(m.wouldExceed(5.01), true);
  m.charge(2.4);
  assert.equal(m.spentUsd, 2.4);
  assert.equal(m.exhausted, false);
  assert.equal(m.wouldExceed(2.4), false, "2.4 + 2.4 = 4.8 fits");
  assert.equal(m.wouldExceed(2.7), true, "2.4 + 2.7 would cross $5");
  m.charge(2.6);
  assert.equal(m.exhausted, true);
  assert.deepEqual(charges, [2.4, 2.6]);
});

test("SpendMeter with budget <= 0 is uncapped", () => {
  const m = new SpendMeter(0);
  m.charge(1000);
  assert.equal(m.exhausted, false);
  assert.equal(m.wouldExceed(1e9), false);
});

test("DailySpendLedger persists charges per UTC day and computes the episode cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  let now = new Date("2026-09-01T23:50:00Z");
  const ledger = new DailySpendLedger(dir, 25, () => now);

  assert.equal(ledger.spentToday(), 0);
  assert.equal(ledger.remainingToday(), 25);
  assert.equal(ledger.episodeCap(5), 5);
  assert.equal(ledger.episodeCap(0), 25, "an uncapped episode inherits the daily remainder");

  ledger.record(4.8, "tilly-improv");
  ledger.record(0.4);
  ledger.record(0, "ignored");
  assert.equal(ledger.spentToday(), 5.2);
  assert.equal(ledger.episodeCap(5), 5);
  assert.equal(ledger.episodeCap(30), 19.8, "tightened to what is left");

  // A fresh ledger over the same dir sees the persisted total.
  assert.equal(new DailySpendLedger(dir, 25, () => now).spentToday(), 5.2);
  const file = JSON.parse(fs.readFileSync(path.join(dir, "2026-09-01.json"), "utf8"));
  assert.equal(file.charges, 2);
  assert.equal(file.lastNote, "tilly-improv");

  ledger.record(19.8);
  assert.equal(ledger.remainingToday(), 0);
  assert.equal(ledger.episodeCap(5), null, "nothing left today");

  // The UTC day rolls over: a new file, full budget again.
  now = new Date("2026-09-02T00:01:00Z");
  assert.equal(ledger.spentToday(), 0);
  assert.equal(ledger.episodeCap(5), 5);
});

test("DailySpendLedger with dailyBudget <= 0 never gates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  const ledger = new DailySpendLedger(dir, 0);
  ledger.record(500);
  assert.equal(ledger.remainingToday(), Infinity);
  assert.equal(ledger.episodeCap(5), 5);
  assert.equal(ledger.episodeCap(0), 0);
});
