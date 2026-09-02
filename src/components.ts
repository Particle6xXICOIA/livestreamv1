import path from "node:path";
import { Config } from "./config.js";
import { ShowConfig, buildDirectorPrompt } from "./shows.js";
import { ChatSource, ClipGenerator, Director } from "./types.js";
import { StubChat } from "./chat/stubChat.js";
import { TwitchChat } from "./chat/twitchChat.js";
import { YouTubeChat } from "./chat/youtubeChat.js";
import { StubDirector } from "./director/stubDirector.js";
import { ClaudeDirector } from "./director/claudeDirector.js";
import { StubGenerator } from "./generation/stubGenerator.js";
import { FalH3MaxGenerator } from "./generation/falGenerator.js";
import { DailySpendLedger, SpendMeter } from "./generation/spend.js";

/** Where the cross-episode spend ledger lives (one file per UTC day). */
export function makeLedger(config: Config): DailySpendLedger {
  return new DailySpendLedger(path.join(config.outDir, "spend"), config.dailyBudgetUsd);
}

export class DailyBudgetExhausted extends Error {
  constructor(readonly dailyBudgetUsd: number, readonly spentTodayUsd: number) {
    super(
      `daily spend cap reached: ~$${spentTodayUsd.toFixed(2)} of $${dailyBudgetUsd.toFixed(2)} used today — ` +
        `raise DAILY_BUDGET_USD deliberately or wait for the UTC day to roll over`,
    );
  }
}

/**
 * Each component independently runs real or stub depending on configuration,
 * so the loop can be tested at any level of fidelity: full dry run, real
 * director + stub video, etc. Chat precedence: YouTube (video id + API key)
 * over Twitch over stub.
 */
export function buildComponents(
  config: Config,
  show: ShowConfig,
  chatOverride?: ChatSource,
  ledger: DailySpendLedger | null = makeLedger(config),
): {
  chat: ChatSource;
  director: Director;
  generator: ClipGenerator;
  spend: SpendMeter;
} {
  // Dry runs are free — never let the budget gate cut them short. Paid
  // episodes run under their own cap tightened to what is left of the day.
  let cap = 0;
  if (!config.dryRun) {
    cap = config.episodeBudgetUsd;
    if (ledger) {
      const allowed = ledger.episodeCap(config.episodeBudgetUsd);
      if (allowed === null) throw new DailyBudgetExhausted(ledger.dailyBudgetUsd, ledger.spentToday());
      cap = allowed;
    }
  }
  const spend = new SpendMeter(cap, config.dryRun || !ledger ? undefined : (usd) => ledger.record(usd, show.id));
  const chat = chatOverride
    ? chatOverride
    : config.dryRun
    ? new StubChat()
    : config.youtubeVideoId && config.youtubeApiKey
      ? new YouTubeChat(config.youtubeApiKey, config.youtubeVideoId)
      : config.twitchChannel
        ? new TwitchChat(config.twitchChannel)
        : warnStub("chat", "no YouTube video id or Twitch channel configured", new StubChat());

  const director = config.dryRun
    ? new StubDirector(show)
    : config.anthropicKey
      ? new ClaudeDirector(config.anthropicKey, buildDirectorPrompt(show), config.directorTimeoutSec * 1000)
      : warnStub("director", "ANTHROPIC_API_KEY not set", new StubDirector(show));

  const generator = config.dryRun
    ? new StubGenerator(config.video, show.character.name)
    : config.falKey
      ? new FalH3MaxGenerator(config.falKey, show, envFallbackRefs(config, show), config.testQuality, spend)
      : warnStub("generator", "FAL_KEY not set", new StubGenerator(config.video, show.character.name));

  return { chat, director, generator, spend };
}

/**
 * Env-level Tilly references only ever back built-in shows; a created show
 * with missing references must generate prompt-only rather than borrow the
 * platform default character's likeness.
 */
export function envFallbackRefs(
  config: Config,
  show: ShowConfig,
): { imageUrls: string[]; audioUrl: string | null } {
  return show.origin === "created"
    ? { imageUrls: [], audioUrl: null }
    : { imageUrls: config.tillyReferenceImageUrls, audioUrl: config.tillyReferenceAudioUrl };
}

function warnStub<T>(name: string, why: string, stub: T): T {
  console.warn(`[config] ${why} — using stub ${name}`);
  return stub;
}
