import path from "node:path";
import { ClipGenerator, RawClip } from "../types.js";
import { Config } from "../config.js";
import { renderCardClip } from "./ffmpeg.js";

/**
 * Dry-run generator: renders title-card clips with the riff/scene text so the
 * whole loop (director -> generation -> playout) runs with zero inference cost.
 */
export class StubGenerator implements ClipGenerator {
  constructor(
    private video: Config["video"],
    private hostName = "HOST",
  ) {}

  async generateHostClip(riff: string, workDir: string, tag: string): Promise<RawClip> {
    const mp4Path = path.join(workDir, `${tag}-host.mp4`);
    const durationSec = 5;
    await renderCardClip({
      text: `${this.hostName.toUpperCase()} (host):\n\n${riff}`,
      durationSec,
      outPath: mp4Path,
      video: this.video,
      background: "0x1a1a2e",
    });
    return { mp4Path, durationSec };
  }

  async generateSceneClip(
    prompt: string,
    durationSec: number,
    workDir: string,
    tag: string,
  ): Promise<RawClip> {
    const mp4Path = path.join(workDir, `${tag}-scene.mp4`);
    await renderCardClip({
      text: `SCENE:\n\n${prompt}`,
      durationSec,
      outPath: mp4Path,
      video: this.video,
      background: "0x16324f",
    });
    return { mp4Path, durationSec };
  }
}
