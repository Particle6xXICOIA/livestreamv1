# Tilly Live — Handoff

A private, self-hosted livestream platform where AI characters host live shows
and viewers direct them from chat. This is the operating handoff; the full
version with access links/tokens lives in a private Claude artifact ("Tilly
Live Handoff") owned by Mark — tokens are NEVER committed here (public repo).

## Quick access

- **Platform**: `https://tilly-platform-production.up.railway.app`
  - Viewer page: `/?key=<VIEWER_TOKEN>` (watch, chat, `!prompt` suggestions)
  - Producer controls: append `&ctl=<CONTROL_TOKEN>` (Start/Stop, show picker,
    minutes, cycle cap, test-$ toggle)
  - Both tokens: Railway → tilly-livestream → tilly-platform → Variables
- **Hosting**: Railway project `tilly-livestream`, service `tilly-platform`
  (Dockerfile build, `/healthz` healthcheck). Merge to `main` auto-deploys.
- **Spend**: fal.ai billing dashboard — video generation is the only
  meaningful cost.

## The pipeline

viewer chat `!prompt` → show director (Claude, `src/director/claudeDirector.ts`)
→ MiniMax H3 Max on fal (`src/generation/falGenerator.ts`) → ffmpeg → HLS
(`src/playout/playout.ts`) → token-gated viewer page (`src/server.ts` +
`src/web/viewer.html`).

One episode at a time. Everything private behind link tokens; nothing touches
Twitch/YouTube unless `/start` gets `{"output":"rtmp"}` (pushes to `RTMP_URL`;
`YouTubeChat` can read an unlisted broadcast's chat via `YOUTUBE_API_KEY` +
`YOUTUBE_VIDEO_ID`) — that path is built but untested end-to-end.

## Running a show

Producer page → pick show → minutes (default 10) / optional cycle cap →
Start. ~90s of "warming up" (opener + first scene buffer), then continuous
video. **Stop ends gracefully**: buffered + in-flight content airs, then the
sign-off — the stream may continue 1–2 minutes after clicking (a stop during
warm-up cancels outright).

**Every episode has a spend cap — default $5** (producer "$ cap" field /
`{"budget": N}` on /start / `EPISODE_BUDGET_USD`; 0 = uncapped). The
generator charges a conservative estimate per clip at submit time
($0.08/s full, $0.05/s test) and the loop refuses any cycle whose
worst-case cost would cross the cap, so the cap is a true ceiling — the
show then airs what's buffered and closes. The producer panel shows the
running ~$ estimate while live. Context: full quality ≈ $4.80/min, so the
old default (10 min, no cap) cost ~$48 per Start — the cap exists because
exactly that happened on 1 Sep 2026 (~$80 day). Raising it is a per-Start,
deliberate act. Dry runs are never capped (they're free).

| Mode | How | Cost / on-air minute |
|---|---|---|
| Dry run | `{"dryRun": true}` | $0 (title cards, full loop) |
| Test $ | producer checkbox | ~$0.75 (480p, prompt-only likeness; ~$3 after 7 Sep 2026) |
| Full | default | ~$4.80 (reference-conditioned, 768p, flat $0.08/s) |

Suggestions: only `!prompt ...` messages reach the director; chat acknowledges
capture (🦩) and staging (🎬). Prompt-to-screen latency is 60–120s by design
(next cycle + generation + smoothness buffer).

CLI: `curl -X POST <host>/start -H "Authorization: Bearer $CONTROL_TOKEN" -H
"content-type: application/json" -d '{"minutes":10,"show":"tilly-improv"}'`
and `<host>/stop`.

## Shows are JSON

`shows/<id>.json` defines character (visual anchors + fal reference URLs),
premise, voice guide, scene instructions, set, opening/closing, filler
prompts. Live: `tilly-improv` (has filler library + cached segments),
`tilly-agony-aunt`, `tilly-interviews` (fillers not yet generated for those
two). New show: copy `shows/_template.json`. New character: 1–4 stills
(~1024px) + 5–15s clean voice clip → fal storage URLs → then
`npm run fillers -- --show <id>` once (~$4).

The schema also supports (all optional, compiled automatically by in-app
creation below): `cast` — extra recurring characters, each with their own
references; the director picks who appears per scene (max 2) and that clip
generates against their reference stills. `format.interactionRules` — what
`!prompt` messages mean beyond scene ideas (votes, environment nudges,
director's notes). `format.stateInstructions` + `persistState` — a compact
state summary the director rewrites every cycle (leaderboards, story
progress), persisted under `DATA_DIR/state/<id>.json` across streams when
`persistState` is true. `format.hostRiffs: false` — no spoken host segments
(e.g. an animal lead); cycles air scenes only and opening/closing are
skipped.

## Creating shows in-app

Producer page → **＋ New show**: describe any livestream experience in free
text, optionally attach reference images and a voice clip (they upload to
fal storage), then:

1. **Compile (free)** — `POST /shows/create` has Claude write the full show
   config (cast, chat rules, state tracking, fillers…). The draft saves to
   `DATA_DIR/shows/<id>.json`, appears in the show picker immediately, and
   can be aired with the **dry** checkbox for a $0 preview of the loop.
2. **Generate assets (paid, ~$2–8)** — `POST /shows/build` mints one
   canonical reference still per character that lacks one (flux on fal),
   seeds a reference voice for speaking characters (one short
   reference-to-video clip → audio track extracted → fal storage), then
   generates the filler library + cached opening/closing. Consistency is
   OPTIONAL: the dialog's "consistent looks"/"consistent voices" checkboxes
   (`stills`/`voices` on /shows/build, both default true) can be unticked to
   let the model draw/voice each character fresh per clip — cheaper, and a
   legitimate aesthetic for stylized ensembles; voice seeds need stills or
   uploaded images. Progress polls via `GET /shows/build-status?id=`; failed
   builds save their error and retry from where they left off.
   `POST /shows/delete` removes a created show.

Created shows never fall back to the env-level Tilly references — missing
references generate prompt-only rather than borrowing her likeness.

**Durability**: created shows, their assets, and persistent state live under
`DATA_DIR` (default `data/`, gitignored). In production this is DONE (1 Sep
2026): Railway volume `tilly-data` is mounted at `/data` on `tilly-platform`
with `DATA_DIR=/data`, so created shows survive redeploys. The volume is
tied to that service — deleting the volume/service loses them; there is no
independent backup yet (a cron rsync to R2 is the cheap upgrade if the
library grows precious). Episode recordings also live here (see "Secrets &
env" section above), size-capped by `ARCHIVE_MAX_GB`.

## Secrets & env

`FAL_KEY`, `ANTHROPIC_API_KEY`, `CONTROL_TOKEN`, `VIEWER_TOKEN`,
`TILLY_REFERENCE_IMAGE_URLS`, `TILLY_REFERENCE_AUDIO_URL` — set in Railway
service variables AND the Claude Code cloud environment (so fresh Claude
sessions can run real generation). Never commit values; this repo is public.

Every episode is recorded: playout tees the exact aired stream to disk and
the runner finalizes it to `episode.mp4` (plus `log.jsonl` and the raw
generated clip mp4s) under `DATA_DIR/episodes/<timestamp>/` — on the Railway
volume in production, so recordings survive redeploys. Producer page →
**Episodes** lists them with watch/download/log links (`GET /episodes`,
`GET /episodes/<id>/episode.mp4`, viewer-token gated, seekable via Range).
The archive is capped at `ARCHIVE_MAX_GB` (default 4): oldest episodes are
pruned after each show, so download anything precious — or raise the cap
and grow the volume as the library builds.

## Hard-won fixes — do not re-break

1. **Continuous clip timestamps**: every clip is remuxed into playout with a
   running `-output_ts_offset`; raw TS byte-concatenation glitches players at
   every clip boundary (non-monotonic DTS).
2. **HLS segments authorize via cookie** (set on page load) — playlists
   reference segments without query strings, so `?key=` alone 401s them.
3. **Muted autoplay + tap-for-sound**, and the player only attaches after a
   ~16s segment runway — attaching at playlist birth starves at the live edge
   (grey screen until refresh).
4. **Host clip duration scales with the riff** (~2.3 words/sec, riffs capped
   at 25 words) — fixed-length clips made the model rush and garble speech.
5. **Deferred go-live**: the stream starts only once the opener + cycle 1 are
   buffered; per-show fillers/cached segments cover generation gaps.
6. **hls.js is self-hosted at `/hls.js`** — CDN-blocked viewers previously got
   a silent dead player.

## Known limits / next moves

- Latency is architectural (60–120s); tunable to ~45–60s via shorter scenes +
  smaller buffer at filler risk. Seconds-level reaction = frame-streaming
  approach (different show format).
- Self-hosting open H3 weights is licence-blocked in the UK/EU/US (covers
  outputs too); ~10–20× cheaper at volume if MiniMax grants a territory
  licence. The hosted fal API is unrestricted.
- reference-to-video has NO cheap 480p tier — that's why test mode drops
  references.
- Stop is graceful, not instant (see above); a hard-stop option is a possible
  addition.
- Generate filler libraries for `tilly-agony-aunt` and `tilly-interviews`;
  add the first non-Tilly character.
- **fal balance is EXHAUSTED (as of 1 Sep 2026)** — the account is locked,
  so uploads, asset builds, and real-quality episodes all fail with 403
  "User is locked" until Mark tops up at fal.ai/dashboard/billing. Compiling
  shows and dry runs still work (they only need the Anthropic key).
- In-app creation: the flux reference-still endpoint (`fal-ai/flux/dev`) has
  not been exercised end-to-end yet (fal balance was exhausted at build
  time) — the first real asset build verifies it; a failure lands in the
  build log and the build is retryable. Everything else was validated with
  local dry runs of two representative created shows (multi-cast voting;
  riff-less persistent journey) and a browser pass over the producer UI.

## Working on this with Claude

Start sessions on `Particle6xXICOIA/livestreamv1` (sessions inherit the
environment's keys — note ANTHROPIC_API_KEY is Railway-only, not in the
Claude environment, so test the compiler against the deployed platform).
Convention: one `claude/*` feature branch per session, PR per change, merge
auto-deploys. Railway infra changes (volumes, variables) can be made from
sessions via the Railway MCP tools.
Verify player-facing changes in a real browser — CI-container Chromium can't
decode H.264. Dry runs are free; use them for everything that isn't about
picture quality.
