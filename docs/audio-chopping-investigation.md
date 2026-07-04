# Investigation: audio chopping during long karaoke sessions

Status: **parked, pick up later** (last touched 2026-07-04). This doc records
what was observed, what was tested and ruled out, and the agreed next steps so
the investigation can resume without re-deriving anything.

## Symptom

After ~3-4 hours of continuous use (mixed Joysound + YouTube queue, songs
played full-length), **audio started chopping out while video kept playing
normally**. Restarting the app fully fixed it. Observed once, on the
deployment machine (not the dev machine). Microphones were routed through an
external hardware mixer, so no in-app mic path was active.

The audio-only + restart-fixes-it signature points at accumulated state in the
app's audio pipeline (renderer AudioContext / Chromium audio service), not at
OS or hardware.

## Relevant architecture

- One reused `<video>` element plays every song (`src` swapped per song via
  the `karafriends://` protocol, which serves files from
  `%TEMP%\karafriends_tmp`).
- Its audio is routed: `MediaElementAudioSourceNode -> GainNode ->
phase-vocoder AudioWorkletNode -> destination` (`src/renderer/webAudio.ts`).
  **All song audio passes through the phase vocoder at all times**, even at
  pitch 0. The worklet itself preallocates buffers and does not allocate per
  block (audited clean).
- BGM (when enabled) is a separate plain `<audio>` element, not routed through
  the AudioContext graph.
- Joysound lyrics render via WebGL (`JoysoundRenderer.tsx`).

## Accelerated repro attempts (dev machine, 2026-07-04)

Method: drive the packaged app headlessly via GraphQL on the remocon port —
queue songs, let each play ~15 s, then `setPlaybackState(SKIPPING)` — while a
sampler logs per-process working set / handles every 10 s.

Useful commands (GraphQL at `http://localhost:8080/graphql`):

```sh
# search (NOTE: small `first` values crash the resolver — see open bugs)
curl -s http://localhost:8080/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ joysoundSongsByKeyword(keyword: \"love\", first: 60) { edges { node { id name artistName } } } }"}'

# queue / skip
# mutation queueJoysoundSong(input: {songId, name, artistName, playtime,
#   userIdentity: {nickname, deviceId}, isRomaji, youtubeVideoId}, tryHeadOfQueue: false)
# mutation { setPlaybackState(playbackState: SKIPPING) }
```

Results:

| Test                                                           | Outcome                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| 18 replays of one cached Joysound song, incl. 10 instant skips | Renderer/GPU CPU and memory flat; ended below baseline          |
| 10 distinct Joysound songs, 15 s each                          | Renderer +281 MB (292→573 MB) — cold media-cache fill           |
| 6 more distinct songs (5 JS + 1 YT), 15 s each                 | Renderer **flat ~550 MB** — cache plateaued and evicts properly |
| Fast-skip race for orphaned lyric render loops                 | No idle CPU growth afterwards                                   |

Conclusion so far: **no unbounded per-song growth reproduces at process level
with short plays on the dev machine.** Renderer memory plateaus at the
Chromium media-cache cap (~575 MB total WS). The original failure either needs
full-length playback over hours (decode-minute-proportional state), or is
specific to the machine it happened on (different audio endpoint, e.g.
HDMI/TV audio).

## Ruled out

- Per-song leaks in `Player.tsx` teardown (hls.js destroyed between DAM songs;
  single `MediaElementAudioSourceNode`; gain is value-set only, no node churn).
- Phase-vocoder worklet allocations (all preallocated; `timeCursor` growth is
  harmless at pitchFactor 1.0).
- Emote/toast DOM accumulation (removed on timeout; subscriptions disposed).
- Native mic loopback path — **not exercised at all when mics go through an
  external mixer**, as they did during the observed failure. (Its issues are
  real for in-app mic users though; see open bugs.)
- Orphaned JoysoundRenderer animation loops via the async-parse race — could
  not trigger it even with instant skips; each new song's cleanup catches a
  lone orphan because the loop keeps rewriting the shared RAF ref.

## Open bugs found along the way (not the chopping, worth fixing)

1. **Joysound session expiry bricks Joysound features until restart.**
   `joysoundCredentialsProvider` in `src/main/graphql.ts` memoizes the login
   cookies for the process lifetime; sound-cafe.jp expires the session after
   ~30-60 min idle. Afterwards every Joysound search/download fails
   (`e.map is not a function` from the search resolver). A party hides this
   (constant use keeps the session warm); a dinner break surfaces it. Same
   restart-fixes-it signature as the chopping — easy to conflate. Fix: detect
   auth failure and re-login (drop the memoized entry), or refresh on a timer.
2. **`joysoundSongsByKeyword` crashes on some requests** with
   `e.map is not a function` instead of returning a clean error (masked the
   session-expiry diagnosis; also reproduced with an expired session
   regardless of `first`).
3. **Bundled yt-dlp trips YouTube bot-detection** ("Sign in to confirm you're
   not a bot") for most videos as of 2026-07; needs a yt-dlp update and
   possibly the new JS-runtime requirement (deno) addressed.
4. **JoysoundRenderer never frees WebGL resources** (textures/programs/buffers
   are created per song, `deleteTexture`/`deleteProgram` never called;
   cleanup only cancels the RAF). Self-limiting because the GL context is
   discarded when the component unmounts, but it's hygiene worth fixing.
5. **Native mic loopback** (`native/karafriends-lib/src/lib.rs`): fixed ~43 ms
   ring buffer between independent input/output clocks with no drift
   compensation; `eprintln!` on the realtime audio callbacks once backpressure
   starts; several `Vec` allocations per callback. Only affects in-app mic
   routing (not external mixers).

## Agreed next steps (the plan when picking this up)

1. **Add an audio watchdog to `src/renderer/webAudio.ts`** (~20 lines):
   every 30 s, log `AudioRenderCapacity` stats (underrun events — Chromium's
   direct "renderer missed audio deadlines" signal; fall back to
   `audioContext.currentTime` vs wall-clock slip if the API is unavailable in
   this Electron), plus JS heap size and uptime. Log via `console` so it lands
   in the main log when launched with logging.
2. **Rebuild and deploy the watchdog build to the machine where the failure
   happened.** The next real karaoke session becomes the experiment: when
   chopping starts, the log pinpoints the minute, whether underruns are
   renderer-side, and what heap/load looked like.
3. Optionally, run a **muted full-length soak on that machine** (not the dev
   machine — a clean result there proves nothing) by keeping the queue topped
   up via the GraphQL commands above for 3+ hours.
4. Launch-with-logging recipe (Windows):
   `cmd /c ""C:\path\to\karafriends.exe" --enable-logging > %TEMP%\kf.log 2>&1"`

## Repro-driving notes

- Queueing a song triggers its download; the queue entry appears only after
  the download finishes.
- `playbackState` mutations: `SKIPPING` seeks to the end and lets `onended`
  pop the next song — closest scriptable analog to the remocon skip button.
- The player polls the queue every 5 s when WAITING, so playback starts within
  ~5 s of the first successful download.
