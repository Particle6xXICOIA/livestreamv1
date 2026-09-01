import { CycleDecision, Director, Suggestion } from "../types.js";
import { ShowConfig } from "../shows.js";

/** Deterministic director for dry runs — no API key, no judgment, just plumbing. */
export class StubDirector implements Director {
  constructor(private show: ShowConfig) {}

  async decide(input: {
    suggestions: Suggestion[];
    recentCycles: string[];
    cycleNumber: number;
  }): Promise<CycleDecision> {
    const { character, format } = this.show;
    const pick = input.suggestions[0] ?? null;
    const idea = pick?.text ?? "improvise a one-person staring contest";
    const credit = pick ? `${pick.username} suggests: ${idea}` : `nobody's typing, so: ${idea}`;
    return {
      suggestion: pick,
      hostRiff: `Right — ${credit}. I have no idea how to do that, which has never once stopped me.`,
      scenePrompt:
        `${character.visualAnchors}, acting out: ${idea}. ` +
        `Medium shot, static camera, one clear comedic beat with a beginning and an end.`,
      sceneDurationSec: format.defaultSceneSec,
      declined: [],
    };
  }
}
