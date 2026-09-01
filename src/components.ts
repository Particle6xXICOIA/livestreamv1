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
import { SpendMeter } from "./generation/spend.js";

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
): {
  chat: ChatSource;
  director: Director;
  generator: ClipGenerator;
  spend: SpendMeter;
} {
  // Dry runs are free — never let the budget gate cut them short.
  const spend = new SpendMeter(config.dryRun ? 0 : config.episodeBudgetUsd);
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
      ? new ClaudeDirector(config.anthropicKey, buildDirectorPrompt(show))
      : warnStub("director", "ANTHROPIC_API_KEY not set", new StubDirector(show));

  const generator = config.dryRun
    ? new StubGenerator(config.video)
    : config.falKey
      ? new FalH3MaxGenerator(config.falKey, show, envFallbackRefs(config, show), config.video, config.testQuality, spend)
      : warnStub("generator", "FAL_KEY not set", new StubGenerator(config.video));

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
