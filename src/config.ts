import { DATA_DIR } from "./shows.js";

export interface Config {
  dryRun: boolean;
  /** Which show config (shows/<id>.json) this episode runs. */
  show: string;
  /**
   * Cheap test generation: prompt-anchors-only text-to-video at 480p
   * (~$0.0125/s promo vs $0.08/s for reference-to-video). No likeness/voice
   * references — for plumbing and pacing tests, never for real episodes.
   */
  testQuality: boolean;
  episodeMinutes: number;
  /** Estimated-spend cap per episode in USD; generation stops when reached. <=0 = uncapped. */
  episodeBudgetUsd: number;
  /** Hard cap on improv cycles; useful for cheap smoke tests. */
  maxCycles: number;
  /** How many cycles may generate concurrently (pipelining). */
  maxConcurrentCycles: number;
  /** Stop starting new generations while this many seconds of content are buffered. */
  bufferTargetSec: number;
  /** Root for per-episode archives (recordings, clips, logs) — under DATA_DIR so they persist. */
  outDir: string;
  /** Total size cap for archived episodes; oldest are pruned past it. */
  archiveMaxGB: number;
  rtmpUrl: string | null;
  /** When set, playout writes HLS into this directory instead of RTMP/file. */
  hlsDir: string | null;
  twitchChannel: string | null;
  youtubeApiKey: string | null;
  youtubeVideoId: string | null;
  falKey: string | null;
  anthropicKey: string | null;
  /** Bearer token for the control endpoints (/start, /stop). */
  controlToken: string | null;
  /** Shared link token gating the viewer page, HLS, and chat. */
  viewerToken: string | null;
  port: number;
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
    show: String(flags.get("show") ?? env.SHOW ?? "tilly-improv"),
    testQuality: flags.has("test-quality"),
    episodeMinutes: Number(flags.get("minutes") ?? env.EPISODE_MINUTES ?? 30),
    // Airtime is linear inference spend (~$4.80/full-quality minute), so
    // every episode carries a dollar cap unless explicitly raised.
    episodeBudgetUsd: Number(flags.get("budget") ?? env.EPISODE_BUDGET_USD ?? 5),
    maxCycles: Number(flags.get("cycles") ?? Infinity),
    maxConcurrentCycles: Number(flags.get("concurrency") ?? env.MAX_CONCURRENT_CYCLES ?? 2),
    bufferTargetSec: Number(flags.get("buffer") ?? env.BUFFER_TARGET_SEC ?? 45),
    outDir: String(flags.get("out") ?? env.ARCHIVE_DIR ?? DATA_DIR),
    archiveMaxGB: Number(flags.get("archive-gb") ?? env.ARCHIVE_MAX_GB ?? 4),
    rtmpUrl: (flags.get("rtmp") as string) ?? env.RTMP_URL ?? null,
    hlsDir: (flags.get("hls") as string) ?? null,
    twitchChannel: (flags.get("channel") as string) ?? env.TWITCH_CHANNEL ?? null,
    youtubeApiKey: env.YOUTUBE_API_KEY ?? null,
    youtubeVideoId: (flags.get("youtube-video") as string) ?? env.YOUTUBE_VIDEO_ID ?? null,
    falKey: env.FAL_KEY ?? null,
    anthropicKey: env.ANTHROPIC_API_KEY ?? null,
    tillyReferenceImageUrls: (env.TILLY_REFERENCE_IMAGE_URLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    tillyReferenceAudioUrl: env.TILLY_REFERENCE_AUDIO_URL || null,
    controlToken: env.CONTROL_TOKEN || null,
    viewerToken: env.VIEWER_TOKEN || null,
    port: Number(env.PORT ?? 8080),
    video: { width: 1280, height: 720, fps: 30, vBitrateK: 2500 },
  };
}
