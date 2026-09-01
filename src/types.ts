export interface Suggestion {
  id: string;
  username: string;
  text: string;
  at: number; // epoch ms
}

/** What the show director decides for one cycle of the improv loop. */
export interface CycleDecision {
  /** The chat suggestion being played, or null when the director invented one. */
  suggestion: Suggestion | null;
  /** Tilly's spoken host riff introducing the scene (this is her dialogue, verbatim). */
  hostRiff: string;
  /** Full generation prompt for the acted-out scene. */
  scenePrompt: string;
  /** 5-15 seconds. */
  sceneDurationSec: number;
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
  }): Promise<CycleDecision>;
}

export interface RawClip {
  /** Path to the generated mp4 (pre-normalization). */
  mp4Path: string;
  durationSec: number;
}

export interface ClipGenerator {
  /** Tilly in host mode, speaking the riff to camera. */
  generateHostClip(riff: string, workDir: string, tag: string): Promise<RawClip>;
  /** Tilly acting out the scene. */
  generateSceneClip(prompt: string, durationSec: number, workDir: string, tag: string): Promise<RawClip>;
}
