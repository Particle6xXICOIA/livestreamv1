import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { deleteCreatedShow, getShow, loadShows, saveCreatedShow } from "./shows.js";
import { buildComponents } from "./components.js";
import { WebChat } from "./chat/webChat.js";
import { EpisodeRunner } from "./episode/runner.js";
import {
  compileShow,
  errText,
  estimateBuildCost,
  isBuilding,
  startBuild,
  uploadBufferToFalStorage,
} from "./showBuild.js";

/**
 * The self-hosted Tilly livestream platform, one process:
 *  - GET  /?key=VIEWER_TOKEN      viewer page (player + chat)
 *  - GET  /hls/*?key=...          the live HLS stream
 *  - WS   /chat?key=...           team chat; "!prompt ..." feeds the director
 *  - POST /start | /stop          episode control (Bearer CONTROL_TOKEN)
 *  - POST /shows/create|build|delete, GET /shows/build-status, POST /uploads
 *                                 in-app show creation (Bearer CONTROL_TOKEN)
 *  - GET  /healthz                unauthenticated liveness
 */
const baseArgs = process.argv.slice(2);
const bootConfig = loadConfig(baseArgs);
const HLS_DIR = path.resolve("out/hls");
const here = path.dirname(fileURLToPath(import.meta.url));

const webChat = new WebChat();
let runner: EpisodeRunner | null = null;
let running = false;
let currentShowTitle: string | null = null;
let currentShowId: string | null = null;
let currentShowHint: string | null = null;

