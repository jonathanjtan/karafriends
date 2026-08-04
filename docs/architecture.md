# Architecture

Karafriends is built on **Electron**, a framework that wraps a Chromium-based
browser and a Node.js runtime into a single desktop application. If you've
used VS Code, Slack's old app, or Discord, you've used Electron.

Electron applications have a **main process** (full Node.js with file system,
network, and OS access) plus one or more **renderer processes** (sandboxed
browser windows that show UI). They communicate over a structured message
channel called IPC. Karafriends extends that model by adding two more
browser-style UIs that run _outside_ Electron — on guests' phones — and by
calling into a Rust library for low-level audio.

This page describes each of those pieces and how they talk to each other.

## The five processes

```
                  ┌─────────────────────────────────────────────┐
                  │           Electron main process             │
                  │   (Node.js, runs on the renderer machine)   │
                  │                                             │
                  │  • Express HTTP server on port 8080         │
                  │  • Apollo GraphQL endpoint at /graphql      │
                  │  • mDNS responder for karafriends.local     │
                  │  • DAM / JOYSOUND / YouTube / Niconico      │
                  │    HTTP clients                             │
                  │  • Loads native Rust audio module           │
                  └─────────────────────────────────────────────┘
                            ▲                       ▲
                            │ IPC + GraphQL         │ HTTP + GraphQL
                            │ (in-process)          │ (over Wi-Fi)
                            ▼                       ▼
        ┌───────────────────────────────┐  ┌───────────────────────────────┐
        │  Renderer (Electron window)   │  │  Remocon (mobile browsers)    │
        │  — runs on the TV computer    │  │  — runs on each guest's phone │
        │                               │  │                               │
        │  • Plays video / lyrics       │  │  • Search songs               │
        │  • Shows queue, QR code       │  │  • Queue / pause / skip       │
        │  • Reads mic via Rust module  │  │  • Send emotes                │
        │  • Draws pitch graph          │  │  • Type adhoc lyrics          │
        └───────────────────────────────┘  └───────────────────────────────┘
                            ▲
                            │ contextBridge
                            ▼
                  ┌──────────────────────┐
                  │  Preload script      │
                  │  (privileged bridge) │
                  └──────────────────────┘
```

### 1. The main process — [src/main/](../src/main/)

Entry: [src/main/index.ts](../src/main/index.ts).

The main process is the brain. When the app starts it:

- Opens an inspector port (so you can attach a debugger).
- Starts an **mDNS** responder so the hostname `karafriends.local` resolves
  to this machine on the local network ([src/main/mdns.ts](../src/main/mdns.ts)).
- Creates an Express HTTP server listening on the **remocon port** (8080 by
  default) and mounts:
  - The **GraphQL** endpoint at `/graphql`, served by Apollo Server
    ([src/main/graphql.ts](../src/main/graphql.ts)).
  - A **reverse proxy** that, in dev, forwards every other request to the
    Parcel dev server so phones load the remocon UI from there
    ([src/main/middleware/remoconReverseProxy.ts](../src/main/middleware/remoconReverseProxy.ts)).
    In production, that middleware just serves the built remocon bundle
    statically.
- Creates a fullscreen Electron `BrowserWindow` and loads the **renderer**
  HTML into it.
- Registers a custom `karafriends://` URL scheme that serves files out of a
  temp folder. The renderer uses this to play locally-downloaded videos.

The main process also owns the **GraphQL resolvers** for everything backed
by external services: querying DAM/JOYSOUND, fetching YouTube/Niconico
metadata, kicking off video downloads with `yt-dlp` and `ffmpeg`. Each
external API has its own client class — [damApi.ts](../src/main/damApi.ts)
and [joysoundApi.ts](../src/main/joysoundApi.ts) — written as Apollo REST
data sources with retry and caching wrappers.

### 2. The renderer — [src/renderer/](../src/renderer/)

Entry: [src/renderer/index.tsx](../src/renderer/index.tsx).

This is the UI shown on the TV. It's a React app. Specifically:

- `Player.tsx` plays the current song — HLS video for DAM, downloaded
  files for JOYSOUND/YouTube/Niconico, with a `<video>` element doing
  the work. Lyrics overlay on top.
- `JoysoundRenderer.tsx` parses JOYSOUND's binary lyric format and draws
  the lyrics in the JOYSOUND visual style (colored highlights, furigana,
  romaji mode). It uses Kuroshiro for kanji-to-kana conversion.
- `AdhocLyrics.tsx` shows lyrics that someone typed into the remocon for
  a YouTube/Niconico song.
