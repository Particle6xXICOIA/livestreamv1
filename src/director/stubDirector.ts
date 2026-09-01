import { CycleDecision, Director, Suggestion } from "../types.js";
import { TILLY_VISUAL_ANCHORS } from "../persona.js";

/** Deterministic director for dry runs — no API key, no judgment, just plumbing. */
export class StubDirector implements Director {
  async decide(input: {
    suggestions: Suggestion[];
    recentCycles: string[];
    cycleNumber: number;
  }): Promise<CycleDecision> {
    const pick = input.suggestions[0] ?? null;
    const idea = pick?.text ?? "improvise a one-woman staring contest";
    const credit = pick ? `${pick.username} wants me to ${idea}` : `nobody's typing, so I'll ${idea}`;
    return {
      suggestion: pick,
      hostRiff: `Right — ${credit}. I have no idea how to do that, which has never once stopped me.`,
      scenePrompt:
        `${TILLY_VISUAL_ANCHORS}, acting out: ${idea}. ` +
        `Medium shot, static camera, one clear comedic beat with a beginning and an end.`,
      sceneDurationSec: 8,
      declined: [],
    };
  }
}
