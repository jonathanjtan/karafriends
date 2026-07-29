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

The dev app owns port **:8080** — kill whatever is listening there before
relaunching.

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
- **`run-dev` and the packaged app read DIFFERENT `config.yaml` files.**
  `config.ts` resolves `app.getPath("userData")`, which in dev derives from the
  _executable_ name — so `run-dev` reads
  `~/Library/Application Support/`**`Electron`**`/config.yaml` (Windows:
  `%APPDATA%\Electron\`, Linux: `~/.config/Electron/`) while the packaged app
  reads the `karafriends/` one. Configure one and the other silently keeps its
  **defaults**, and `config.ts` helpfully writes a fresh default file on first
  launch so it looks configured. The tell: the service health check reports
  **both** DAM and JOYSOUND unreachable under `run-dev` while the packaged app
  is fine — `proxyEnable` is still `false` there, so every login goes out
  un-proxied into the geo-block (see "DAM specifics"). Keep the proxy block and
  the credentials in sync across both, and remember the file is only read at
  startup — restart after editing.
- **Scratch scripts that import repo deps must live inside the repo.** PnP
  only resolves packages for files under the project root. To use e.g.
  `youtubei.js` from a throwaway script, drop the `.cjs` into the repo dir and
  run it with `corepack yarn node ./script.cjs`, don't run it from an external
  scratch dir.

### Preview tooling for the remocon

The preview MCP tools can't attach to an externally-started server on :8080.
There's a launch.json entry **`karafriends-remocon-via-app`** — a transparent
TCP proxy (`.claude/tcp-proxy-8080.js`, port 3002 → app :8080) that
carries both HTTP and graphql-ws, letting the preview browser drive the real
running app's remocon.

## The temp/cache dir

Everything downloaded/composited lives in a `karafriends_tmp/` folder under
the OS temp dir (`app.getPath("temp")`) — so **Windows**
`%LOCALAPPDATA%\Temp\karafriends_tmp\`, **macOS** `$TMPDIR/karafriends_tmp/`
(under `/var/folders/…/T/`), **Linux** `/tmp/karafriends_tmp/`:

- `queue.json` — the persisted NotARealDb (see below). **This dir is swept on
  reboot** (macOS wipes `/var/folders/…/T/` at boot), which on 2026-07-25 ate
  the room's whole song history mid-party along with every cached composite.
  The composites are a cache and re-download; the history isn't, so
  `songHistory` is mirrored to `<userData>/song-history.json` and the two are
  merged (union, keyed by typename+songId+timestamp) in `loadDb`. Same
  reasoning as `people.json` and the score cards. Nothing else in here
  survives a sweep — don't put durable state in this dir.
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
- `yt-<ytid>.log`, `joysound-<songId>.log` —
  yt-dlp / ffmpeg logs. Read these first when a download or compose fails.
- `<damId>-<idx>.mp4`, `dam-<damId>.log` — DAM predownloads.

## Architecture

Four Parcel bundles from `src/` (`main`, `renderer`, `remocon`, `common`) plus
a Rust `.node` addon in `native/` for audio I/O and port reservation. See
`docs/architecture.md` for the tour.

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

### The settings manifest (`src/common/settings/`)

**To surface that setting in the UI, add it here — not to each settings
screen.** The TV sidebar (`renderer/Sidebar.tsx`) and the remocon panel
(`remocon/components/RoomSettings/`) both render one pure-data manifest, so a
setting is a single edit rather than two that can disagree. They used to be
hand-maintained lists and had drifted: Scoring and Edit Break Message existed
only on the phone, Scoring sat under MICROPHONE despite not being a mic
setting, and the same value went by two names on the two screens.

- `useRoomSettings()` calls every setting hook unconditionally, in a fixed
  order, and returns a keyed map of `{value, set}`. That's what satisfies the
  rules of hooks _once_ and lets the manifest stay data. Add the `Control`
  here.
- `manifest.ts` declares the entry: section, label, hint, and a `kind`
  (`toggle` / `slider` / `select` / `presets` / `break` / `action`) with a
  `get` accessor. Slider bounds are in **display** units (percent, dB) with
  `toDisplay`/`fromDisplay` converting.
- Each surface owns only a presenter (`SettingRow.tsx`, one per surface)
  switching on `def.kind`. Don't add rendering logic to the manifest.
- `surfaces: ["remocon"]` marks entries meaningless on the other screen (e.g.
  "hide the TV settings panel" would hide its own switch). `visibleWhen` hides
  a row conditionally (Gate Threshold under Pitch Gate).
- Things that **aren't** synced settings — the mic pickers, mic level meters,
  the hostname picker, the service-health rows — are per-surface
  `sectionExtras` slots keyed by section, not manifest entries.
- Actions (`editBreakMessage`, `recheckServices`, `clearQueue`) are typed by
  id, so adding one is a compile error until both surfaces implement it.
- **Hints render inline on both surfaces.** Don't put explanations in `title=`
  tooltips; nobody hovers a television.
- The TV grid is drag-resizable to 180px. `1fr` is `minmax(auto, 1fr)`, so a
  long `.settingLabel` (or a `<select>`'s widest `<option>`) sets the column
  and pushes the value column off the clipped edge — labels wrap in the narrow
  container query for exactly this reason.

### Key subsystems

Subsystem deep-dives live next to their code and load automatically when you
work in those directories: **`src/common/CLAUDE.md`** (JOYSOUND video pipeline,
YouTube MV auto-picker, video ↔ karaoke sync, guide melody) and
**`src/renderer/CLAUDE.md`** (piano roll, sidebar + pop-out windows, BGM).

These stay here — the first two are whole-app contracts, the third spans
`scripts/`, `main/`, and `remocon/`:

- **Queue advance is callback-chained with no self-healing**: songs advance
  only via media events → `pollQueue` → mutation callbacks in
  `renderer/Player.tsx`. One broken link (e.g. a song-start path that never
  reaches `play()` and so never fires `ended`/`error` — the uncaught JOYSOUND
  telop fetch used to be one) wedges the whole app: `playbackState` stuck on
  PLAYING, stale "Now Playing", no BGM, silent room until relaunch. Every
  song-start path must terminate in `play()` or `pollQueue()` (`.catch`
  included), and a poll watchdog in Player (PLAYING + video never started +
  no pop/hold in flight → resume the queue) backstops anything missed.
- **Service health** (`serviceHealth` / `recheckServiceHealth`): live
  DAM/JOYSOUND reachability check (periodic + per-song-transition + manual
  "Check now"). Gate the per-song trigger on a **real** song transition — the
  Player polls `popSong` every ~5s while idle, which will otherwise hammer the
  services.
- **Avatar portraits** (`scripts/getPortraits.mjs`, `main/portraits.ts`,
  `remocon/components/PmdPortraitPicker`): the avatar picker runs off a
  **local mirror** of PMDCollab SpriteCollab (no external requests at
  runtime). The build sparse-clones just `portrait/` + `tracker.json` and
  packs ~48k 40×40 PNGs into a single `extraResources/portraits/portraits.pack`
  (~78MB, content-deduped) plus a `portraits.json` manifest of
  monster/form/emotion names and byte offsets; delete those files to force a
  refresh. The main process serves `/portraits/index.json` and
  `/portraits/<form path>/<emotion>.png` on :8080; the remocon fetches the
  manifest once and searches it client-side. Picked URLs are stored
  **host-relative** (`/portraits/...`) — the remocon resolves them against its
  own origin, the renderer via `resolveProfilePictureUrl`
  (`src/common/profilePicture.ts`); pre-mirror avatars remain absolute
  raw.githubusercontent.com URLs and still work.

## Service failures (yt-dlp, DAM, JOYSOUND)

When a YouTube MV won't download, or DAM/JOYSOUND 403s from a blocked exit
IP, use the **`karaoke-service-troubleshooting`** skill — it has the yt-dlp
staleness/429 playbook and the two independent DAM network gates (geo on the
auth hosts, anonymizer reputation on the CDN) with the `403`/992-byte
fingerprint and how to pick a proxy exit that clears both.

Two things to know without opening it: yt-dlp and ffmpeg are downloaded by
`scripts/getExternalResources.mjs` into `extraResources/` (gitignored) at
build time, and the **search path (youtubei.js) and the download path (yt-dlp)
are independent** — search can work perfectly while downloads are bot-walled.

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
