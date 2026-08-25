# src/common: download / compose / DSP subsystems

Loaded when working under `src/common`. Root `CLAUDE.md` has the always-on
rules (unhandled rejections kill `main`, queue-advance contract, temp-dir map).

## JOYSOUND video pipeline

`videoDownloader.ts` → `downloadJoysoundData`: fetches telop + ogg, optionally
downloads a YouTube background video via yt-dlp, composites them with ffmpeg,
extracts the guide melody, and pushes to the queue. Falls back to JOYSOUND's
own default video if the YouTube path fails.

## YouTube MV auto-picker

`suggestedYoutubeVideos` in `main/graphql.ts` (documented here because it feeds
this pipeline). JOYSOUND-only (DAM has no youtubeVideoId concept). Searches
YouTube via **youtubei.js** (`Innertube`), then ranks candidates by a **trust
tier** (artist's own channel / bracketed `[Official Video]` tag /
official-title plus related-channel), with duration-closeness only a
within-tier tiebreak, song-name-in-title as a hard filter, and an exclusion
list of cover/karaoke/lyric/live keywords (English + Japanese + Korean +
Thai). **The Innertube client is created with `lang: "ja", location: "JP"`.**
Without it, YouTube machine-romanizes JP titles (e.g. 晩餐歌 → "Bansanka"),
which breaks the song-name filter and hides the JP exclusion keywords.

## Keep the per-song request count at one extraction

The MV fetch uses `-f bv+ba/b` so the downloaded file carries its own audio,
which `computeYoutubeIntroOffsetMs` reads off disk. It used to be `-f bv`
(video-only) plus a _second_ `-f ba` extraction just for intro-sync, two full
extractions per song, four on a failing song once both retried, which is how we
started earning 429s. Because the MV file now has an audio track, the composite
**must** map streams explicitly (`-map 0:v:0 -map 1:a:0`); default selection
only picks the ogg by luck of channel count (3.0 vs stereo). Retries back off
(`YOUTUBE_RETRY_BACKOFF_MS`) and are **skipped entirely on a 429/bot-wall**
(`isYoutubeRateLimited`). Retrying a wall can't succeed, it just deepens it.

When downloads actually fail, see the `karaoke-service-troubleshooting` skill.

## Video ↔ karaoke sync (`computeYoutubeIntroOffsetMs`)

Three stages.

(1) A coarse (100ms) envelope scan collects _every_ local correlation peak per
anchor as a candidate offset. Never trust any single anchor's argmax: on
riff-repetitive songs a phrase-aliased ghost offset (one repetition off) can
outscore the truth at coarse resolution (desynced 新宝島 by 3s, alias 10400ms
vs true 7350ms).

(2) Each candidate is refined **drift-tolerantly** on a fine (10ms) envelope:
every anchor reports its own best offset within ±1s of the candidate and the
score-weighted median wins. Karaoke re-recordings genuinely wander by hundreds
of ms across a song, so demanding one exact offset at every anchor collapses
honest candidates (this null'd 残酷な天使のテーゼ into a bogus onset fallback).

(3) Top candidates are ranked by **guide-melody salience**: Goertzel on-pitch
vs off-pitch power in the MV audio at the times each offset predicts for the
extracted guide-melody notes. Envelope correlation only measures "loud in the
same places", which aliases fake convincingly (残酷な天使のテーゼ's envelope
actually prefers a wrong-by-1.7s alias at the head); whether the melody's
_pitches_ sound there is what they can't fake. On every measured song melody
separates true from alias by ≥0.37 where envelope margins were ~0.05 or
inverted. Envelope ranking (with confidence gates) is only a fallback when
melody data is missing or its ranking is ambiguous.

The salience ranking is **transposition-aware**: a JOYSOUND re-recording need
not share the master's key (Piano Man 15410 sits exactly a semitone below Billy
Joel's own upload), and an off-by-a-semitone melody lands between the on-pitch
probes and the ±1.5/±2.5 off-pitch ones, so every candidate scores ~0.2 and the
whole stage silently abstains. Candidates are ranked once per semitone shift
and the shift with the best peak wins, giving **one shift for the whole
ranking**. Otherwise each candidate cherry-picks a flattering key and the
margin gate goes soft.
A repetitive song can still tie up the margin gate (Piano Man's 34s-away phrase
alias sits 0.29 behind), so a winner that is **top of both the melody and the
envelope ranking** is accepted on that corroboration alone: aliasing is exactly
the case where the two disagree, so this can't fire on the cases the margin gate
was built for.

After an offset is picked (by any method), **`measureVideoDriftAround`** checks
the tempo actually matches: some MV uploads are speed-shifted (ロミオとシンデレラ's
9HrOqmiEsN8 runs 1.2% fast, a smooth 3.3s of drift across the song that no
constant offset can fix). Per-anchor local peaks are collected across the whole
track (multiple peaks per anchor, as an alias can outscore the honest peak at
any single anchor, and a greedy predict-then-search walk got poisoned by
exactly that), a RANSAC pass keeps the max-inlier-weight line (same-track pairs give
non-drifting songs a ~0-slope winner → no stretch), and a fine refit along it
yields the rate; the video's timestamps are then rescaled to the karaoke's tempo
(`stretchJoysoundVideoPromise`, a copy-codec `-itsscale` remux, no re-encode)
and the head offset drift-corrected (`F·intercept`) before the usual trim/pad.

