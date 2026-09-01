export interface Config {
  dryRun: boolean;
  episodeMinutes: number;
  /** Hard cap on improv cycles; useful for cheap smoke tests. */
  maxCycles: number;
  /** How many cycles may generate concurrently (pipelining). */
  maxConcurrentCycles: number;
  /** Stop starting new generations while this many seconds of content are buffered. */
  bufferTargetSec: number;
  outDir: string;
  rtmpUrl: string | null;
  twitchChannel: string | null;
  falKey: string | null;
  anthropicKey: string | null;
  tillyReferenceImageUrls: string[];
  tillyReferenceAudioUrl: string | null;
  /** Playout video settings — every clip is normalized to these before streaming. */
  video: { width: number; height: number; fps: number; vBitrateK: number };
}

export function loadConfig(argv: string[]): Config {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }

  const env = process.env;
  return {
    dryRun: flags.has("dry-run"),
    episodeMinutes: Number(flags.get("minutes") ?? env.EPISODE_MINUTES ?? 30),
    maxCycles: Number(flags.get("cycles") ?? Infinity),
    maxConcurrentCycles: Number(flags.get("concurrency") ?? env.MAX_CONCURRENT_CYCLES ?? 2),
    bufferTargetSec: Number(flags.get("buffer") ?? env.BUFFER_TARGET_SEC ?? 45),
    outDir: String(flags.get("out") ?? "out"),
    rtmpUrl: (flags.get("rtmp") as string) ?? env.RTMP_URL ?? null,
    twitchChannel: (flags.get("channel") as string) ?? env.TWITCH_CHANNEL ?? null,
    falKey: env.FAL_KEY ?? null,
    anthropicKey: env.ANTHROPIC_API_KEY ?? null,
    tillyReferenceImageUrls: (env.TILLY_REFERENCE_IMAGE_URLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    tillyReferenceAudioUrl: env.TILLY_REFERENCE_AUDIO_URL || null,
    video: { width: 1280, height: 720, fps: 30, vBitrateK: 2500 },
  };
}
