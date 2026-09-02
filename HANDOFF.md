# Tilly Live — Handoff

A private, self-hosted livestream platform where AI characters host live shows
and viewers direct them from chat. This is the operating handoff; the full
version with access links/tokens lives in a private Claude artifact ("Tilly
Live Handoff") owned by Mark — tokens are NEVER committed here (public repo).

## Quick access

- **Platform**: `https://tilly-platform-production.up.railway.app`
  - Viewer page: `/?key=<VIEWER_TOKEN>` (watch, chat, `!prompt` suggestions)
  - Producer controls: append `&ctl=<CONTROL_TOKEN>` (Start/Stop, show picker,
    minutes, cycle cap, $ cap, test-$/dry toggles, ＋ New show, Episodes,
    live ~$ spend readout)
  - Both tokens: Railway → tilly-livestream → tilly-platform → Variables
- **Hosting**: Railway project `tilly-livestream`, service `tilly-platform`
  (Dockerfile build, `/healthz` healthcheck). Merge to `main` auto-deploys.
- **Spend**: fal.ai billing dashboard — video generation is the only
  meaningful cost.

## Where things stand (end of 1 Sep 2026 session)

Deployed to production (PRs #14–#17, all merged, deploys green): in-app show
creation, the durable `tilly-data` volume at `/data`, episode recordings with
the producer Episodes dialog, the $5-per-episode spend cap, and optional
consistency (stills/voices) on asset builds.

**Awaiting review (overnight session, branch `claude/code-review-clarify-67fft3`,
NOT merged):** the hardening pass — generation/director timeouts, playout
failure isolation, director backoff, hard stop, daily spend cap, disk gate,
orphan-recording recovery, producer live readout, chat history + rate limit,
cookie/token hygiene, a 27-test suite (`npm test`) and GitHub Actions CI. All
validated with dry runs and a local server session; nothing player-facing in
the HLS attach path was touched. Review, merge, then confirm the first deploy
logs `[server] spend: $5/episode, $25/day` and `/healthz` returns `episode`.

Pending, in order:

1. **Mark tops up fal** (account locked: exhausted balance after an ~$80 day
   — see the spend-cap section for what happened). Until then: compiling
   shows and dry runs work; uploads, asset builds, and paid episodes 403.
2. **First real asset build** — Mark compiled an "Infinite Monkeys" draft on
   the production volume (host monkey + six pitchers, vote leaderboard). It
   awaits its build; this also exercises `fal-ai/flux/dev` for the first
   time. The consistency checkboxes appear in the dialog only after a
   Compile, so for this existing draft either build via
   `POST /shows/build {"id":..., "stills":bool, "voices":bool}` or
   re-compile and delete the old draft.
3. **First real created-show episode** — remember $5 cap ≈ ~1 min full
   quality; raise "$ cap" deliberately for a longer show.

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

**Every UTC day has a cap too — default $25** (`DAILY_BUDGET_USD`, Railway
var; 0 = uncapped). Every estimated charge is appended to
`DATA_DIR/spend/<YYYY-MM-DD>.json` as it happens, so it survives crashes and
counts CLI episodes as well. `/start` refuses with 402 once the day is
spent, and a paid episode's own cap is tightened to what is left; the
producer panel shows "$N left today". Raising it means editing the Railway
variable — deliberately.

**Two ways to stop.** *Stop* is graceful (above). *Hard stop* (producer
button / `/stop {"hard":true}` / second Ctrl-C on the CLI) abandons in-flight
generation and cuts the stream within seconds; the partial recording is still
finalized. Use it when a show goes wrong on air.

**Latency knobs (producer "buf s" / "par", or `bufferSec` / `concurrency` on
/start).** Default 45s buffer, 2 parallel cycles. Chat-to-screen latency is
roughly one cycle plus the buffer, so a smaller buffer is the lever — but
fillers air whenever generation falls behind it. Every episode's
`episode_end` log line now carries `timing.generationMs.p95` and
`directorMs.p95`: lower the buffer only when p95 generation is comfortably
under the buffered seconds you keep. Each cycle is up to two fal requests, so
"par 2" means four concurrent fal calls; new fal accounts allow only 2
concurrent requests (excess queues, inflating generation time) — check the
account limit in the fal dashboard before raising it.

**Output screen.** Every director decision is read by Haiku 4.5 against the
platform's content rules before any generation is paid for
(`src/director/screener.ts`); a refusal drops the cycle (`screened_out` in
the log, fillers cover it). Screener errors fail open with a `screen_error`
log line — flip that to fail-closed before any public broadcast.
`OUTPUT_SCREEN=off` disables it. Rationale: every AI stream that got banned
failed on the output side, not the chat side.

**When the queue runs dry** the playout interleaves the show's filler library
with reruns of scene clips that aired ≥4 minutes earlier this episode
(`src/playout/fillerRotation.ts`) — free and on-theme.

**What the producer panel shows while live:** `~$spend · $left today`, then
`c<cycle> · <sec> buffered · <n> generating`, and the last error (timeouts,
director failures, disk) in red — the same snapshot `/healthz` returns under
`episode`.

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
As of 1 Sep 2026 the Claude environment has `FAL_KEY` and the Tilly
references but NOT `ANTHROPIC_API_KEY` — add it there if sessions should be
able to exercise the director/compiler locally.

Optional guards (all have safe defaults, see `.env.example`):
`EPISODE_BUDGET_USD` (5), `DAILY_BUDGET_USD` (25), `ARCHIVE_MAX_GB` (2),
`MIN_FREE_GB` (1), `GENERATION_TIMEOUT_SEC` (240), `DIRECTOR_TIMEOUT_SEC` (90).

Every episode is recorded: playout tees the exact aired stream to disk and
the runner finalizes it to `episode.mp4` (plus `log.jsonl` and the raw
generated clip mp4s) under `DATA_DIR/episodes/<timestamp>/` — on the Railway
volume in production, so recordings survive redeploys. Producer page →
**Episodes** lists them with watch/download/log links (`GET /episodes`,
`GET /episodes/<id>/episode.mp4`, viewer-token gated, seekable via Range).
The archive is capped at `ARCHIVE_MAX_GB` (default 2, lowered from 4 because
the volume is assumed to be 5 GB): oldest episodes are pruned BEFORE each
show starts (so the new recording has room) and again after, and `/start`
refuses with 507 when less than `MIN_FREE_GB` (1) is free — a recording that
fills the volume mid-show would take ffmpeg down with it. A running show
also ends gracefully if free space drops under the threshold. Download
anything precious, or raise the cap and grow the volume as the library
builds. A restart mid-episode leaves `stream.ts` behind; the server
finalizes such orphans to `episode.mp4` at boot.

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
7. **Every external wait has a timeout** (`GENERATION_TIMEOUT_SEC`,
   `DIRECTOR_TIMEOUT_SEC`). Without one, a hung fal job blocked air order
   forever and left the server "running" until a redeploy. A timed-out cycle
   releases as zero clips; fillers cover it; the fal work is simply ignored.
8. **Playout failures never escape as unhandled rejections.** The pump
   promise reports through `Playout.onError`; the runner ends the episode
   and finalizes the recording. Before this, a remux error mid-show could
   crash the whole platform process (Node exits on unhandled rejections).
9. **Director errors back off** (5s → 60s) and carry the drained chat into
   the next attempt — never a hot loop against the API, never lost
   suggestions.

## Known limits / next moves

- Latency is architectural (60–120s); tunable to ~45–60s via shorter scenes +
  smaller buffer at filler risk. Seconds-level reaction = frame-streaming
  approach (different show format).
- Self-hosting open H3 weights is licence-blocked in the UK/EU/US (covers
  outputs too); ~10–20× cheaper at volume if MiniMax grants a territory
  licence. The hosted fal API is unrestricted.
- Cheap test mode drops references (text-to-video 480p). Two verified
  alternatives exist (fal schemas, 2 Sep 2026): `minimax/h3-max/reference-to-video`
  accepts `resolution: "480P"` but still bills a flat $0.08/s; the base
  `minimax/h3/reference-to-video` endpoint is $0.05/s at 480p and $0.06/s at
  768p WITH references (first 5 stills free), i.e. 25% cheaper than what we
  run at the same resolution — speed on fal unmeasured. A ~$3 A/B (latency,
  likeness, voice) decides whether to switch; see "Research notes".
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

## Research notes (2 Sep 2026)

A deep-research pass over other AI-livestream implementations (fal.live /
H3 Max Live, Infinite Slop, infinite-tv, Nothing Forever, Neuro-sama) was
checked against fal's live OpenAPI schemas and Anthropic's docs. What held:

- Our architecture (independent clips → normalise → one persistent ffmpeg
  with running timestamp offsets → HLS) matches the field; nobody has a
  better stitching answer. Infinite Slop runs a 1-clip buffer with 2–4
  concurrent generations and reruns as filler — hence the latency knobs and
  rerun fillers above.
- Loudness varied clip to clip everywhere native audio is used; we now
  normalise every clip to −16 LUFS (`LOUDNORM_FILTER` in
  `src/generation/ffmpeg.ts`).
- Twitch and YouTube removed fal's own continuous AI stream within days
  (Aug 2026). Self-hosting is a strategic advantage; the viewer page now
  carries an "AI-generated" badge regardless.
- Prompt caching on the director was already in place (Opus 5 caches from
  512 tokens; our prompts are ~760–880). `episode_end.director.cacheReadTokens`
  proves it per episode.
- All three H3 endpoints on fal accept a `seed` (untested for set
  consistency) and up to 9 reference images / 3 videos / 3 audio (12 files);
  reference INPUT tokens beyond 4,096 cost $0.02 per 1k — a reference video
  costs ~7,459 tokens per second at 768p, so "previous host clip as
  reference" is ~$1.49 per generation and not worth it.
- `end_image_url` (first/last-frame chaining) exists only on
  `minimax/h3-max/image-to-video`, which has no reference audio — chaining
  host clips would cost voice consistency. Not adopted.
- Open: base-H3 A/B (above); director-generated candidate scenes that
  viewers upvote as a built-in mechanic; a music policy for native audio
  (ambience/foley only is the copyright-safe default).

## Working on this with Claude

Start sessions on `Particle6xXICOIA/livestreamv1` (sessions inherit the
environment's keys — note ANTHROPIC_API_KEY is Railway-only, not in the
Claude environment, so test the compiler against the deployed platform).
Convention: one `claude/*` feature branch per session, PR per change, merge
auto-deploys. Railway infra changes (volumes, variables) can be made from
sessions via the Railway MCP tools.
Verify player-facing changes in a real browser — CI-container Chromium can't
decode H.264. Dry runs are free; use them for everything that isn't about
picture quality. `npm test` (unit + ffmpeg-backed runner integration tests,
~75s, $0) and `npx tsc --noEmit` must pass before pushing; GitHub Actions
(`.github/workflows/ci.yml`) runs both plus a dry-run episode on every PR.
The integration tests in `test/integration/runner.test.ts` are the place to
add coverage for any loop/playout change — they drive the real runner and
real ffmpeg playout with fake chat/director/generator.