function statusPayload() {
  return { type: "status", live: running, showTitle: currentShowTitle, hint: currentShowHint };
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error(`body larger than ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const sockets = new Set<WebSocket>();
function broadcast(obj: unknown): void {
  const msg = JSON.stringify(obj);
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function tokenOk(provided: string | null, expected: string | null): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const VIEWER_COOKIE = "tillyview";

function cookieValue(req: http.IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * Viewer auth: the link token (?key=...) or the cookie set on page load.
 * HLS playlists reference segments by bare relative name, so segment
 * requests carry no query string — the cookie is what authorizes them
 * (and native Safari HLS can only send cookies, never custom params).
 */
function viewerOk(req: http.IncomingMessage, url: URL): boolean {
  return (
    tokenOk(url.searchParams.get("key"), bootConfig.viewerToken) ||
    tokenOk(cookieValue(req, VIEWER_COOKIE), bootConfig.viewerToken)
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && url.pathname === "/healthz") {
    return send(200, { ok: true, episodeRunning: running });
  }

  // Control plane — Bearer CONTROL_TOKEN.
  const controlPaths = ["/start", "/stop", "/uploads", "/shows/create", "/shows/build", "/shows/build-status", "/shows/delete"];
  if (controlPaths.includes(url.pathname)) {
    if (!bootConfig.controlToken) return send(503, { error: "CONTROL_TOKEN not configured" });
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokenOk(auth, bootConfig.controlToken)) return send(401, { error: "unauthorized" });

    // Creator file uploads (reference stills / voice clip) land in fal
    // storage, where the video model can fetch them — this platform itself
    // is token-gated, so it can never serve references to fal directly.
    if (req.method === "POST" && url.pathname === "/uploads") {
      if (!bootConfig.falKey) return send(503, { error: "FAL_KEY not configured" });
      const kind = url.searchParams.get("kind");
      const type = String(req.headers["content-type"] ?? "");
      if (kind === "image" ? !type.startsWith("image/") : kind === "audio" ? !type.startsWith("audio/") : true) {
        return send(400, { error: "kind must be image|audio and content-type must match" });
      }
      try {
        const body = await readBody(req, 30 * 1024 * 1024);
        if (body.length === 0) return send(400, { error: "empty body" });
        const name = (url.searchParams.get("name") ?? `upload.${kind === "image" ? "png" : "m4a"}`).replace(/[^\w.-]/g, "_");
        const uploaded = await uploadBufferToFalStorage(bootConfig.falKey, body, name, type);
        return send(200, { url: uploaded });
      } catch (err) {
        return send(500, { error: errText(err) });
      }
    }

    // Phase 1 of show creation: compile the brief into a full config (free).
    if (req.method === "POST" && url.pathname === "/shows/create") {
      if (!bootConfig.anthropicKey) return send(503, { error: "ANTHROPIC_API_KEY not configured" });
      let params: { title?: string; description?: string; imageUrls?: string[]; audioUrl?: string } = {};
      try {
        params = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}");
      } catch {
        return send(400, { error: "invalid JSON body" });
      }
      const description = String(params.description ?? "").trim();
      if (description.length < 20) return send(400, { error: "describe the show in at least a sentence or two" });
      try {
        const result = await compileShow(bootConfig.anthropicKey, {
          description,
          title: params.title?.trim() || undefined,
          uploadedImageUrls: (params.imageUrls ?? []).filter((u) => typeof u === "string").slice(0, 4),
          uploadedAudioUrl: typeof params.audioUrl === "string" && params.audioUrl ? params.audioUrl : null,
        });
        if (!result.show) return send(422, { refusal: result.refusal });
        saveCreatedShow(result.show);
        return send(200, { id: result.show.id, show: result.show, estimate: estimateBuildCost(result.show) });
      } catch (err) {
        return send(500, { error: errText(err) });
      }
    }

    // Phase 2: the paid asset build (reference stills, voice seeds, fillers).
    if (req.method === "POST" && url.pathname === "/shows/build") {
      let params: { id?: string } = {};
      try {
        params = JSON.parse((await readBody(req, 4096)).toString() || "{}");
      } catch {
        return send(400, { error: "invalid JSON body" });
      }
      try {
        const show = getShow(String(params.id ?? ""));
        if (show.origin !== "created") return send(400, { error: "built-in shows build via `npm run fillers`" });
        if (isBuilding(show.id)) return send(409, { error: "already building" });
        startBuild(show, bootConfig);
        return send(202, { building: show.id, estimate: estimateBuildCost(show) });
      } catch (err) {
        return send(400, { error: String(err) });
      }
    }

    if (req.method === "GET" && url.pathname === "/shows/build-status") {
      try {
        const show = getShow(String(url.searchParams.get("id") ?? ""));
        return send(200, { id: show.id, building: isBuilding(show.id), build: show.build ?? { status: "ready" } });
      } catch (err) {
        return send(404, { error: String(err) });
      }
    }

    if (req.method === "POST" && url.pathname === "/shows/delete") {
      let params: { id?: string } = {};
      try {
        params = JSON.parse((await readBody(req, 4096)).toString() || "{}");
      } catch {
        return send(400, { error: "invalid JSON body" });
      }
      try {
        const show = getShow(String(params.id ?? ""));
        if (isBuilding(show.id)) return send(409, { error: "show is building — wait for it to finish" });
        if (running && currentShowId === show.id) return send(409, { error: "show is on air — stop the episode first" });
        deleteCreatedShow(show);
        return send(200, { deleted: show.id });
      } catch (err) {
        return send(400, { error: String(err) });
      }
    }

    if (req.method === "POST" && url.pathname === "/start") {
      if (running) return send(409, { error: "an episode is already running" });
      let body = "";
      for await (const chunk of req) body += chunk;
      let params: { minutes?: number; cycles?: number; dryRun?: boolean; output?: string; show?: string; quality?: string } = {};
      try {
        params = body ? JSON.parse(body) : {};
      } catch {
        return send(400, { error: "invalid JSON body" });
      }
      let show;
      try {
        show = getShow(String(params.show ?? bootConfig.show));
      } catch (err) {
        return send(400, { error: String(err) });
      }
      const argv = [...baseArgs];
      // Airtime is linear inference spend — default short unless asked for more.
      argv.push("--minutes", String(params.minutes || 10));
      if (params.cycles) argv.push("--cycles", String(params.cycles));
      if (params.dryRun) argv.push("--dry-run");
      if (params.quality === "test") argv.push("--test-quality");
      const config = loadConfig(argv);
      // Default output is the built-in platform; {"output":"rtmp"} opts into
      // pushing to the configured RTMP_URL (YouTube/Twitch) instead.
      if (params.output !== "rtmp") {
        config.hlsDir = HLS_DIR;
        config.rtmpUrl = null;
        fs.rmSync(HLS_DIR, { recursive: true, force: true });
      }
      const { chat, director, generator } = buildComponents(config, show, webChat);
      runner = new EpisodeRunner(config, show, chat, director, generator);
      runner.onDecision = (decision) => {
        broadcast({
          type: "system",
          text: decision.suggestion
            ? `🎬 Staging ${decision.suggestion.username}'s suggestion: "${decision.suggestion.text}" — on screen in a minute or so.`
            : `🎬 The director invented this scene — keep the !prompt suggestions coming!`,
        });
      };
      running = true;
      currentShowTitle = show.title;
      currentShowId = show.id;
      currentShowHint = show.format.suggestionMeaning;
      broadcast(statusPayload());
      runner
        .run()
        .catch((err) => console.error("[server] episode crashed:", err))
        .finally(() => {
          running = false;
          runner = null;
          currentShowTitle = null;
          currentShowId = null;
          currentShowHint = null;
          broadcast(statusPayload());
        });
      return send(202, {
        started: true,
        show: show.id,
        minutes: config.episodeMinutes,
        quality: config.testQuality ? "test (480p, no references)" : "full (reference-to-video)",
        output: config.hlsDir ? "platform (HLS)" : config.rtmpUrl ? "rtmp" : "local file",
      });
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      if (!runner) return send(409, { error: "no episode running" });
      runner.requestStop();
      return send(202, { stopping: true });
    }
    return send(405, { error: "method not allowed" });
  }

  // Viewer plane — shared link token (?key=...) or the cookie it sets.
  if (!bootConfig.viewerToken) return send(503, { error: "VIEWER_TOKEN not configured" });
  if (!viewerOk(req, url)) {
    return send(401, { error: "missing or wrong key" });
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Segment/WS requests authorize via this cookie (see viewerOk).
      "set-cookie": `${VIEWER_COOKIE}=${encodeURIComponent(bootConfig.viewerToken)}; Path=/; SameSite=Lax; Max-Age=2592000`,
    });
    return res.end(fs.readFileSync(path.join(here, "web/viewer.html")));
  }

  if (req.method === "GET" && url.pathname === "/hls.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=86400" });
    return res.end(fs.readFileSync(path.join(here, "web/vendor/hls.min.js")));
  }

  // Archived episode recordings (episode.mp4 + log), persisted under
  // DATA_DIR/episodes by the runner and pruned to ARCHIVE_MAX_GB.
  if (req.method === "GET" && url.pathname === "/episodes") {
    const root = path.join(bootConfig.outDir, "episodes");
    const episodes = [];
    if (fs.existsSync(root)) {
      for (const id of fs.readdirSync(root).sort().reverse().slice(0, 50)) {
        const dir = path.join(root, id);
        if (!fs.statSync(dir).isDirectory()) continue;
        const entry: Record<string, unknown> = { id };
        try {
          const log = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").slice(0, 1_000_000);
          for (const line of log.split("\n")) {
            if (!line) continue;
            const ev = JSON.parse(line);
            if (ev.type === "episode_start") {
              entry.show = ev.show;
              entry.dryRun = ev.dryRun;
              entry.startedAt = ev.t;
            }
            if (ev.type === "recording_saved") {
              entry.durationSec = ev.durationSec;
              entry.sizeMB = ev.sizeMB;
            }
          }
        } catch {}
        entry.hasVideo = fs.existsSync(path.join(dir, "episode.mp4"));
        episodes.push(entry);
      }
    }
    return send(200, { episodes });
  }

  const episodeFile = url.pathname.match(/^\/episodes\/([\w.-]+)\/(episode\.mp4|log\.jsonl)$/);
  if (req.method === "GET" && episodeFile) {
    const file = path.join(bootConfig.outDir, "episodes", episodeFile[1], episodeFile[2]);
    if (!fs.existsSync(file)) return send(404, { error: "not found" });
    const type = file.endsWith(".mp4") ? "video/mp4" : "application/jsonl";
    const size = fs.statSync(file).size;
    // Single-range support so browsers can seek within the mp4.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        "content-type": type,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    return fs.createReadStream(file).pipe(res);
  }

  if (req.method === "GET" && url.pathname === "/shows") {
    return send(200, {
      shows: [...loadShows().values()].map((s) => ({
        id: s.id,
        title: s.title,
        origin: s.origin ?? "builtin",
        status: isBuilding(s.id) ? "building" : (s.build?.status ?? "ready"),
      })),
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/hls/")) {
    const name = path.basename(url.pathname); // flatten: no traversal
    const file = path.join(HLS_DIR, name);
    if (!fs.existsSync(file)) return send(404, { error: "not live yet" });
    res.writeHead(200, {
      "content-type": name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
      "cache-control": "no-store",
    });
    return fs.createReadStream(file).pipe(res);
  }

  send(404, { error: "not found" });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/chat" || !viewerOk(req, url)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify(statusPayload()));
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      let msg: { name?: string; text?: string } = {};
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const name = String(msg.name ?? "").slice(0, 40).trim() || "someone";
      const text = String(msg.text ?? "").slice(0, 300).trim();
      if (!text) return;
      broadcast({ type: "chat", name, text, at: Date.now() });
      if (text.toLowerCase().startsWith("!prompt ")) {
        const suggestion = text.slice("!prompt ".length).trim();
        if (!suggestion) return;
        if (running) {
          webChat.push(name, suggestion);
          broadcast({
            type: "system",
            text: `🦩 Suggestion received: "${suggestion}" (${name}) — the director sees it at the next cycle.`,
          });
        } else {
          broadcast({ type: "system", text: `🦩 No episode is live right now — suggestions land when the show is on.` });
        }
      }
    });
  });
});

server.listen(bootConfig.port, () => {
  console.log(`[server] Tilly platform listening on :${bootConfig.port}`);
  console.log(`[server] control: ${bootConfig.controlToken ? "enabled" : "DISABLED (set CONTROL_TOKEN)"}`);
  console.log(`[server] viewer:  ${bootConfig.viewerToken ? "enabled" : "DISABLED (set VIEWER_TOKEN)"}`);
});
