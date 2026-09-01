import { CycleDecision, Director, Suggestion } from "../types.js";
import { ShowConfig, hasHostRiffs } from "../shows.js";

/** Deterministic director for dry runs — no API key, no judgment, just plumbing. */
export class StubDirector implements Director {
  constructor(private show: ShowConfig) {}

  async decide(input: {
    suggestions: Suggestion[];
    recentCycles: string[];
    cycleNumber: number;
    showState: string | null;
  }): Promise<CycleDecision> {
    const { character, format, cast } = this.show;
    const pick = input.suggestions[0] ?? null;
    const idea = pick?.text ?? "improvise a one-person staring contest";
    const credit = pick ? `${pick.username} suggests: ${idea}` : `nobody's typing, so: ${idea}`;
    // Rotate through the cast so multi-character dry runs exercise the refs path.
    const castNames = cast?.length
      ? [cast[(input.cycleNumber - 1) % cast.length].name]
      : [];
    return {
      suggestion: pick,
      hostRiff: hasHostRiffs(this.show)
        ? `Right — ${credit}. I have no idea how to do that, which has never once stopped me.`
        : "",
      scenePrompt:
        `${character.visualAnchors}, acting out: ${idea}. ` +
        `Medium shot, static camera, one clear comedic beat with a beginning and an end.`,
      sceneDurationSec: format.defaultSceneSec,
      castNames,
      updatedState: format.stateInstructions
        ? `${input.showState ?? "(state initialized)"}\ncycle ${input.cycleNumber}: ${idea.slice(0, 60)}`.slice(-600)
        : null,
      declined: [],
    };
  }
}
