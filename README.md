# Tilly Live — character livestream platform

AI characters host live shows: viewers send suggestions in chat (`!prompt
order a coffee as a Victorian ghost`), an LLM show director picks one and
writes the host's riff in character, and MiniMax H3 Max (on fal) generates
every second on screen — host segments and acted-out scenes — streamed
continuously to the built-in platform (or RTMP).

**Shows are data**: each experience is a JSON file in `shows/` defining the
character (visual anchors + fal reference image/voice URLs), premise, prompts,
set, and fixed opening/closing. Current shows: `tilly-improv`,
`tilly-agony-aunt`, `tilly-interviews` (viewers invent the guests). Add one by
copying `shows/_template.json`, then generate its filler library once with
`npm run fillers -- --show <id>`.

See [PLAN.md](PLAN.md) for the architecture, cost model, and milestones.

## Quick start

```bash
npm install
cp .env.example .env   # fill in what you have; everything is optional

# Full dry run — zero inference cost, writes a watchable stream file:
npm run episode -- --dry-run --minutes 2 --cycles 3
# → out/episodes/<id>/stream.ts (open with any video player) + log.jsonl

# Real episode (fills in components for whichever keys are set):
npm run episode -- --minutes 30

# The self-hosted platform (viewer page + chat + episode control API):
npm run serve
```

Requires Node 20+ and ffmpeg on PATH.

## Configuration

| Env var | Effect when set |
|---|---|
| `FAL_KEY` | Real video generation via MiniMax H3 Max |
| `ANTHROPIC_API_KEY` | Real show director (Claude) |
| `TWITCH_CHANNEL` | Read `!prompt` suggestions from that channel's chat |
| `RTMP_URL` | Stream live (YouTube/Twitch ingest URL incl. key); unset = local file |
| `TILLY_REFERENCE_IMAGE_URLS` | Likeness consistency (H3 Max reference-to-video) |
| `TILLY_REFERENCE_AUDIO_URL` | Voice consistency (5–15s reference clip) |
| `MAX_CONCURRENT_CYCLES` | Cycles generating in parallel (default 2; also `--concurrency N`) |
| `BUFFER_TARGET_SEC` | Content to keep buffered ahead of air (default 45; also `--buffer N`) |
| `EPISODE_BUDGET_USD` | Estimated-spend cap per episode (default 5; `--budget N`; 0 = uncapped) |
| `DAILY_BUDGET_USD` | Estimated-spend cap per UTC day across episodes (default 25; 0 = uncapped) |
| `ARCHIVE_MAX_GB` / `MIN_FREE_GB` | Recording archive size cap (default 2) and disk headroom required to start (default 1) |
| `GENERATION_TIMEOUT_SEC` / `DIRECTOR_TIMEOUT_SEC` | Abandon a cycle whose generation (240) or director call (90) hangs |

Any component without its key runs as a stub, so the loop is testable at every
level of fidelity. `Ctrl-C` ends an episode gracefully (closing segment, clean
stream shutdown); pressing it twice hard-stops (cuts the stream now, keeps the
recording).

`npm test` runs the unit tests plus runner integration tests (real ffmpeg
playout with fake chat/director/generator, ~75s, zero spend); `npm run
test:unit` is the sub-second subset. CI runs both plus a dry-run episode.

Generate a show's filler library once with `npm run fillers -- --show <id>` —
"vamping on set" clips plus cached opening/closing segments written to
`assets/shows/<id>/` that air whenever generation falls behind (a placeholder
card is used until then). Episodes select a show with `--show <id>` on the
CLI, `{"show": "<id>"}` on `/start`, or the dropdown in the producer panel.

## The self-hosted platform

`npm run serve` (or the Dockerfile, deployed on Railway) runs the internal
show platform in one process:

- **Viewer page** at `/?key=<VIEWER_TOKEN>` — live player plus team chat;
  suggest scenes with `!prompt <idea>`. Only people with the link token can
  watch; chat messages feed the show director directly.
- **Producer controls in the page**: open the viewer link with
  `&ctl=<CONTROL_TOKEN>` appended and Start/Stop buttons appear in the header
  (minutes + optional cycle cap). Episodes default to 10 minutes; Stop ends
  one early after the closing segment.
- **Episode control** from the command line with `CONTROL_TOKEN`:

  ```bash
  curl -X POST https://<host>/start -H "Authorization: Bearer $CONTROL_TOKEN" \
       -H "content-type: application/json" -d '{"minutes": 30}'
  curl -X POST https://<host>/stop  -H "Authorization: Bearer $CONTROL_TOKEN"
  ```

  `/start` also accepts `cycles`, `dryRun`, `budget`, and `"output": "rtmp"`
  (push to `RTMP_URL` — YouTube/Twitch — instead of the built-in platform;
  pair it with `YOUTUBE_API_KEY` + `YOUTUBE_VIDEO_ID` to read that
  broadcast's chat). `/stop` is graceful; `/stop` with `{"hard": true}` cuts
  the stream immediately. `/start` refuses with 402 once the daily cap is
  spent and 507 when the archive disk lacks headroom for a recording.
