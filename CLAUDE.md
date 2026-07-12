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
  - On **Windows PowerShell**, pass multi-line messages via `git commit -F
<file>` — inline here-strings mangle apostrophes/quotes and split the
    message into bogus pathspecs. Write the message to a scratch file and
    `-F` it. (macOS/Linux shells handle multi-line `-m` fine.)
- **lint-staged** (Husky pre-commit) runs prettier + tslint --fix on staged
  files. Expect it to reformat your edits (import order, multi-line wrapping)
  during the commit — that's intentional, keep it.

## Dev environment (macOS / Windows / Linux)

The app builds and runs on **macOS (arm64 + x86_64), Windows (x64), and
Linux (x64)** — all four are CI targets (see `.github/workflows/build.yaml`),
and mac + Windows both have signed release builds. Historically it was
developed primarily on macOS; more recently on Windows. Nothing here is
Windows-only except the optional ASIO audio backend (see below).

Package manager is **Yarn (Berry) with PnP** — there is **no `node_modules`**.

### Toolchain prerequisites

- **Node.js LTS** + `corepack enable` (provides the `yarn` shim). CI uses
  `lts/*`.
- **Rust**, both **stable and nightly** — nightly is only needed for the
  `cargo careful` native tests (`yarn test:native`); stable builds the addon.
  Install via `rustup`.
- **A C toolchain / platform audio headers**: macOS → Xcode command-line
  tools (`xcode-select --install`); Linux → `libasound2-dev` (ALSA);
  Windows → MSVC build tools.
- **python3 + `ephemeral-port-reserve`** (`pip install --user
ephemeral-port-reserve`) — only for the wdio integration tests. Make sure
  its install bin dir is on PATH.

Platform notes:

- **macOS**: the native addon uses **CoreAudio via `cpal`** — do **not** pass
  `--features asio`. Build the addon for your arch with
  `CARGO_ARGS="--target aarch64-apple-darwin"` (or `x86_64-apple-darwin`).
- **Windows**: Node often isn't on PATH from Git Bash / PowerShell (it lives
  at `C:\Program Files\nodejs`). Prefix commands:
  ```sh
  # PowerShell
  $env:PATH = "C:\Program Files\nodejs;$env:PATH"; corepack yarn <script>
  # Git Bash
  export PATH="/c/Program Files/nodejs:$PATH"; corepack yarn <script>
  ```
  Windows can additionally opt into the **ASIO** low-latency audio backend
  with `CARGO_ARGS="--features asio"` (requires Steinberg's ASIO SDK — see
  `docs/windows-dev-setup.md`).
- **Linux**: install `libasound2-dev` first; `cpal` uses ALSA.

### Commands

- `corepack yarn run-dev` — full dev build + launch. Serves the built
  renderer+remocon bundles on :3000 via a static file server
  (`scripts/devStaticServer.mjs`), kept fresh by `parcel watch`, then launches
  the Electron app; the GraphQL/remocon server listens on **:8080**. The
  Electron window pops up on the dev machine's screen. (No HMR — reload the
  page after a change. We use `parcel watch` + a static server rather than
  `parcel serve` because `parcel serve`'s multi-target HMR build hoists bundles
  to the server root and serves a layout inconsistent with the on-disk build,
  which whitescreens the remocon behind the `/remocon/`-prefixing reverse
  proxy.)
- `corepack yarn build-prod` — production build (relay + native + parcel).
- `corepack yarn package-prod` — packages a platform-native bundle under
  `dist/` (+ `.zip`): `karafriends-win32-x64/` (`.exe`) on Windows,
  `karafriends-darwin-<arch>/karafriends.app` on macOS, `karafriends-linux-x64/`
  on Linux. Pass `PACKAGER_ARCH` (e.g. `arm64`) to cross-target.
  - **macOS signing/notarization is opt-in**: `packager.js` only code-signs +
    notarizes when `NOTARIZATION_KEY_PATH` is set (the release CI sets it).
    Without it you get an **unsigned `.app` that runs locally** — exactly what
    you want for your own machine. A distributable build needs the Developer ID
    cert + notarization key.
  - **Windows**: the packaged `karafriends.exe` must not be running — it locks
    `dist` and packaging fails with EBUSY. Close it first
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

- **Windows**: `Get-NetTCPConnection -LocalPort 8080 -State Listen |
Stop-Process -Id {OwningProcess} -Force`.
- **macOS / Linux**: `lsof -ti tcp:8080 | xargs kill -9` (or
  `kill $(lsof -ti tcp:8080)`).

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
  - **An unhandled promise rejection anywhere in `main` kills the WHOLE app.**
    `main/index.ts` registers `process.on("unhandledRejection", …)` (and
    `uncaughtException`) handlers that call `process.exit(1)`. So a rejected
    promise with no `.catch()` — including one that rejects _after_ a resolver
    has already returned (fire-and-forget downloads, predownloads,
    subscriptions) — takes down the GraphQL server, the queue, and the
    renderer, not just the one request. **Every async path in `main` must
    terminate in a `.catch()`.** The `DamQueueItem.streamingUrls`/`scoringData`
    read resolvers and the `queueDamSong` queue-time predownload model the
    guard; e.g. the DAM 403 / streaming-absent conditions under "DAM
    specifics" below used to crash the app via that predownload before it was
    guarded. Audit any new fire-and-forget chain for this.
