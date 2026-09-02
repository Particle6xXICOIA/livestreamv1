import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { CycleDecision } from "../types.js";

/**
 * Output-side content screen. The director already declines unsafe chat, but
 * prompt-safe is not output-safe: the riff and scene prompt the director
 * WRITES are what actually reach the video model and the audience, and every
 * AI stream that got taken down failed on that side. A cheap second model
 * reads the director's output against the platform rules before generation
 * spends a cent on it.
 */
export interface Screener {
  screen(decision: CycleDecision): Promise<ScreenResult>;
}

export interface ScreenResult {
  ok: boolean;
  reason: string | null;
}

const ScreenSchema = z.object({
  ok: z.boolean().describe("true when the content is fine to generate and air"),
  reason: z.string().nullable().describe("when ok is false: one short sentence naming the rule broken; otherwise null"),
});

export const SCREEN_RULES = `You are the broadcast standards check for a livestream of AI-generated video. You receive the text a show director wrote for the next segment: the host's spoken line and the video-generation prompt for the scene. Decide whether it may air.

Refuse (ok=false) if the text contains or clearly asks the video model for:
- sexual content or nudity, or sexualised depiction of anyone;
- a real, identifiable person (by name or unmistakable description) other than the show's own fictional cast — impersonation, mockery, or "deepfake" framing;
- harassment, slurs, or demeaning content about a protected group, or targeting a private individual;
- violence played straight (graphic injury, gore, cruelty presented as real rather than cartoon/slapstick);
- self-harm, drug-use instruction, weapons instruction, or other dangerous how-to;
- content designed to deceive viewers into thinking generated footage is real news or real events.

Comedy, absurdity, slapstick, satire of institutions, and drama are all fine. Do not refuse for being unfunny, weird, or off-brand — only for the rules above. Be decisive; when clearly fine, ok=true with reason null.`;

export class ClaudeScreener implements Screener {
  private client: Anthropic;

  constructor(
    apiKey: string,
    /** Cheap, fast model — this is a classifier, not a writer. */
    private model = "claude-haiku-4-5-20251001",
    timeoutMs = 30_000,
  ) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  }

  async screen(decision: CycleDecision): Promise<ScreenResult> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 200,
      system: [{ type: "text", text: SCREEN_RULES, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content:
            `HOST LINE:\n${decision.hostRiff || "(none)"}\n\n` +
            `SCENE PROMPT:\n${decision.scenePrompt}\n\n` +
            `CAST IN SCENE: ${decision.castNames.join(", ") || "(lead only)"}`,
        },
      ],
      output_config: { format: zodOutputFormat(ScreenSchema) },
    });
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("screener response failed to parse");
    return { ok: parsed.ok, reason: parsed.ok ? null : parsed.reason ?? "refused" };
  }
}
