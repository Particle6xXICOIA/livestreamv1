import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { CycleDecision, Director, Suggestion } from "../types.js";

const DecisionSchema = z.object({
  pickedSuggestionId: z
    .string()
    .nullable()
    .describe("id of the chosen chat suggestion, or null when inventing one"),
  hostRiff: z
    .string()
    .describe("the host's spoken riff, 1-2 sentences of pure dialogue — empty string on shows with no host segments"),
  scenePrompt: z.string().describe("complete text-to-video prompt for the acted-out scene"),
  sceneDurationSec: z.number().describe("5 to 15"),
  castNames: z
    .array(z.string())
    .describe("names of cast-roster members appearing in the scene — empty when the show lists no cast"),
  updatedState: z
    .string()
    .nullable()
    .describe("the complete rewritten show state after this cycle — null on shows that track no state"),
  declined: z.array(
    z.object({ suggestionId: z.string(), reason: z.string() }),
  ),
});

export class ClaudeDirector implements Director {
  private client: Anthropic;

  constructor(
    apiKey: string,
    private systemPrompt: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async decide(input: {
    suggestions: Suggestion[];
    recentCycles: string[];
    cycleNumber: number;
    showState: string | null;
  }): Promise<CycleDecision> {
    const byId = new Map(input.suggestions.map((s) => [s.id, s]));
    const chatBlock =
      input.suggestions.length === 0
        ? "(chat is quiet — advance the show yourself)"
        : input.suggestions
            .map((s) => `[id=${s.id}] ${s.username}: ${s.text}`)
            .join("\n");

    const response = await this.client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 2000,
      system: [
        {
          type: "text",
          text: this.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            `Cycle ${input.cycleNumber}.\n\n` +
            (input.showState !== null
              ? `Current show state:\n${input.showState}\n\n`
              : "") +
            `Recent cycles (avoid repeating these shapes/settings):\n` +
            (input.recentCycles.map((c) => `- ${c}`).join("\n") || "- (none yet)") +
            `\n\nChat messages this cycle:\n${chatBlock}`,
        },
      ],
      output_config: { format: zodOutputFormat(DecisionSchema) },
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error("director response failed to parse");
    }

    return {
      suggestion: parsed.pickedSuggestionId
        ? (byId.get(parsed.pickedSuggestionId) ?? null)
        : null,
      hostRiff: parsed.hostRiff,
      scenePrompt: parsed.scenePrompt,
      sceneDurationSec: Math.min(15, Math.max(5, Math.round(parsed.sceneDurationSec))),
      castNames: parsed.castNames,
      updatedState: parsed.updatedState,
      declined: parsed.declined.map((d) => {
        const s = byId.get(d.suggestionId);
        return { username: s?.username ?? "?", text: s?.text ?? d.suggestionId, reason: d.reason };
      }),
    };
  }
}
