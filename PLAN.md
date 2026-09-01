# Tilly Learns Improv — Livestream Prototype Plan

## Goal

Prove the live improv-show loop end to end: Tilly hosts a stream, viewers suggest
things in chat, and MiniMax H3 Max renders everything on screen — as bounded,
reviewable episodes on real streaming plumbing. Internal team audience first;
the same pipeline points at public Twitch/YouTube later by changing nothing but
the channel and stream key.

## Show format (decided)

**Host + scene cutaways.** Each cycle (~60–90s):

1. Tilly appears in host mode on her set and riffs on a chat suggestion,
   crediting the viewer by name.
2. Cut to a generated scene of her *acting it out* — costume, location,
   physical comedy.
3. Back to host mode for the next pick.

Everything on screen is H3 Max output (host segments included). Episodes are
**on-demand**: a team member starts one with a single command, it runs 30–60
minutes, plays a closing segment, and archives itself for review.

## Architecture

```
Twitch chat ──► ChatSource ──► Director (Claude) ──► ClipGenerator (fal / H3 Max)
 (!prompt …)     drain per        picks + writes        host clip + scene clip
                 cycle            riff & scene prompt          │
                                                               ▼
                                                     normalize to MPEG-TS
                                                               │
              filler clips ◄── queue empty? ──►  Playout (persistent ffmpeg -re)
                                                               │
                                                    RTMP (YouTube/Twitch)
                                                    or local file when unset
```

Every component has a **stub twin**, independently selected: `--dry-run` runs
the entire loop with zero inference spend (scripted chat, canned director,
title-card clips); with keys present, each component upgrades to real
individually — e.g. real director + stub video to iterate on show writing
cheaply.

### The pieces

| Component | Real implementation | Stub |
|---|---|---|
| Chat ingest | `TwitchChat` — anonymous IRC read of `!prompt …` via tmi.js | `StubChat` — scripted suggestions on a timer |
| Show director | `ClaudeDirector` — Claude Opus 5 (`claude-opus-5`), structured output; picks the most playable suggestion, screens safety, writes Tilly's riff in her voice + the scene prompt | `StubDirector` — deterministic template |
| Generation | `FalH3MaxGenerator` — fal endpoints below | `StubGenerator` — ffmpeg title cards |
| Playout | One persistent `ffmpeg -re` process; normalized MPEG-TS clips byte-concatenated into stdin; pipe backpressure paces the producer | same (local file instead of RTMP) |
| Archive | `out/episodes/<id>/` — log.jsonl (suggestions, decisions, prompts, timings) + every clip; feeds the existing Tilly iteration workflow | same |

### H3 Max endpoints (verified on fal, Aug 2026)

| Endpoint | Use | Price |
|---|---|---|
| `minimax/h3-max/reference-to-video` | **Default when Tilly references are configured.** `reference_image_urls` (likeness) + `reference_audio_urls` (a 5–15s voice clip → voice consistency) | $0.08/s + reference tokens (first 4k free/request) |
| `minimax/h3-max/text-to-video` | Fallback with prompt-only identity anchors | $0.04/s @768P (promo) |
| `minimax/h3-max/image-to-video` | Option for host clips from a canonical host frame (lipsync-tagged) | $0.04/s @768P (promo) |

Clips are 5–15s, 768P, ~faster-than-realtime generation (≈3s for a 5s clip
backend-side; budget more for queue + upload + download).

**Voice consistency:** solved via `reference_audio_urls` — upload one clean
5–15s clip of Tilly's voice (from the existing ElevenLabs pipeline) to a public
URL and set `TILLY_REFERENCE_AUDIO_URL`. Validate in week one; if H3 Max's
voice tracking disappoints, the fallback is muting scene dialogue and layering
ElevenLabs TTS onto host clips at normalize time.

### Safety

The director declines unsafe suggestions (sexual content, real-person
impersonation, harassment, violence played straight, anything targeting a
private person) and logs each decline with a reason; popular declined
suggestions get an in-character deflection, never a repeat of the content.
H3 Max's own safety checker stays enabled. Before any public broadcast, add a
pre-director keyword filter and a human kill switch (Ctrl-C already ends the
episode gracefully).

## Cost model (episode of ~45 min on air)

Airtime ≈ linear inference: ~2,700s of video.
- reference-to-video everywhere: ~$216/episode
- text/image-to-video (no refs): ~$108/episode at promo rates
- plus director calls: ~30–45 Claude calls, small context — low single-digit dollars.

Use `--cycles N` for cheap smoke tests (e.g. 3 cycles ≈ $3–8 real-mode).

## Milestones

1. **Done — loop proven dry.** `npm run episode -- --dry-run --minutes 2 --cycles 3`
   produces a continuous 61s stream file with fillers, opening, host/scene
   cycles, closing, and a full archive.
2. **First real clips.** Set `FAL_KEY`, run 2–3 cycles with stub chat + stub
   director. Validate: likeness with reference images, voice with reference
   audio, generation latency vs. clip length (must average faster than
   realtime or the fillers dominate).
3. **First real episode.** Add `ANTHROPIC_API_KEY` + `TWITCH_CHANNEL` +
   `RTMP_URL` (unlisted YouTube Live or low-profile Twitch). Team drops
   `!prompt` suggestions; watch the show; review the archive.
4. **Iterate on the show** using episode archives (riff quality, scene
   comedy, pacing, prompt anchors) — this plugs into the existing Tilly
   iteration workflow.
5. **Public readiness (later):** pre-director moderation filter, longer
   fallback filler library (pre-generated H3 Max clips in `assets/fallback/`),
   RTMP auto-reconnect, always-on hosting, YouTube chat ingest.

## Open questions / tracked risks

- **Voice consistency** across clips (mitigation above; validate at milestone 2).
- **Generation latency spikes** — fillers cover gaps, but if p95 generation
  exceeds clip runtime the show becomes mostly filler; measure at milestone 2,
  consider 480P or shorter scenes if needed.
- **Reference hosting** — reference images/audio need public URLs; fal's
  storage upload API is the easy answer if the team has no bucket handy.
- **Exact visual anchors** — `src/persona.ts` carries a placeholder; replace
  with the canonical Higgsfield-pipeline description of Tilly.
- **Platform choice** — Twitch chat ingest is anonymous and trivial (done);
  YouTube Live chat needs OAuth and is deferred.
