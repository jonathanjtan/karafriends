# Glossary

A quick reference for terms used in this codebase and its docs. Split
into karaoke-domain terms and stack/tooling terms.

## Karaoke domain

**DAM**
A major Japanese karaoke service operated by Daiichikosho. Real DAM
machines are the boxes you see in karaoke booths in Japan; their
back-end is also available to consumer apps through an account-gated
API. Karafriends pretends to be one of those apps. Acronym for "Daiichi
Karaoke Multimedia". See `damApi.ts`.

**DAMtomo**
DAM's consumer-facing membership program. The `damUsername` /
`damPassword` config fields are DAMtomo credentials.

**JOYSOUND**
The other major Japanese karaoke service. Functionally similar to DAM
but operated by Xing. JOYSOUND songs are paired with a YouTube video ID
in this codebase because the karaoke video itself is hosted on YouTube;
the lyrics and timing data come from JOYSOUND's API. See
`joysoundApi.ts`.

**Niconico** (also "Nico Nico Douga")
Japanese video sharing site, comparable to a smaller YouTube. Used as a
fallback video source for songs that aren't on the other three.

**Remocon**
Short for "remote control"; Japanese-loanword shorthand for the smart-
phone UI guests use to drive the jukebox.

**pax**
Short for "passenger"; the codebase uses it to mean "guest" (a non-
admin remocon user). The `paxSongQueueLimit` config caps how many
songs an individual guest can have queued at once.

**Romaji**
Japanese written in Latin letters instead of kanji/kana. JOYSOUND
lyrics can be displayed in "romaji mode" so non-Japanese-readers can
sing along phonetically.

**Furigana**
Small phonetic annotations (in hiragana) placed above kanji characters
in Japanese text, to indicate pronunciation. JOYSOUND lyrics include
furigana data; karafriends renders them as small text above kanji using
the constants in [common/constants.ts](../src/common/constants.ts).

**Kuroshiro / Kuromoji**
A Japanese NLP library (Kuroshiro) and the morphological analyzer it
uses (Kuromoji). Karafriends uses them to convert kanji to kana or
romaji on the fly, for the JOYSOUND renderer.

**Adhoc lyrics**
A karafriends feature: when queueing a YouTube/Niconico song, the
queue-er can paste in their own lyrics. The remocon displays one line
at a time and a button to advance to the next line; the renderer
mirrors that on the TV. Lets guests sing along to songs with no
existing lyrics data.

**Scoring / pitch graph / piano roll**
The piano-roll-style visualization that shows the singer's detected
pitch versus the song's target pitch. Real karaoke machines do this to
give a "score" at the end of a song. Karafriends draws the graph but
does not (yet) tally a final score.

**Vocal type**
DAM songs come in versions: NORMAL (instrumental only), GUIDE_MALE
(with a male guide vocal), GUIDE_FEMALE (female guide vocal), UNKNOWN.
The remocon's song page lets the queue-er pick which version to play.

## Stack and tooling

**Electron**
A framework that combines a Chromium-based browser engine with a
Node.js runtime, letting you ship a web app as a native desktop
application. Karafriends is an Electron app.

**Main process / renderer process / preload**
Electron's three-tier architecture. The **main process** is full-power
Node.js; the **renderer** is a sandboxed browser page; the **preload**
is a privileged shim that runs before the page loads and selectively
exposes Node APIs to it. See [Architecture](architecture.md).

**IPC**
"Inter-process communication" — Electron's named-channel message bus
between main and renderer processes. Karafriends uses it for one thing:
the renderer asking the main process for the config.

**GraphQL**
A query language for APIs. Clients describe the shape of data they
want; the server returns exactly that shape. Karafriends uses GraphQL
as the single API between the main process and both the renderer and
the remocon. The schema is at
[src/common/schema.graphql](../src/common/schema.graphql).

**Apollo Server**
A popular Node.js implementation of a GraphQL server. Mounted into
Express in [src/main/graphql.ts](../src/main/graphql.ts).

**Relay**
Facebook's GraphQL client library. Unusual in that it does compile-
time code generation: a build step (`relay-compiler`) reads your
`graphql\`...\``template literals, type-checks them against the
schema, and writes generated TypeScript files. The`**generated**/` folders next to components are Relay output.

**Subscription**
A GraphQL feature for server-pushed updates over a WebSocket. Used in
karafriends for `queueChanged`, `currentSongChanged`,
`playbackStateChanged`, `emote`, and `currentSongAdhocLyricsChanged`.

**mDNS**
Multicast DNS. A protocol for resolving hostnames on a local network
without a DNS server. Karafriends responds to mDNS queries for
`karafriends.local`, so guests' phones can reach the jukebox by name
on Wi-Fi. The same technology powers Apple's Bonjour.

**Parcel**
A JavaScript bundler. Compiles TypeScript, packs modules, minifies
output, handles assets. Karafriends declares four bundle "targets" in
`package.json` (main, preload, renderer, remocon) and Parcel produces
a separate bundle for each.

**Yarn PnP**
"Plug'n'Play", Yarn's no-`node_modules` mode. Instead of expanding
zipped packages into a giant `node_modules/` tree, Yarn keeps them
zipped under `.yarn/cache/` and uses a `.pnp.cjs` resolver shim to
serve modules directly out of the archives. Faster and uses less disk,
at the cost of requiring tools to support PnP.

**Husky**
A Git hooks manager. Hooks live under `.husky/`. Karafriends uses
`pre-commit` to run Prettier, TSLint, and rustfmt over staged files.

**Neon**
A framework for writing Node.js native modules in Rust. Karafriends'
native audio module is a Neon module: Rust code that exports
JavaScript-callable functions and gets compiled to a `.node` file the
main process loads at runtime.

**cpal**
A Rust crate that provides cross-platform low-level audio I/O. The
native module uses it to enumerate input devices, open audio streams,
and read mic samples.

**ASIO**
Steinberg's pro-audio driver API, supported on Windows. Provides
lower-latency audio than the default WASAPI backend, at the cost of
needing a separate SDK to build against. Optional, gated behind a
Cargo feature flag (`--features asio`).

**HLS**
HTTP Live Streaming. The streaming format DAM uses for its song video
URLs. Karafriends uses the `hls.js` library to play HLS streams in the
renderer's `<video>` element.

**yt-dlp**
A command-line program for downloading from YouTube and many other
video sites. Karafriends spawns `yt-dlp` (and `ffmpeg`) to fetch
YouTube/Niconico/JOYSOUND-companion videos to local disk before
playback. Both binaries are bundled in `extraResources/` at build
time.

**ffmpeg**
The general-purpose audio/video processing tool. Used here for
transcoding and remuxing downloaded videos.

**Sentry**
A SaaS error-tracking service. Karafriends wires Sentry into the main
process and both browser bundles to report uncaught exceptions. The
DSN is hardcoded; if you fork, replace or remove it.
