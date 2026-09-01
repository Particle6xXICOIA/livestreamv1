import tmi from "tmi.js";
import { ChatSource, Suggestion } from "../types.js";

/**
 * Reads suggestions from a Twitch channel's chat. Connects anonymously —
 * reading chat needs no token. A message counts as a suggestion when it
 * starts with "!prompt "; everything else is ignored (the director only
 * ever sees explicit suggestions).
 */
export class TwitchChat implements ChatSource {
  private client: tmi.Client;
  private pending: Suggestion[] = [];
  private n = 0;

  constructor(channel: string) {
    this.client = new tmi.Client({ channels: [channel] });
    this.client.on("message", (_channel, tags, message, self) => {
      if (self) return;
      const m = message.trim();
      if (!m.toLowerCase().startsWith("!prompt ")) return;
      const text = m.slice("!prompt ".length).trim();
      if (!text) return;
      this.n++;
      this.pending.push({
        id: tags.id ?? `tw-${this.n}`,
        username: tags["display-name"] ?? tags.username ?? "someone",
        text: text.slice(0, 300),
        at: Date.now(),
      });
    });
  }

  async start(): Promise<void> {
    await this.client.connect();
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }

  drainSuggestions(): Suggestion[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
