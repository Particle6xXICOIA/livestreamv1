import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.js";

test("loadConfig defaults keep the spend and disk guards on", () => {
  const saved = { ...process.env };
  for (const k of ["EPISODE_BUDGET_USD", "DAILY_BUDGET_USD", "ARCHIVE_MAX_GB", "MIN_FREE_GB", "EPISODE_MINUTES", "SHOW"]) delete process.env[k];
  try {
    const c = loadConfig([]);
    assert.equal(c.dryRun, false);
    assert.equal(c.episodeBudgetUsd, 5);
    assert.equal(c.dailyBudgetUsd, 25);
    assert.equal(c.archiveMaxGB, 2);
    assert.equal(c.minFreeGB, 1);
    assert.equal(c.generationTimeoutSec, 240);
    assert.equal(c.directorTimeoutSec, 90);
    assert.equal(c.maxCycles, Infinity);
    assert.equal(c.show, "tilly-improv");
  } finally {
    process.env = saved;
  }
});

test("loadConfig flags override env, and bare flags are booleans", () => {
  const saved = { ...process.env };
  process.env.EPISODE_BUDGET_USD = "9";
  process.env.DAILY_BUDGET_USD = "0";
  try {
    const c = loadConfig(["--dry-run", "--minutes", "3", "--budget", "2.5", "--cycles", "4", "--show", "x", "--test-quality", "--daily-budget", "12"]);
    assert.equal(c.dryRun, true);
    assert.equal(c.testQuality, true);
    assert.equal(c.episodeMinutes, 3);
    assert.equal(c.episodeBudgetUsd, 2.5);
    assert.equal(c.dailyBudgetUsd, 12);
    assert.equal(c.maxCycles, 4);
    assert.equal(c.show, "x");
    assert.equal(loadConfig([]).episodeBudgetUsd, 9, "env applies when the flag is absent");
    assert.equal(loadConfig([]).dailyBudgetUsd, 0);
  } finally {
    process.env = saved;
  }
});
