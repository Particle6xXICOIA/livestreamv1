import { ChatSource, Suggestion } from "../types.js";

/**
 * Chat source for the self-hosted viewer page: the control server pushes
 * suggestions straight in from its websocket, so on our own platform there is
 * no third-party API between a viewer typing and the director seeing it.
 */
export class WebChat implements ChatSource {
  private pending: Suggestion[] = [];
  private n = 0;

  push(username: string, text: string): void {
    this.n++;
    this.pending.push({
      id: `web-${this.n}`,
      username: username.slice(0, 40) || "someone",
      text: text.slice(0, 300),
      at: Date.now(),
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  drainSuggestions(): Suggestion[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
