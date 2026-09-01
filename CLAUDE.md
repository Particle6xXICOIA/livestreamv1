# Tilly Live

Self-hosted livestream platform: AI characters host live shows, viewers direct
them from chat. **Read HANDOFF.md first** — it has the full operating guide,
cost model, and the list of hard-won fixes that must not be re-broken.

Essentials:

- One Node process (`npm run serve`, Dockerfile → Railway service
  `tilly-platform`) serves the episode loop, HLS playout, viewer page, chat,
  and control API. Merge to `main` auto-deploys.
- Shows are JSON configs in `shows/` over a fixed episode loop; characters are
  reference images + a voice clip hosted on fal storage.
- Generation: MiniMax H3 Max via fal (`reference-to-video`, flat $0.08/s).
  Dry runs (`--dry-run`) are free — use them for anything that isn't picture
  quality. `--test-quality` = cheap 480p prompt-only generation.
- Secrets live in Railway variables and the Claude Code environment — never in
  this repo (it is public). Tokens for the live platform are in Railway vars.
- Playout correctness is delicate: clips must enter the stream with continuous
  timestamps, HLS segments authorize via cookie, and the player attaches only
  after a segment runway. Details + rationale in HANDOFF.md §"Hard-won fixes".
- Validate `npx tsc --noEmit` + a dry-run episode before pushing; verify
  player-facing changes in a real browser (CI Chromium lacks H.264).