- `PianoRoll.tsx` draws the pitch-scoring graph using WebGL shaders
  ([renderer/shaders/](../src/renderer/shaders/)). It reads the singer's
  detected pitch from the Rust module and compares it to the song's
  scoring data (provided by DAM).
- `Queue.tsx` shows the queue and `QRCode.tsx` shows the QR code guests
  scan.
- `Effects.tsx` subscribes to the `emote` GraphQL subscription and pops
  emoji characters across the screen when guests send them.
- The settings sidebar (toggle with the `Q` key) lets the operator pick
  which audio input devices are microphones.

The renderer talks to the main process two ways: through the **preload**
bridge for native audio access, and through GraphQL over HTTP/WebSocket
to localhost (yes, the renderer talks to the same GraphQL endpoint that
the phones do — there's nothing special about being in the same process).

### 3. The remocon — [src/remocon/](../src/remocon/)

Entry: [src/remocon/index.tsx](../src/remocon/index.tsx).

This is the UI the _guests_ use, loaded in their phone browsers. Same
codebase, different bundle target. It's also a React app, organized into
pages routed by `react-router`:

- `HomePage.tsx` — the search-method tile grid (DAM title / DAM artist /
  JOYSOUND title / JOYSOUND artist / YouTube / Niconico).
- `SongSearchPage.tsx`, `ArtistSearchPage.tsx`, equivalents for JOYSOUND,
  `YouTubePage.tsx`, `NiconicoPage.tsx` — the actual search forms.
- `SongPage.tsx`, `JoysoundSongPage.tsx` — song detail with a "queue"
  button.
- `HistoryPage.tsx` — past songs.
- `AdhocLyricsPage.tsx` — the lyrics-entry form for YouTube/Niconico
  songs.

A footer `ControlBar` is always visible with pause/skip/pitch controls,
and a top `NavBar` shows what's playing.

The remocon is just a website. The Electron app happens to serve it, but
a phone's browser knows nothing about Electron. Communication is GraphQL
over HTTP for queries/mutations and over WebSocket for subscriptions
(queue changes, now-playing changes, emotes).

The remocon also installs a **service worker**
([notificationServiceWorker.ts](../src/remocon/notificationServiceWorker.ts))
so it can show a desktop/mobile notification when your queued song is
about to start.

### 4. The preload script — [src/preload/index.ts](../src/preload/index.ts)

Electron renderer windows are sandboxed for security — they can't `require`
Node modules directly. A **preload** script runs in the renderer process
before the page loads, with privileged access, and it can selectively
expose APIs to the page via `contextBridge`.

Karafriends' preload exposes two things to `window.karafriends`:

- `karafriendsConfig()` — reads the config from the main process over IPC.
- `nativeAudio.*` — wraps the Rust native module so the renderer can list
  input devices, start a pitch-detecting stream on one, read the latest
  detected pitch, and stop it.

Everything else the renderer needs (song queue, GraphQL) it gets over
HTTP/WebSocket, which doesn't need preload privileges.

### 5. The native Rust audio module — [native/](../native/)

A Rust crate compiled to a Node-native module (`.node` file) via the
[Neon](https://neon-bindings.com/) framework. Two sub-crates:

- `karafriends-lib` — the pure library:
  - `lib.rs` opens audio input/output devices through **cpal** (a
    cross-platform audio I/O library) and pipes mic samples through a
    ring buffer to the pitch detector. It also drives audio output, so
    karaoke audio paths through native code (allowing the reverb module
    to mix into the singer's mic).
  - `pitch_detector.rs` runs an FFT-based pitch detection on incoming
    mic samples and reports the singer's note as a MIDI number plus a
    confidence value.
  - `reverb_module.rs` adds reverb to the mic signal — the kind of
    cheap echo effect that makes everyone sound better in karaoke.
- `karafriends` — the Neon-binding shim that re-exports
  `karafriends-lib` functions as JS-callable functions
  (`inputDevices`, `inputDevice_new`, `inputDevice_getPitch`, etc.).

On Windows the build can optionally use **ASIO** for lower-latency audio
(`cargo build --features asio`); this requires Steinberg's ASIO SDK, which
the `getExternalResources` script downloads automatically.

## How the pieces communicate

There are essentially three communication channels:

### GraphQL (queries, mutations, subscriptions)

The schema lives at [src/common/schema.graphql](../src/common/schema.graphql).
Both the renderer and the remocon use it.

- **Queries** for static-ish data (config, current song, song search
  results, video metadata).
- **Mutations** for actions (`queueDamSong`, `popSong`, `removeSong`,
  `setPitchShiftSemis`, `setPlaybackState`, `sendEmote`, `pushAdhocLyrics`).
- **Subscriptions** for push updates (`queueChanged`, `currentSongChanged`,
  `playbackStateChanged`, `emote`, `currentSongAdhocLyricsChanged`).

Subscriptions ride a WebSocket; the rest is plain HTTP. Both endpoints
are served by the same Express app in the main process on the remocon
port.

On the client side, both UIs use **Relay** — Facebook's GraphQL client.
Relay does compile-time code generation: a tool called `relay-compiler`
reads the `graphql\`...\``template literals in`.tsx`files, validates
them against the schema, and produces TypeScript types and runtime
artifacts in`**generated**/` folders next to each component. You'll see
these generated files referenced as imports — they're real code, just
re-derived from the schema and the queries every build.

### Electron IPC

Used only between the main process and the renderer window:

- Reading the config (`ipcMain.on("config", ...)`).
- The renderer reloading itself via global Ctrl+R / F5 shortcuts.

This is _not_ used for queue operations — those go through GraphQL even
when the caller is the same machine, because the same code paths work
from the phones.

### Preload context bridge

Used only between the renderer page and its preload script. Exposes:

- The Rust native audio module (input device enumeration, pitch
  detection).
- A synchronous IPC read of the config.

The remocon has no preload script and no access to any of this — it's
just a regular website.

## What happens when a song is queued

A concrete walk-through:

1. A guest taps **Queue** on the JOYSOUND song page in their phone's
   remocon. Their phone fires the `queueJoysoundSong` GraphQL mutation
   over HTTP at `http://karafriends.local:8080/graphql`.
2. mDNS resolves the hostname to the renderer machine. Express routes
   `/graphql` to Apollo. Apollo invokes the `queueJoysoundSong` resolver
   in the main process.
3. The resolver kicks off two parallel jobs: a `yt-dlp` download for the
   accompanying YouTube video (JOYSOUND songs are paired with a YouTube
   ID in this codebase) and a JOYSOUND API call to fetch the binary
   lyrics file. Both stream into the temp folder.
4. The resolver appends the song to the in-memory queue and emits a
   `queueChanged` PubSub event.
5. Every subscriber to `queueChanged` — both phones and the TV
   renderer — receives the update over their WebSocket. Phones update
   their queue UI; the TV updates its sidebar.
6. When the previous song ends, the renderer calls the `popSong`
   mutation, which returns the next queue item. The renderer downloads
   the video via the `karafriends://` protocol if it isn't already
   local, hands the URL to its `<video>` element, parses the lyrics
   into the JOYSOUND renderer, and playback starts.
7. As the song plays, the renderer reads pitch samples from the Rust
   module and draws the piano-roll graph. If the song has DAM scoring
   data, it draws the target pitch line as well.

## Where the build tools fit

- **Parcel** is the bundler. The four build targets (main, preload,
  renderer, remocon) are declared in `package.json`. Each target gets
  its own bundle with the right environment context (`electron-main`,
  `electron-renderer`, `browser`).
- **TypeScript** for all the JS code. tsconfig.json governs both
  bundles.
- **Babel** with `babel-plugin-relay` so Parcel can hand off the Relay
  `graphql` tagged-template processing to the Relay compiler.
- **Cargo** builds the native Rust module via the
  `cargo-cp-artifact` shim, which puts the compiled `.node` file where
  the JS code expects it.
- **electron-packager** + **7zip** produce the final distributable
  bundle ([packager.js](../packager.js)) for end users.

External binaries used at runtime — `ffmpeg` (transcoding) and `yt-dlp`
(YouTube downloads) — aren't built; they're fetched as releases by
[scripts/getExternalResources.mjs](../scripts/getExternalResources.mjs)
during the `build-native-*` step and packaged into the app's
`extraResources/` folder. On Windows the same script downloads
Steinberg's ASIO SDK headers for the optional ASIO audio backend.

## Other curiosities

- **decryptor/** at the repo root contains a couple of Python scripts.
  These are unrelated to the running app; they're standalone tools that
  understand the encrypted file format DAM uses, kept here for
  reference.
- **static/dict/** contains the Kuromoji NLP dictionary
  (gzip-compressed `.dat` files) used at runtime by Kuroshiro for
  kanji parsing. Parcel copies the `static/` folder into each bundle's
  output directory at build time.
- **tunnel.yaml** is a Cloudflare tunnel config; it's a stretch
  capability for exposing your jukebox over the internet, but it isn't
  required and isn't used by the default dev loop.
- **Error reporting**: there is none. Upstream wired Sentry into the
  main process and both browser bundles, but the hardcoded DSN pointed
  at upstream's own project — this fork was shipping crash reports to
  someone else's dashboard and reading none of them. It was removed;
  uncaught errors go to the console. Adding it back means our own DSN,
  read from `config.yaml` rather than hardcoded.