A drift fit is a claim that **no** constant offset works, and it is made from
envelope peaks alone, so `constantOffsetBeatingDrift` cross-checks it against
the guide melody before anything gets rescaled, scoring the stretched map
(`t/F + intercept`) against the best constant offset near the seed. A karaoke
re-recording that merely _wanders_ non-linearly hands the RANSAC fit a
convincing line through half the song: Piano Man's true offset traces
−1800 → −1050 → −2750ms, a Λ no rate fits, and stretching to that line lands the
last chorus ~3.7s out. This also caught the fit overwriting 残酷な天使のテーゼ's
already-validated −11900ms with −10799ms plus a 1.6% stretch. Two traps: the
comparison **must run on every note**, not a subsample (a constant offset's
error is uniform but a wrong rate's grows through the song, so which notes get
sampled swung the drift score by 0.2, enough to flip the verdict; refining the
offset on a sample is fine), and the seed may have come from onset alignment, so
the check re-derives the transposition itself.

Positive offset → `-ss` trim; negative (karaoke has extra head material, e.g. a
count-off) → frozen-first-frame front-pad. When cross-correlation is
inconclusive (the common case, since a karaoke re-recording rarely
envelope-correlates with the original master) it falls back to **onset
alignment** (`estimateOnsetOffsetMs`): detect where the music starts in each
track and align those points (already-aligned songs → ≈0, so it's
self-limiting). Only when onset also can't locate both starts do we give up
(null) and leave the heads at t=0. There is **no end-together pad** anymore.
The old "assume the video and song end together" fallback blindly shoved the
whole video several seconds late, desyncing songs whose heads were already
aligned (this was the Senbonzakura/Dry-Flower bug).

With any measured offset the video plays once and **holds its last frame** for
the uncovered tail (so the MV's outro plays in full); only the null case still
loops (a possibly-short default video shouldn't freeze). Intro-sync reads the
MV's audio **out of the already downloaded video file** (the `-f bv+ba/b`
fetch), so it costs no extra YouTube request. Optional per-queue via
`youtubeVideoSyncEnabled` (a default-on remocon checkbox; null = enabled for
old clients).

## Guide melody (`common/guideMelody.ts`, `renderer/damGuideMelody.ts`)

- JOYSOUND's getFME ogg is **3.0-channel vorbis with the guide melody isolated
  on the FC channel** (channel index 2 in Web Audio). It's ffmpeg-decoded and
  pitch-tracked (autocorrelation) at download time into DAM-scoring-binary
  format, cached as `-melody.bin`.
  - Tracker gotcha: use a **full lag scan every frame**. Narrowing the search
    around the previous frame locks onto 2/3-subharmonics at melodic leaps.
  - Octave outliers are folded against **local context** (`OCTAVE_CONTEXT_SECS`
    either side), not the song's overall median. Against the global median the
    fold clips any melody wider than its threshold. 40 of 53 cached melodies
    sat pinned exactly at it, and Dancing Queen (21 semitones in DAM's chart)
    had 18 of 204 notes moved, its genuine low notes folded up an octave and
    its real tracking errors folded _twice_, past where they started. A wide
    melody reaches its extremes through its neighbours; a tracking error is an
    isolated note 15-25 semitones off the notes either side of it, which is
    what local context tells apart. Costs nothing in scoring either way (the
    scorer octave-folds deviations). This is what the piano roll draws.
  - Extraction output is versioned (`GUIDE_MELODY_EXTRACTION_VERSION`, stored
    in word 5 of the blob). **Bump it whenever a change here would yield a
    different note track from the same audio**: `joysoundMelody.ts` reads an
    older version as a cache miss, and both callers of
    `ensureJoysoundGuideMelody` already hold the audio (the ogg on download,
    the composited video on a cache hit), so healing costs an ffmpeg decode and
    no network. Without the bump, every already-cached song silently keeps the
    old chart forever.
- **Comparing a derived chart against DAM's authored one for the same song**
  (the two services' recordings drift by up to a second across a track, so
  re-fit the offset per window or the melodies look like they disagree): the
  charts agree on 97-99% of frames by pitch class, with no phantom notes. What
  differs is segmentation. DAM subdivides held notes onto a ~200-300ms grid
  while the extraction holds one long note, which costs about a point of pitch,
  since `noteCredit`'s sustain rescue wants an unbroken on-pitch run of half
  the note. Scratch tooling for this lived in `.claude/repro/chart-compare/`.
- **The extracted melody is almost never in the octave the singer sings in.**
  Measured over the 56 song/take pairs that have both a cached melody and a
  probe trace (`scripts/measureGuideOctave.mjs` reproduces it): the reference
  sits **one octave above the singer on 33, two octaves above on 20, and in the
  same octave on only 3**. Remove whole octaves and the residual median is
  **0.03 semitones**. The pitch classes are exactly right, only the register is
  displaced. Two causes stack, and neither is a defect: JOYSOUND's guide synth
  plays above notation (see the register capping above; `F0_MAX_HZ` is 1500 to
  reach tones around D6), and people sing in whichever octave suits them.
  - Consequence for anything comparing this melody to a human: **do not use
    absolute pitch.** `common/vocalRange.ts` octave-normalises against the
    singer's own band before asking any question (`songOctaveShiftFor`), and
    reads tessitura as duration-weighted percentiles rather than min/max, since
    min/max is exactly the statistic the displaced notes poison.
  - Scoring is unaffected. It octave-folds every deviation, deliberately, so
    that singing in your comfortable octave costs nothing.
- DAM streams are plain stereo (no isolated guide channel), so the guide is
  **synthesized locally** from the scoring reference data with scheduled
  oscillators, tracking the video clock across play/pause/seek.
