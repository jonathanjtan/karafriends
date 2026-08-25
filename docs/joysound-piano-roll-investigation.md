# Investigation: Joysound piano-roll / pitch-scoring data

Status: **parked, not worth the hassle right now** (last touched 2026-07-04).
This doc records why karafriends currently has no piano-roll target line for
Joysound songs, what was ruled out, and what the only remaining path would
require, so this doesn't need to be re-researched from scratch if revisited.

## Symptom / motivation

`PianoRoll.tsx` draws a target-pitch line during playback, but only for DAM
songs. Joysound songs only show the singer's live-detected pitch trace, with
no reference line to sing against. The question: does Joysound expose
pitch/melody reference data ("piano roll") anywhere we could hook into, the
way DAM does?

## What DAM does (the working analog)

`src/main/damApi.ts`'s `getScoringData(requestNo)` hits `POST
/cwa/win/minsei/scoring/GetScoringReferenceData.api` on `win10.clubdam.com`,
returning a binary blob. `PianoRoll.tsx` consumes this via a `scoringData:
readonly number[]` format with DAM-specific field names
(`damTimeWindowIntervalCount`, `pogIntervalCount`; "Perfect On Guide" is DAM
scoring terminology). This is the only piano-roll renderer in the app; there
is no Joysound-specific equivalent.

## What was checked on the Joysound side

- **`src/main/joysoundApi.ts`** (current integration, talks to
  `sound-cafe.jp`): full read of every endpoint, namely
  `getArtistListByKeyword`, `getMovieUrls`, `getSongDetail` (HTML-scraped),
  `getSongListByArtist`, `getSongListByKeyword`, `getSongRawData` (returns
  `{ slc, telop, ogg, streaming_wifi_url }`), `login`. **No pitch/scoring
  endpoint exists.**
- **`src/common/joysoundParser.ts`** (parses the proprietary `telop`
  binary/JOY02 format returned by `getSongRawData`): the parsed
  `JoysoundTelopData` interface has `metadata`, `lyrics:
JoysoundLyricsBlock[]` (chars, furigana, romaji, scroll/fade timing), and
  `timeline`. Lyrics only, zero pitch/note fields anywhere in the format.
- **`src/renderer/JoysoundRenderer.tsx`**: only renders lyrics text/timing;
  no pitch-line drawing logic exists for Joysound songs.
- **`docs/architecture.md`**: already documents this. The piano-roll target
  line only draws "if the song has DAM scoring data."

**Conclusion: `sound-cafe.jp`, our current Joysound data source, has no
pitch/melody data in any endpoint we've found, and never will via this
endpoint set**. It's a different, more limited product than what actually
carries piano-roll scoring.

## Official developer path: JOYSOUND Smartphone Library (JSL)

Found via `camp.joysound.com/renkei_lp/dev/jsl/`: an official SDK providing
karaoke playback, synced lyrics, and scoring/grading to licensees. **Dead end
for a hobby project**: strictly B2B ("企業様向け"), requires emailing
`data-license@xing.co.jp`, a custom quote, a signed contract, and per-song
licensing fees. Declines individual/hobbyist inquiries. Doesn't document
whether raw pitch/melody data is even exposed to partners vs. just
pre-rendered scoring results.

## The actual carrier of this feature

Xing's own consumer apps, **"カラオケJOYSOUND"**
(`jp.co.xing.karaokejoysound`) and **"カラオケJOYSOUND＋" / "JOYSOUND+"**,
are a separate product from `sound-cafe.jp`, and explicitly advertise
real-time pitch-graph/piano-roll scoring ("リアルタイムで採点でき、歌った
音程がピアノロールでわかります"). Freemium model: ~170,000 songs, 3
free songs/day with ads, ¥250/month for the unlimited pass. No prior
reverse-engineering work or API write-ups for this app were found in search
unlike DAM, where enough prior art existed to build `damApi.ts`'s scoring
endpoint from scratch. This would be new territory.

## What it would actually take to find this API

Live traffic capture from the real app, since there's no public API docs and
no known runtime data-format docs to statically infer from:

1. Install the real app on an Android device via a real Google account.
2. Run a MITM proxy (mitmproxy / HTTP Toolkit) between the phone and the
   internet, with its CA cert trusted on-device.
3. Play one of the 3 free daily songs, capture the request(s) that fetch the
   scoring/pitch reference data.
4. Feed the captured request/response back for format reverse-engineering
   and client/parser implementation (same pattern as `damApi.ts` +
   `joysoundParser.ts`).

Open unknowns that make this a real gamble, not just busywork:

- **Certificate pinning**: modern Android doesn't trust user-installed CAs
  by default unless the app opts in via network security config. If this
  app pins its cert, capture needs root/Magisk or a rooted emulator,
  meaningfully more setup than a stock MITM proxy.
- Unknown whether the song-ID space/session model would even be compatible
  with grafting onto the existing `sound-cafe.jp`-based Joysound
  integration, or would need to be a fully parallel data source.
- Unclear how much of the catalog needs the paid pass vs. is visible on the
  free tier for capture purposes.

This is a from-scratch, hands-on reverse-engineering effort requiring a
physical Android device and active investigation time, not something
inferable from documentation or existing code. **Decision: not worth the
hassle right now**, parked here in case it's revisited later.
