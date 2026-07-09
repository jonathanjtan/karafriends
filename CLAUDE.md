# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. Read this first;
it captures the workflow, architecture, and the hard-won gotchas that aren't
obvious from the code.

## What this is

karafriends is an Electron karaoke app. It pulls songs from two commercial
Japanese karaoke services — **DAM** (dkwebsys/minsei APIs) and **JOYSOUND**
(joysound.com) — plus YouTube and Niconico, and plays them on a "renderer"
big-screen display driven by a phone-based "remocon" (remote control) web UI.
Mic input is pitch-tracked and scored against a guide melody with an
on-screen piano roll.

## Repository & workflow

- **Commits**: Conventional Commits, small and focused. End commit messages
  with Co-Author attributions.
  - On Windows PowerShell, pass multi-line messages via `git commit -F
<file>` — inline here-strings mangle apostrophes/quotes and split the
    message into bogus pathspecs. Write the message to a scratch file and
    `-F` it.
- **lint-staged** (Husky pre-commit) runs prettier + tslint --fix on staged
  files. Expect it to reformat your edits (import order, multi-line wrapping)
  during the commit — that's intentional, keep it.

## Dev environment (Windows)

This is developed on a Windows 11 machine. Node lives at
`C:\Program Files\nodejs`; the shell (Git Bash / PowerShell) doesn't always
have it on PATH. Prefix commands:

```sh
# PowerShell
$env:PATH = "C:\Program Files\nodejs;$env:PATH"; corepack yarn <script>
# Git Bash
export PATH="/c/Program Files/nodejs:$PATH"; corepack yarn <script>
```

Package manager is **Yarn (Berry) with PnP** — there is **no `node_modules`**.

### Commands

- `corepack yarn run-dev` — full dev build + launch. Starts Parcel dev servers
  for renderer+remocon on :3000 and the Electron app; the GraphQL/remocon
  server listens on **:8080**. The Electron window pops up on the dev
  machine's screen.
- `corepack yarn build-prod` — production build (relay + native + parcel).
- `corepack yarn package-prod` — packages `dist/karafriends-win32-x64/`
  (+ `.zip`). **The packaged `karafriends.exe` must not be running** — it
  locks `dist` and packaging fails with EBUSY. Close it first
  (`Stop-Process -Name karafriends -Force`), or run package-prod in a loop
  that waits for the process to exit.
- `corepack yarn build-relay-dev` / `build-relay-prod` — regenerate Relay
  `__generated__` artifacts. **Required after any change to
  `src/common/schema.graphql` or any `graphql\`\`` document.** `__generated__`
  is gitignored.

### Typecheck baseline

`corepack yarn tsc --noEmit -p tsconfig.json` is **clean** — the baseline was
cleared to **0 errors** (commit `d5f97f89`). When typechecking a change,
confirm the count is still 0 and that you haven't introduced any errors in
files you touched.

### Kill / restart

The dev app owns port **:8080**. To kill it:
`Get-NetTCPConnection -LocalPort 8080 -State Listen | Stop-Process -Id
{OwningProcess} -Force`.

### Gotchas that will waste your time

- **Running the app without `run-dev` breaks ffmpeg/yt-dlp.** Launching via
  `yarn node electron.js build/dev/main_/index.js` directly makes
  `app.getAppPath()` resolve to Electron's bundled `resources` dir instead of
  the repo, so `extraResourcesPath` in `videoDownloader.ts` points at a
  nonexistent ffmpeg/yt-dlp and every spawn ENOENTs. Fine for hitting pure
  GraphQL resolvers with curl; not fine for anything that shells out. Use the
  real `run-dev` for download/compose work.
