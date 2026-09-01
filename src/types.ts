export interface Suggestion {
  id: string;
  username: string;
  text: string;
  at: number; // epoch ms
}

/** What the show director decides for one cycle of the loop. */
export interface CycleDecision {
  /** The chat suggestion being played, or null when the director invented one. */
  suggestion: Suggestion | null;
  /** The host's spoken riff introducing the scene — empty string on shows with no host segments. */
  hostRiff: string;
  /** Full generation prompt for the acted-out scene. */
  scenePrompt: string;
  /** 5-15 seconds. */
  sceneDurationSec: number;
  /** Names of cast-roster members appearing in the scene (empty when the show has no cast). */
  castNames: string[];
  /** The rewritten show state after this cycle, or null on shows that track none. */
  updatedState: string | null;
  /** Suggestions the director declined on safety grounds this cycle (logged, never aired). */
  declined: { username: string; text: string; reason: string }[];
}

export type ClipKind = "opening" | "host" | "scene" | "filler" | "closing";

export interface Clip {
  /** Path to a normalized MPEG-TS file ready for playout. */
  tsPath: string;
  durationSec: number;
  kind: ClipKind;
  label: string;
}

export interface ChatSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Drain suggestions received since the last call. */
  drainSuggestions(): Suggestion[];
}

export interface Director {
  decide(input: {
    suggestions: Suggestion[];
    /** Labels of recent cycles, so the director avoids repeating itself. */
    recentCycles: string[];
    cycleNumber: number;
    /** Running show state (scores, story progress) — null on stateless shows. */
    showState: string | null;
  }): Promise<CycleDecision>;
}

export interface RawClip {
  /** Path to the generated mp4 (pre-normalization). */
  mp4Path: string;
  durationSec: number;
}

/**
 * Per-clip reference override for multi-character scenes: which reference
 * images/audio condition this generation, and the preamble that binds them
 * to named characters. Empty imageUrls means "generate prompt-only".
 */
export interface SceneRefs {
  preamble: string;
  imageUrls: string[];
  audioUrl: string | null;
}

export interface ClipGenerator {
  /** The host speaking the riff to camera, using the show's default references. */
  generateHostClip(riff: string, workDir: string, tag: string): Promise<RawClip>;
  /** An acted-out scene; refs (when given) override the show-level references. */
  generateSceneClip(
    prompt: string,
    durationSec: number,
    workDir: string,
    tag: string,
    refs?: SceneRefs | null,
  ): Promise<RawClip>;
}
