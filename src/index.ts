import { loadConfig } from "./config.js";
import { buildComponents } from "./components.js";
import { EpisodeRunner } from "./episode/runner.js";

const config = loadConfig(process.argv.slice(2));
const { chat, director, generator } = buildComponents(config);
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
