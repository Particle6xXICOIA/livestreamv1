import { loadConfig } from "./config.js";
import { getShow } from "./shows.js";
import { buildComponents } from "./components.js";
import { EpisodeRunner } from "./episode/runner.js";

const config = loadConfig(process.argv.slice(2));
const show = getShow(config.show);
const { chat, director, generator, spend } = buildComponents(config, show);
const runner = new EpisodeRunner(config, show, chat, director, generator, spend);

process.on("SIGINT", () => {
  console.log("\nSIGINT — ending episode gracefully (Ctrl-C again for a hard stop)…");
  runner.requestStop();
  // Second Ctrl-C hard-stops: cut the stream now, keep the recording.
  process.once("SIGINT", () => {
    console.log("\nSIGINT — hard stop");
    runner.requestHardStop();
  });
});

runner.run().catch((err) => {
  console.error("episode crashed:", err);
  runner.abort().finally(() => process.exit(1));
});
