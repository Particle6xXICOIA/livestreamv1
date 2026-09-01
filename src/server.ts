import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { buildComponents } from "./components.js";
import { WebChat } from "./chat/webChat.js";
import { EpisodeRunner } from "./episode/runner.js";

/**
 * The self-hosted Tilly livestream platform, one process:
 *  - GET  /?key=VIEWER_TOKEN      viewer page (player + chat)
 *  - GET  /hls/*?key=...          the live HLS stream
 *  - WS   /chat?key=...           team chat; "!prompt ..." feeds the director
 *  - POST /start | /stop          episode control (Bearer CONTROL_TOKEN)
 *  - GET  /healthz                unauthenticated liveness
 */
const baseArgs = process.argv.slice(2);
const bootConfig = loadConfig(baseArgs);
const HLS_DIR = path.resolve("out/hls");
const here = path.dirname(fileURLToPath(import.meta.url));

const webChat = new WebChat();
let runner: EpisodeRunner | null = null;
let running = false;

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
  if (url.pathname === "/start" || url.pathname === "/stop") {
    if (!bootConfig.controlToken) return send(503, { error: "CONTROL_TOKEN not configured" });
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokenOk(auth, bootConfig.controlToken)) return send(401, { error: "unauthorized" });

    if (req.method === "POST" && url.pathname === "/start") {
      if (running) return send(409, { error: "an episode is already running" });
      let body = "";
      for await (const chunk of req) body += chunk;
      let params: { minutes?: number; cycles?: number; dryRun?: boolean; output?: string } = {};
      try {
        params = body ? JSON.parse(body) : {};
      } catch {
        return send(400, { error: "invalid JSON body" });
      }
      const argv = [...baseArgs];
      // Airtime is linear inference spend — default short unless asked for more.
      argv.push("--minutes", String(params.minutes || 10));
      if (params.cycles) argv.push("--cycles", String(params.cycles));
      if (params.dryRun) argv.push("--dry-run");
      const config = loadConfig(argv);
      // Default output is the built-in platform; {"output":"rtmp"} opts into
      // pushing to the configured RTMP_URL (YouTube/Twitch) instead.
      if (params.output !== "rtmp") {
        config.hlsDir = HLS_DIR;
        config.rtmpUrl = null;
        fs.rmSync(HLS_DIR, { recursive: true, force: true });
      }
      const { chat, director, generator } = buildComponents(config, webChat);
      runner = new EpisodeRunner(config, chat, director, generator);
      running = true;
      broadcast({ type: "status", live: true });
      runner
        .run()
        .catch((err) => console.error("[server] episode crashed:", err))
        .finally(() => {
          running = false;
          runner = null;
          broadcast({ type: "status", live: false });
        });
      return send(202, {
        started: true,
        minutes: config.episodeMinutes,
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

  // Viewer plane — shared link token (?key=...).
  if (!bootConfig.viewerToken) return send(503, { error: "VIEWER_TOKEN not configured" });
  if (!tokenOk(url.searchParams.get("key"), bootConfig.viewerToken)) {
    return send(401, { error: "missing or wrong key" });
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(here, "web/viewer.html")));
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
  if (url.pathname !== "/chat" || !tokenOk(url.searchParams.get("key"), bootConfig.viewerToken)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "status", live: running }));
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
        if (suggestion && running) webChat.push(name, suggestion);
      }
    });
  });
});

server.listen(bootConfig.port, () => {
  console.log(`[server] Tilly platform listening on :${bootConfig.port}`);
  console.log(`[server] control: ${bootConfig.controlToken ? "enabled" : "DISABLED (set CONTROL_TOKEN)"}`);
  console.log(`[server] viewer:  ${bootConfig.viewerToken ? "enabled" : "DISABLED (set VIEWER_TOKEN)"}`);
});
