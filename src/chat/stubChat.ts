import { ChatSource, Suggestion } from "../types.js";

const SCRIPTED: { username: string; text: string }[] = [
  { username: "sam_dev", text: "order a coffee as a Victorian ghost" },
  { username: "priya", text: "audition for a shampoo advert but the shampoo is haunted" },
  { username: "mark", text: "teach a goldfish to parallel park" },
  { username: "lena_qa", text: "dramatic weather forecast for the inside of a fridge" },
  { username: "jo", text: "win an argument with a self-checkout machine" },
];

/** Feeds scripted suggestions on a timer so a dry run exercises the full loop. */
export class StubChat implements ChatSource {
  private pending: Suggestion[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private i = 0;

  constructor(private intervalMs = 5_000) {}

  async start(): Promise<void> {
    this.push(); // one suggestion available immediately
    this.timer = setInterval(() => this.push(), this.intervalMs);
  }

  private push() {
    const s = SCRIPTED[this.i % SCRIPTED.length];
    this.i++;
    this.pending.push({
      id: `stub-${this.i}`,
      username: s.username,
      text: s.text,
      at: Date.now(),
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  drainSuggestions(): Suggestion[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
