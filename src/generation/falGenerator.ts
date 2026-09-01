import { fal } from "@fal-ai/client";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ClipGenerator, RawClip } from "../types.js";
import { Config } from "../config.js";
import { ShowConfig, hostClipPrompt } from "../shows.js";

/**
 * Real generator backed by MiniMax H3 Max on fal.
 *
 * Endpoints (verified against fal's registry, Aug 2026):
 * - minimax/h3-max/reference-to-video — subject/voice consistency via
 *   reference_image_urls + reference_audio_urls ($0.08/s of video)
 * - minimax/h3-max/text-to-video — no references ($0.04/s at 768P, promo rate)
 *
 * When Tilly reference images are configured we use reference-to-video for
 * every clip (likeness + voice held by the references); otherwise we fall
 * back to text-to-video and rely on the prompt's visual anchors alone.
 */
export class FalH3MaxGenerator implements ClipGenerator {
  private referenceImageUrls: string[];
  private referenceAudioUrl: string | null;

  constructor(
    falKey: string,
    private show: ShowConfig,
    fallbackRefs: { imageUrls: string[]; audioUrl: string | null },
    private _video: Config["video"],
  ) {
    fal.config({ credentials: falKey });
    // Show-level references win; env-level references are the fallback.
    this.referenceImageUrls = show.character.referenceImageUrls?.length
      ? show.character.referenceImageUrls
      : fallbackRefs.imageUrls;
    this.referenceAudioUrl = show.character.referenceAudioUrl ?? fallbackRefs.audioUrl;
  }

  private get useReferences(): boolean {
    return this.referenceImageUrls.length > 0;
  }

  private referencePreamble(): string {
    const imgs = this.referenceImageUrls
      .map((_, i) => `Image ${i + 1}`)
      .join(" and ");
    let p = `The person shown in ${imgs} is ${this.show.character.name}. `;
    if (this.referenceAudioUrl) {
      p += `${this.show.character.name}'s voice is the voice in Audio 1. `;
    }
    return p;
  }

  private async generate(
    prompt: string,
    durationSec: number,
    outPath: string,
  ): Promise<RawClip> {
    const duration = Math.min(15, Math.max(5, Math.round(durationSec)));
    let result: { data: { video: { url: string } } };
    if (this.useReferences) {
      result = (await fal.subscribe("minimax/h3-max/reference-to-video", {
        input: {
          prompt: this.referencePreamble() + prompt,
          prompt_expansion_mode: "balanced",
          duration,
          resolution: "768P",
          aspect_ratio: "16:9",
          reference_image_urls: this.referenceImageUrls,
          ...(this.referenceAudioUrl
            ? { reference_audio_urls: [this.referenceAudioUrl] }
            : {}),
        },
      })) as { data: { video: { url: string } } };
    } else {
      result = (await fal.subscribe("minimax/h3-max/text-to-video", {
        input: {
          prompt,
          prompt_expansion_mode: "balanced",
          duration,
          resolution: "768P",
          aspect_ratio: "16:9",
        },
      })) as { data: { video: { url: string } } };
    }

    await downloadTo(result.data.video.url, outPath);
    return { mp4Path: outPath, durationSec: duration };
  }

  async generateHostClip(riff: string, workDir: string, tag: string): Promise<RawClip> {
    return this.generate(hostClipPrompt(this.show, riff), 8, path.join(workDir, `${tag}-host.mp4`));
  }

  async generateSceneClip(
    prompt: string,
    durationSec: number,
    workDir: string,
    tag: string,
  ): Promise<RawClip> {
    return this.generate(prompt, durationSec, path.join(workDir, `${tag}-scene.mp4`));
  }
}

async function downloadTo(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`clip download failed: HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(outPath));
}
