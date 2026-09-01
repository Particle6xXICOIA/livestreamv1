# Tilly Learns Improv — livestream prototype

Tilly hosts a live improv show: viewers suggest things in chat (`!prompt order
a coffee as a Victorian ghost`), an LLM show director picks one and writes her
riff in her voice, and MiniMax H3 Max (on fal) generates every second on
screen — host segments and acted-out scenes — pushed continuously to RTMP.

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

Any component without its key runs as a stub, so the loop is testable at every
level of fidelity. `Ctrl-C` ends an episode gracefully (closing segment, clean
stream shutdown); pressing it twice force-quits.

Drop pre-generated filler clips (mp4) into `assets/fallback/` to replace the
default "Tilly is thinking" card that airs when generation falls behind.