- **Stray `null` in `queue.json`** (fixed; kept for archaeology): `saveDb`
  used to prepend `db.currentSong` unconditionally, so every idle-time save
  persisted a leading `null` in `songQueue`, breaking `queue` queries on the
  next launch until the first `popSong` shifted it out. `saveDb` now filters
  it (and resets `playbackState` to WAITING — a stale persisted PLAYING left
  the renderer BGM-less on relaunch), and `loadDb` heals old files on load,
  so no manual `queue.json` deletion is needed anymore.
- **The remocon renders a BLANK page in a fresh headless browser.**
  `useUserIdentity` calls `window.prompt()` when no nickname is stored, which
  throws in headless contexts and takes the whole `<App>` down.
  Separately, a **failed `useLazyLoadQuery`** (services unreachable) used to
  whitescreen the app the same way — an uncaught throw taking down `<App>`.
  `withLoader` now wraps children in a `QueryErrorBoundary` as well as
  `Suspense`, so a failed search renders an inline retry message. Route new
  lazy-loaded queries through `withLoader` (or their own boundary); never
  leave a raw `useLazyLoadQuery` with no error boundary above it. Pre-seed
  `localStorage.nickname` + `localStorage.deviceId` before loading the page.
- **Remocon whitescreen with NO console error and NO GraphQL request = a
  serve/proxy bug, not app code.** Before reading a single React file, run the
  30-second check: `curl -s -o /dev/null -w '%{content_type}\n'
http://localhost:8080/remocon.<hash>.js` (hash from `curl -s
http://localhost:8080/ | grep -oE 'remocon\.[a-z0-9]+\.js'`). If it's
  `text/html` instead of `application/javascript`, the `<script>` is being fed
  an HTML page so the bundle never runs — `#root` stays empty, nothing throws.
  This has bitten us twice (a reverse-proxy filename collision and a
  `parcel serve` multi-target collision); both, plus the fast diagnostic, are
  written up in `docs/dev-server-investigation.md`. Read that _first_ next time.
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

Everything downloaded/composited lives in a `karafriends_tmp/` folder under
the OS temp dir (`app.getPath("temp")`) — so **Windows**
`%LOCALAPPDATA%\Temp\karafriends_tmp\`, **macOS** `$TMPDIR/karafriends_tmp/`
(under `/var/folders/…/T/`), **Linux** `/tmp/karafriends_tmp/`:

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
- **`native/`** — a Rust `.node` addon (audio I/O via **`cpal`** —
  CoreAudio on macOS, WASAPI on Windows, ALSA on Linux, with **ASIO** an
  opt-in Windows feature; plus ephemeral-port reservation).

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

All these hooks share resilience plumbing — copy it when writing a new one:
the initial fetch goes through **`fetchQueryWithRetry`** (`src/common/hooks`)
so a flaky first request after launch retries with backoff instead of
silently leaving the default value (this is what made BGM "sometimes not
kick in" after `run-dev`), and they refetch on **`WS_RECONNECTED_EVENT`**
(dispatched by `graphqlEnvironment` whenever the graphql-ws socket
(re)connects; `retryAttempts: Infinity` there keeps clients reconnecting
across server restarts instead of freezing on stale values).

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
2. Confirm the bundled version: run the platform binary in
   `extraResources/ytdlp/` with `--version` (`yt-dlp.exe` on Windows,
   `yt-dlp_macos` on macOS, `yt-dlp` on Linux).
3. Rebuild (auto-refreshes) or manually drop the latest release for your
   platform from `github.com/yt-dlp/yt-dlp/releases/latest` into
   `extraResources/ytdlp/` **and** the packaged
   `dist/.../resources/extraResources/ytdlp/`.
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
- Separately, DAM's **auth host `win10.clubdam.com` (CloudFront) geo-blocks
  non-Japan IPs** with a 403 `text/html` page — so login itself fails off-VPN
  (opposite polarity from the CDN case above). `MinseiAPI.login` detects the
  non-JSON body and throws a descriptive error, and both credentials
  providers use `memoizeWithFailureEviction` so a failed login is retried on
  the next request instead of staying cached until relaunch. JOYSOUND's
  `sound-cafe.jp` login is also network-sensitive (no `set-cookie` from some
  exits). The manual "check now" health check (`recheckServiceHealth`) is the
  recovery path after changing networks: it forces a fresh check (bypassing
  the in-flight dedupe), resets both credential caches for a from-scratch
  re-login, and fails fast (2 attempts + a 30s hang ceiling per service) rather
  than sitting in `getMusicStreamingUrls`'s default ~17-minute
  `promiseRetry` backoff, which playback paths intentionally keep.
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
entry. Reading app-owned credentials from the platform config path
(`%APPDATA%\karafriends\config.yaml` on Windows,
`~/Library/Application Support/karafriends/config.yaml` on macOS,
`~/.config/karafriends/config.yaml` on Linux — see `docs/configuration.md`) to
call the same APIs the app calls (for the user's own accounts) is acceptable
for testing — never print or commit them.

## More docs

`docs/` has longer-form writeups: `architecture.md`, `development.md`,
`configuration.md`, `glossary.md`, `overview.md`, `windows-dev-setup.md`, and
investigation logs (`audio-chopping-investigation.md`,
`joysound-piano-roll-investigation.md`, `dev-server-investigation.md`).
