import { ChatSource, Suggestion } from "../types.js";

/**
 * Reads suggestions from a YouTube Live broadcast's chat — including UNLISTED
 * broadcasts — using a plain API key (no OAuth): videos.list resolves the
 * activeLiveChatId, then liveChat/messages is polled at the interval YouTube
 * asks for. Only messages starting with "!prompt " count as suggestions.
 */
export class YouTubeChat implements ChatSource {
  private pending: Suggestion[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private liveChatId: string | null = null;
  private pageToken: string | undefined;
  private stopped = false;

  constructor(
    private apiKey: string,
    private videoId: string,
  ) {}

  async start(): Promise<void> {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "liveStreamingDetails");
    url.searchParams.set("id", this.videoId);
    url.searchParams.set("key", this.apiKey);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`youtube videos.list failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      items?: { liveStreamingDetails?: { activeLiveChatId?: string } }[];
    };
    this.liveChatId = data.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
    if (!this.liveChatId) {
      throw new Error(
        `no active live chat on video ${this.videoId} — is the broadcast live (or at least in 'waiting' state)?`,
      );
    }
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.liveChatId) return;
    let waitMs = 5_000;
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
      url.searchParams.set("liveChatId", this.liveChatId);
      url.searchParams.set("part", "snippet,authorDetails");
      url.searchParams.set("key", this.apiKey);
      if (this.pageToken) url.searchParams.set("pageToken", this.pageToken);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`liveChat/messages failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        nextPageToken?: string;
        pollingIntervalMillis?: number;
        items?: {
          id: string;
          snippet?: { displayMessage?: string };
          authorDetails?: { displayName?: string };
        }[];
      };
      // The first page is backlog from before the episode — don't replay it.
      const isBacklog = !this.pageToken;
      this.pageToken = data.nextPageToken;
      waitMs = Math.max(2_000, Number(data.pollingIntervalMillis) || 5_000);
      if (!isBacklog) {
        for (const item of data.items ?? []) {
          const message = (item.snippet?.displayMessage ?? "").trim();
          if (!message.toLowerCase().startsWith("!prompt ")) continue;
          const text = message.slice("!prompt ".length).trim();
          if (!text) continue;
          this.pending.push({
            id: item.id,
            username: item.authorDetails?.displayName ?? "someone",
            text: text.slice(0, 300),
            at: Date.now(),
          });
        }
      }
    } catch (err) {
      console.warn("[youtube-chat]", String(err));
      waitMs = 10_000; // transient API errors shouldn't kill the show
    }
    this.timer = setTimeout(() => void this.poll(), waitMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  drainSuggestions(): Suggestion[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