- **First GraphQL request after a fresh launch may throw** a
  `require-in-the-middle`/Parcel-runtime `TypeError` (Sentry's require-patching
  racing Parcel's lazy module cache). Harmless — just retry the same request.
- **Stray `null` in `queue.json`.** `saveDb` prepends `db.currentSong`
  unconditionally, so a `null` can land in the persisted `songQueue` array at
  `%LOCALAPPDATA%\Temp\karafriends_tmp\queue.json`, which then crashes any
  `queue`/`queueJoysoundSong` query with "Cannot read properties of null".
  Delete that file to reset.
- **The remocon renders a BLANK page in a fresh headless browser.**
  `useUserIdentity` calls `window.prompt()` when no nickname is stored, which
  throws in headless contexts and takes the whole `<App>` down. Pre-seed
  `localStorage.nickname` + `localStorage.deviceId` before loading the page.
- **Scratch scripts that import repo deps must live inside the repo.** PnP
  only resolves packages for files under the project root. To use e.g.
  `youtubei.js` from a throwaway script, drop the `.cjs` into the repo dir and
  run it with `corepack yarn node ./script.cjs`, don't run it from an external
  scratch dir.

### Preview tooling for the remocon

The preview MCP tools can't attach to an externally-started server on :8080.
There's a launch.json entry **`karafriends-remocon-via-app`** — a transparent
TCP proxy (`scratchpad/.../tcp-proxy-8080.js`, port 3002 → app :8080) that
carries both HTTP and graphql-ws, letting the preview browser drive the real
running app's remocon.

## The temp/cache dir

Everything downloaded/composited lives in
`%LOCALAPPDATA%\Temp\karafriends_tmp\`:

- `queue.json` — the persisted NotARealDb (see below).
- `reading-cache.json` — persisted name→reading (yomi) cache backing the
  helper romaji. Entries are `{yomi, canonical}` keyed by an NFKC-normalized
  name; `canonical` (from DAM's curated readings) beats a kuromoji guess and
  is never downgraded. Debounce-saved, loaded at startup. Delete it to force
  every reading to be re-derived. See the yomi resolution path in
  `graphql.ts` (`toYomi`/`primeDamReadings`/`pushSongToQueue` snapshot).
- `joysound-<songId>-<suffix>.mp4` — composited Joysound video. Suffix is the
  YouTube video id (or `default` for the built-in JOYSOUND video, or
  `<ytid>-nosync` when video sync is disabled). **Delete the relevant
  composite when changing sync/compose logic**, or the app serves the stale
  cached file instead of recompositing.
- `joysound-<songId>-melody.bin` — extracted guide-melody scoring data.
- `joysound-<songId>.joy_02` — telop (lyrics/timing) blob.
- `yt-<ytid>.log`, `yt-<ytid>-introsync.log`, `joysound-<songId>.log` —
  yt-dlp / ffmpeg logs. Read these first when a download or compose fails.
- `<damId>-<idx>.mp4`, `dam-<damId>.log` — DAM predownloads.

## Architecture

Four bundles built by Parcel from `src/`:

- **`src/main`** — Electron main process. Hosts the Apollo GraphQL server
  (`graphql.ts`, the heart of the app), the DAM/JOYSOUND API clients
  (`damApi.ts`, `joysoundApi.ts`), and server-side kuroshiro/kuromoji for
  reading (furigana) generation.
- **`src/renderer`** — the big-screen display (Player, PianoRoll,
  JoysoundRenderer, webAudio graph, BackgroundMusic).
- **`src/remocon`** — the phone web UI (search, queue, playback controls,
  volume/settings panels).
- **`src/common`** — shared code: `schema.graphql`, GraphQL environment,
  shared React hooks, `videoDownloader.ts` (the download/compose pipeline,
  used from main), DSP (`guideMelody.ts`), parsers, constants.
- **`native/`** — a Rust `.node` addon (audio I/O via ASIO, ephemeral-port
  reservation).

GraphQL on **:8080** is **POST-only** (Apollo CSRF protection); it also serves
graphql-ws subscriptions over WebSocket. The remocon talks to it; in dev,
non-GraphQL requests are reverse-proxied to the Parcel dev server.

### The synced-state pattern (`NotARealDb`)

Room-wide settings live in a single in-memory object `db: NotARealDb` in
`main/graphql.ts`, persisted to `queue.json` via `saveDb()` (a `...db` spread,
so new fields persist for free). Each synced setting is a **query + mutation +
subscription trio** wired through graphql-subscriptions `PubSub`, exposed to
clients via a **shared React hook**:

- Float settings (bgmVolume, guideMelodyVolume, pianoRollOpacity,
  pianoRollSize) use the generic **`useSyncedServerFloat`** hook
  (`src/common/hooks`): initial `fetchQuery`, refetch on `visibilitychange`,
  `requestSubscription` for remote changes, and a **200ms trailing-debounced**
  mutation for local slider drags, with stale-echo suppression while a commit
  is pending and a flush-on-unmount. Relay requires static `graphql\`\``documents, so each concrete hook (e.g.`usePianoRollSize`) declares its own
  three operations and hands them to the generic hook.
- Non-float / non-debounced settings (bgmTrack, pitchShiftSemis) have their
  own small hooks with the same fetch/subscribe/mutate shape but commit
  immediately.

**To add a synced setting**: add the field to `NotARealDb` + both `db` init
sites + `loadDb`, add query/mutation/subscription to `schema.graphql`, add
resolvers + a `SubscriptionEvent` + a pubsub publish in the mutation, write a
hook, relay-compile. Persistence is automatic via the `...db` spread.

### Key subsystems

- **JOYSOUND video pipeline** (`videoDownloader.ts` →
  `downloadJoysoundData`): fetches telop + ogg, optionally downloads a YouTube
  background video via yt-dlp, composites them with ffmpeg, extracts the guide
  melody, and pushes to the queue. Falls back to JOYSOUND's own default video
  if the YouTube path fails.
- **YouTube MV auto-picker** (`suggestedYoutubeVideos` in `graphql.ts`):
  JOYSOUND-only (DAM has no youtubeVideoId concept). Searches YouTube via
  **youtubei.js** (`Innertube`), then ranks candidates by a **trust tier**
  (artist's own channel / bracketed `[Official Video]` tag / official-title +
  related-channel), with duration-closeness only a within-tier tiebreak,
  song-name-in-title as a hard filter, and an exclusion list of cover/karaoke/
  lyric/live keywords (English + Japanese + Korean + Thai). **The Innertube
  client is created with `lang: "ja", location: "JP"`** — without it, YouTube
  machine-romanizes JP titles (e.g. 晩餐歌 → "Bansanka"), which breaks the
  song-name filter and hides the JP exclusion keywords.
- **Video ↔ karaoke sync** (`computeYoutubeIntroOffsetMs`): cross-correlates
  RMS envelopes of several 20s windows sampled from inside the karaoke track
  against the whole MV audio, takes the consensus offset. Positive → `-ss`
  trim; negative (karaoke has extra head material, e.g. a count-off) →
  frozen-first-frame front-pad; null → legacy end-together heuristic. The
  intro-sync's audio fetch is a **separate yt-dlp `-f ba` download** — it logs
  to `yt-<id>-introsync.log`, retries once, and runs after the video download
  to avoid a concurrent double-hit. Optional per-queue via
  `youtubeVideoSyncEnabled` (a default-on remocon checkbox; null = enabled for
  old clients).
- **Guide melody** (`common/guideMelody.ts`, `renderer/damGuideMelody.ts`):
  - JOYSOUND's getFME ogg is **3.0-channel vorbis with the guide melody
    isolated on the FC channel** (channel index 2 in Web Audio). It's
    ffmpeg-decoded and pitch-tracked (autocorrelation) at download time into
    DAM-scoring-binary format, cached as `-melody.bin`.
    - Tracker gotcha: use a **full lag scan every frame** — narrowing the
      search around the previous frame locks onto 2/3-subharmonics at melodic
      leaps.
  - DAM streams are plain stereo (no isolated guide channel), so the guide is
    **synthesized locally** from the scoring reference data with scheduled
    oscillators, tracking the video clock across play/pause/seek.
- **Piano roll** (`renderer/PianoRoll.tsx` + `shaders/`): continuous
  right-to-left scroll past a fixed "now" cursor at `CURSOR_FRACTION=0.3` of
  canvas width, `TIME_WIDTH_SECS=7`. All shader programs take a
  `cursorFraction` uniform. Opacity/size are synced settings applied as plain
  CSS (the GL effect's deps are `[props]`, so a hook-state change re-renders
  without rebuilding the GL pipeline; canvas backing-store resize is handled
  by a ResizeObserver). Size `0` = "Off" (hides the canvas). JOYSOUND telop
  lyrics reflow to clear the roll (`remapLyricsYPos` in JoysoundRenderer).
  - **WebGL test harness lesson**: `drawImage`/late `readPixels` from a WebGL
    canvas without `preserveDrawingBuffer` returns blank after compositing —
    pixel assertions must run synchronously right after draw. `readPixels`
    y-origin is bottom-left.
- **Service health** (`serviceHealth` / `recheckServiceHealth`): live
  DAM/JOYSOUND reachability check (periodic + per-song-transition + manual
  "Check now"). Gate the per-song trigger on a **real** song transition — the
  Player polls `popSong` every ~5s while idle, which will otherwise hammer the
  services.
- **BGM**: bundled tracks in `src/common/bgmTracks.ts` (normalized to −20
  LUFS; see the file header for the re-encode recipe). Track selection and
  volume are synced settings; the renderer plays them between songs.

## External tools (yt-dlp / ffmpeg)

Downloaded by `scripts/getExternalResources.mjs` into `extraResources/`
(gitignored) at build time; packaging copies them into
`dist/.../resources/extraResources/`. `videoDownloader.ts` resolves them via
`resourcePaths`.

**yt-dlp goes stale fast and it is the #1 cause of "MV won't download".**
YouTube regularly changes its player to break older yt-dlp releases with
"Sign in to confirm you're not a bot" / HTTP 429 / signature-solving failures.
The build script now **re-fetches the latest yt-dlp on every build**
(`refreshYtdlp`) rather than caching an existing binary. If YouTube downloads
start failing:

1. Check `yt-<id>.log` in the temp dir for the bot/429/signature error.
2. Confirm the bundled version: `extraResources/ytdlp/yt-dlp.exe --version`.
3. Rebuild (auto-refreshes) or manually drop the latest `yt-dlp.exe` from
   `github.com/yt-dlp/yt-dlp/releases/latest` into `extraResources/ytdlp/`
   **and** the packaged `dist/.../resources/extraResources/ytdlp/`.
4. The **default** player client works with a current binary. A missing JS
   runtime (Deno) only limits available formats, it doesn't block the default
   client. Avoid `player_client=tv` — it hit DRM-protected formats here.

Note the search path (youtubei.js) and the download path (yt-dlp) are
**independent** — search can work perfectly while downloads are bot-walled.

## DAM specifics

- DAM's `cds1-clubdam...ipcasting.jp` CDN **403s from datacenter/VPN exit
  IPs** (IP-reputation filtering on commercial video), independent of the app
  — the official DAM Windows client fails on the same network state and
  unblocks when the VPN is toggled. This is not a karafriends bug; the service
  health check is the intended mitigation (warn + let you cycle VPN without a
  restart). JOYSOUND never hits this (text/search APIs only).
- Some songs are catalog-present but streaming-absent
  (empty `mModelMusicInfoList`, `GetMusicStreamingURL` returns NG) — a
  physical-machine-only license. Scoring reference data may still work.

## Verifying changes

No live-demo expectation from the user unless asked — but verify server/logic
changes yourself: curl the :8080 GraphQL API (POST-only; UTF-8 bodies via
`--data-binary @file` so Japanese keywords survive), replay pipeline logic
with offline scratch scripts (envelope/pitch analysis, the WebGL shader
harness), and check the temp-dir logs and composited outputs directly with
ffmpeg. For remocon UI, drive the real app through the TCP-proxy preview
entry. Reading app-owned credentials from
`%APPDATA%/karafriends/config.yaml` to call the same APIs the app calls (for
the user's own accounts) is acceptable for testing — never print or commit
them.

## More docs

`docs/` has longer-form writeups: `architecture.md`, `development.md`,
`configuration.md`, `glossary.md`, `overview.md`, `windows-dev-setup.md`, and
investigation logs (`audio-chopping-investigation.md`,
`joysound-piano-roll-investigation.md`).
