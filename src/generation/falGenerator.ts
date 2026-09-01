import { fal } from "@fal-ai/client";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ClipGenerator, RawClip, SceneRefs } from "../types.js";
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
 * Show-level references (the lead's likeness + voice) condition every clip by
 * default; multi-character scenes pass per-clip SceneRefs instead, binding
 * each cast member's reference still by name. With no references at all we
 * fall back to text-to-video and rely on the prompt's visual anchors alone.
 */
export class FalH3MaxGenerator implements ClipGenerator {
  private referenceImageUrls: string[];
  private referenceAudioUrl: string | null;

  constructor(
    falKey: string,
    private show: ShowConfig,
    fallbackRefs: { imageUrls: string[]; audioUrl: string | null },
    private _video: Config["video"],
    /** Cheap test generation: anchors-only text-to-video at 480p. */
    private testQuality = false,
  ) {
    fal.config({ credentials: falKey });
    // Show-level references win; env-level references are the fallback.
    this.referenceImageUrls = show.character.referenceImageUrls?.length
      ? show.character.referenceImageUrls
      : fallbackRefs.imageUrls;
    this.referenceAudioUrl = show.character.referenceAudioUrl ?? fallbackRefs.audioUrl;
  }

  private showLevelRefs(): SceneRefs {
    const imgs = this.referenceImageUrls
      .map((_, i) => `Image ${i + 1}`)
      .join(" and ");
    let preamble = `The person shown in ${imgs} is ${this.show.character.name}. `;
    if (this.referenceAudioUrl) {
      preamble += `${this.show.character.name}'s voice is the voice in Audio 1. `;
    }
    return { preamble, imageUrls: this.referenceImageUrls, audioUrl: this.referenceAudioUrl };
  }

  private async generate(
    prompt: string,
    durationSec: number,
    outPath: string,
    refsOverride?: SceneRefs | null,
  ): Promise<RawClip> {
    const duration = Math.min(15, Math.max(5, Math.round(durationSec)));
    const refs = refsOverride ?? this.showLevelRefs();
    const useReferences = !this.testQuality && refs.imageUrls.length > 0;
    let result: { data: { video: { url: string } } };
    if (useReferences) {
      result = (await fal.subscribe("minimax/h3-max/reference-to-video", {
        input: {
          prompt: refs.preamble + prompt,
          prompt_expansion_mode: "balanced",
          duration,
          resolution: "768P",
          aspect_ratio: "16:9",
          reference_image_urls: refs.imageUrls,
          ...(refs.audioUrl ? { reference_audio_urls: [refs.audioUrl] } : {}),
        },
      })) as { data: { video: { url: string } } };
    } else {
      result = (await fal.subscribe("minimax/h3-max/text-to-video", {
        input: {
          prompt,
          prompt_expansion_mode: "balanced",
          duration,
          resolution: this.testQuality ? "480P" : "768P",
          aspect_ratio: "16:9",
        },
      })) as { data: { video: { url: string } } };
    }

    await downloadTo(result.data.video.url, outPath);
    return { mp4Path: outPath, durationSec: duration };
  }

  async generateHostClip(riff: string, workDir: string, tag: string): Promise<RawClip> {
    // Size the clip to the line: cramming a long riff into a fixed 8s makes
    // the model rush and garble the speech (~2.3 words/sec + breathing room).
    const words = riff.trim().split(/\s+/).length;
    const duration = Math.min(15, Math.max(6, Math.ceil(words / 2.3) + 2));
    return this.generate(hostClipPrompt(this.show, riff), duration, path.join(workDir, `${tag}-host.mp4`));
  }

  async generateSceneClip(
    prompt: string,
    durationSec: number,
    workDir: string,
    tag: string,
    refs?: SceneRefs | null,
  ): Promise<RawClip> {
    return this.generate(prompt, durationSec, path.join(workDir, `${tag}-scene.mp4`), refs);
  }
}

async function downloadTo(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`clip download failed: HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(outPath));
}
