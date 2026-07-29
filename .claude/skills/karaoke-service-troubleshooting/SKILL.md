---
name: karaoke-service-troubleshooting
description: Diagnose karafriends download and streaming failures — YouTube MVs that won't download (yt-dlp stale / HTTP 429 / "Sign in to confirm you're not a bot"), and DAM or JOYSOUND failures from a blocked exit IP (CDN 403, login 403, VPN/proxy selection). Use when a song fails to download, playback 403s, service health goes red, or you're picking a VPN/proxy exit.
---

# Karaoke service troubleshooting

Two independent failure families. Identify which one you're in before changing
anything — conflating them wastes hours.

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
4. Avoid `player_client=tv` — it hit DRM-protected formats here.
5. **A stale binary is not the only cause — check for HTTP 429 first.** If the
   log shows `HTTP Error 429` on "Downloading webpage" followed by the bot
   message, the binary is fine and the **exit IP is rate-limited**; no yt-dlp
   version will fix it. Cycle the VPN (or wait — it expires on its own).

**We pass a JS runtime.** yt-dlp only enables `deno` by default, and with no
runtime it can't run YouTube's player JS, so it falls back to clients YouTube
bot-walls (`android_vr`) and warns that JS-less extraction is deprecated.
`youtubeJsRuntimeArgs()` points it at **Electron's own binary running as Node**
(`--js-runtimes node:${process.execPath}` plus `ELECTRON_RUN_AS_NODE=1` from
`youtubeSpawnEnv()`, which the runtime inherits) — no extra runtime to ship.

Note the search path (youtubei.js) and the download path (yt-dlp) are
**independent** — search can work perfectly while downloads are bot-walled.

The per-song request-count invariant (`-f bv+ba/b`, `-map 0:v:0 -map 1:a:0`,
no-retry-on-429) lives in `src/common/CLAUDE.md`, next to the code it constrains.

## DAM / JOYSOUND network gates

- DAM's `cds1-clubdam...ipcasting.jp` CDN **403s from datacenter/VPN exit
  IPs** (IP-reputation filtering on commercial video), independent of the app
  — the official DAM Windows client fails on the same network state and
  unblocks when the VPN is toggled. This is not a karafriends bug; the service
  health check is the intended mitigation (warn + let you cycle VPN without a
  restart). JOYSOUND has no video CDN, so it never hits _this_ block — but it
  is geo-restricted in its own right; see below.
- Separately, DAM's **auth host `win10.clubdam.com` (CloudFront) geo-blocks
  non-Japan IPs** with a 403 `text/html` page — so login itself fails off-VPN
  (opposite polarity from the CDN case above). `MinseiAPI.login` detects the
  non-JSON body and throws a descriptive error, and both credentials
  providers use `memoizeWithFailureEviction` so a failed login is retried on
  the next request instead of staying cached until relaunch. **JOYSOUND is
  geo-blocked the same way**: from a non-JP address `sound-cafe.jp` answers
  403 with no `set-cookie` at all, so `parseCookies`' `invariant` _throws_
  rather than degrading, and its search APIs 403 identically (measured from a
  US exit, 2026-07). The manual "check now" health check
  (`recheckServiceHealth`) is the
  recovery path after changing networks: it forces a fresh check (bypassing
  the in-flight dedupe), resets both credential caches for a from-scratch
  re-login, and fails fast (2 attempts + a 30s hang ceiling per service) rather
  than sitting in `getMusicStreamingUrls`'s default ~17-minute
  `promiseRetry` backoff, which playback paths intentionally keep.
- **Two independent gates, and conflating them wastes hours.** The auth hosts
  (`win10.clubdam.com`, `sound-cafe.jp`) filter on **geo**; DAM's CDN filters
  on **anonymizer reputation** (`proxy:true` in commercial IP feeds). A
  datacenter IP can pass the first and fail the second, which is exactly what
  a VPN looks like. CDN fingerprint: a blocked exit gets `403` with exactly
  **992 bytes** and `x-oke-front1-time: 0.000` for _any_ path — rejected at
  the edge before token lookup — while a good exit gets a normal error with
  `X-Oke-Middle-Via` present, i.e. it reached the origin.
  `scripts/dam-exit-check.sh [http://user:pass@host:port]` scores any exit or
  candidate proxy against all three gates.
- **Cycling the VPN is no longer the fix — NordVPN is dead for this.** Its
  whole Japan pool (293 IPs / 10 prefixes) is `proxy:true`, on
  Datacamp/PacketHub/Hydra. Tokyo burned prefix-by-prefix over years; Osaka
  was a _single_ prefix (`187.14.x`, 36 IPs), so when it was listed in 2026-07
  every Osaka server died at once with no gradual degradation. **A plain
  cloud/hosting exit can still work**: the CDN filters on `proxy`, so an exit
  scoring `proxy:false, hosting:true` is orthogonal to the flag that matters —
  score candidates with `dam-exit-check.sh` before committing to one. Set
  `proxyEnable` + `proxyHost/Port/User/Pass` in
  config.yaml and the whole app routes correctly: `main/index.ts` exports
  `http_proxy` so spawned ffmpeg inherits it for the CDN leg,
  `youtubeSpawnEnv()` strips it back out so yt-dlp keeps the real residential
  IP (a datacenter exit gets bot-walled far harder), and `main/proxyAgent.ts`
  covers the `damApi`/`joysoundApi` **static logins** — those call out through
  node-fetch and would otherwise escape the proxy while every other call
  succeeded, which is a maddening failure to diagnose.
- Some songs are catalog-present but streaming-absent
  (empty `mModelMusicInfoList`, `GetMusicStreamingURL` returns NG) — a
  physical-machine-only license. Scoring reference data may still work.
