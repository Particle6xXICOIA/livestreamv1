import { loadConfig } from "./config.js";
import { EpisodeRunner } from "./episode/runner.js";
import { StubChat } from "./chat/stubChat.js";
import { TwitchChat } from "./chat/twitchChat.js";
import { StubDirector } from "./director/stubDirector.js";
import { ClaudeDirector } from "./director/claudeDirector.js";
import { StubGenerator } from "./generation/stubGenerator.js";
import { FalH3MaxGenerator } from "./generation/falGenerator.js";

const config = loadConfig(process.argv.slice(2));

// Each component independently runs real or stub, so the loop can be tested
// at any level of fidelity: full dry run, real director + stub video, etc.
const chat = config.dryRun
  ? new StubChat()
  : config.twitchChannel
    ? new TwitchChat(config.twitchChannel)
    : warnStub("chat", "TWITCH_CHANNEL not set", new StubChat());

const director = config.dryRun
  ? new StubDirector()
  : config.anthropicKey
    ? new ClaudeDirector(config.anthropicKey)
    : warnStub("director", "ANTHROPIC_API_KEY not set", new StubDirector());

const generator = config.dryRun
  ? new StubGenerator(config.video)
  : config.falKey
    ? new FalH3MaxGenerator(
        config.falKey,
        config.tillyReferenceImageUrls,
        config.tillyReferenceAudioUrl,
        config.video,
      )
    : warnStub("generator", "FAL_KEY not set", new StubGenerator(config.video));

function warnStub<T>(name: string, why: string, stub: T): T {
  console.warn(`[config] ${why} — using stub ${name}`);
  return stub;
}

const runner = new EpisodeRunner(config, chat, director, generator);

process.on("SIGINT", () => {
  console.log("\nSIGINT — ending episode…");
  runner.requestStop();
  // Second Ctrl-C force-quits.
  process.on("SIGINT", () => runner.abort().then(() => process.exit(130)));
});

runner.run().catch((err) => {
  console.error("episode crashed:", err);
  runner.abort().finally(() => process.exit(1));
});
