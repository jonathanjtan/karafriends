# Scoring tuning — handoff

Working doc for the in-flight effort to tune the experimental karaoke scoring
(the end-of-song score card) using **real sung performances**. Written for
continuity across a context compaction. Durable facts also live in the memory
file `scoring-latency-calibration`.

## Goal

Make the score _feel right_: reward good singing, credit what the singer
actually hits (short notes especially), and land the bands (D…SSS) where a
strong take reads as S and a great one as SS/SSS. We tune against captured
takes rather than guessing, because the reference data carries no scoring
rules — the formula is entirely ours (`src/common/scoring.ts`).

## How scoring works right now

- **Reference melody**: JOYSOUND getFME ogg → extracted guide melody, or DAM's
  scoring blob. Both parse (`src/common/scoringData.ts`) to notes
  (start/end/midi) + lyrics intervals. No thresholds or weights in the data.
- **Pitch**: the native addon analyses **25ms** windows (`sample_rate/40`) and
  slides them every **10ms** (`sample_rate/100`), in Rust. `get_pitches()`
  returns every reading since the last call, each carrying an `ageMs` so
  PianoRoll can place it at the moment it was sung rather than at the poll.
  How often JS polls now affects only batching, not resolution — and nothing is
  discarded when a poll runs late, which it does routinely.

  Confirmed live: the median gap between probe readings on a sung take is
  **10.00ms**. Logs carry ~2.5x the lines (a night is ~15-22MB rather than
  6-9MB).

  **The denser sampling is worth free points, and the size is now measured.**
  `ScoreAccumulator` still buckets to 25ms slots and keeps the _closest_ reading
  per slot, so each slot picks the best of ~2.5 candidates instead of the only
  one — a tighter deviation for identical singing. Scoring one take at both
  densities (`replayScoring.mjs --decimate-hop 25`, which thins a capture to the
  old rate) puts it at **+3.9 raw points of pitch** and ~+1.4 of long tone. That
  is ~0.027 of raw overall, worth ~1 display point at the top of the curve where
  it is compressed and **~2 points in the A/B/S range** where most singing lands.
  So `DISPLAY_CURVE` reads about two points generous. It has not been re-fitted:
  doing that properly needs a 10ms corpus on the current formula, and there are
  three such takes.

- **Formula**: `overall = 0.65·pitch + 0.20·longTone + 0.15·timing`, then a
  display curve. Each axis is 0..1.
  - **pitch**: per note, `max(graded frame average, best sustained on-pitch
stretch)`, averaged over **every** reference note (an unsung note counts
    zero). Note-averaged, not frame-pooled, so one held note can't outweigh a
    verse, and so the headline and the 24-window graph are the same measurement.
    Credit is **graded** — full inside 50 cents, ramping to zero at 125 — which
    removed the boundary jitter the old hard 1.0-semitone step caused.
  - **longTone**: over reference notes ≥1s, how much of each the singer held on
    pitch. `null` when the song has no held notes.
  - **timing**: consistency (interquartile spread) of note attacks, only for
    notes with a locatable onset — a rest in front of the note in the reference
    melody, and no voicing in the run-up. `null` below 6 such onsets; the median
    attack error is reported as a tendency but never scored.

    Onsets are located in **continuous time**. They used to be quantised onto a
    25ms grid built from `floor((timeSecs − compensation) / 25ms)`, which slid
    wholesale whenever the per-take fit moved: a **1ms** change in compensation
    moved the qualifying set 25 → 22 onsets, swung the spread 71.6ms → 45.1ms,
    and flipped the headline band between SS and SSS. Over the same 1ms the
    pitch axis moves 0.2 points. 15% of the score was noise. Post-fix the same
    sweep is flat from 100–109ms.

    **Sample size is the axis's real weakness.** The corpus median is ~10
    qualifying onsets from ~400 notes, and takes still go `null` outright. Two
    gates control this and they are **not** interchangeable — see
    `ONSET_SILENT_SLOTS` in `scoring.ts` for the test that distinguishes them.

  - A `null` axis is filled with the take's own **pitch**, not renormalized
    away: renormalizing makes a song with no held notes systematically easier.
    Timing additionally **ramps** toward pitch as its onset count falls
    (`timingConfidence`), reaching zero exactly at the `null` threshold so the
    two meet continuously.
  - **coverage** is no longer in the headline. Across the corpus it varied
    mostly with what the pitch tracker managed to voice, not with the singing;
    it survives on `ScoreResult` as a diagnostic.

- **Latency compensation**: a sung pitch reaches the scorer late (output path
  the singer reacts to + input/ADC/USB capture path). The config value
  (`micLatencyCalibrationMs` + live `AudioContext.outputLatency`) is now only a
  **seed**: `finalize()` fits the compensation per take within ±120ms of it,
  judged on `pitchScore` — the same axis the headline leads with, so a fitted
  take can never score worse on pitch than the seed would have. The fit walks
  out from the peak and returns the plateau midpoint, and refuses any fit that
  wouldn't beat the seed.

  **The fit identifies a real quantity — this was checked, not assumed.**
  Plotting `pitchScore` against compensation across 0–200ms on three sung takes
  (`.claude/fit-surface.mjs` in a worktree, trivially rewritten) gives a
  well-defined peak each time, 11–18 points above the floor, all landing at
  **80–90ms**. Earlier worry that the surface was flat and the argmax noise was
  wrong. Two caveats: a take with almost no singing has no peak to find (one
  1441-sample take peaked at 8.8% pitch and "fitted" 0ms), and **DAM takes
  cannot be checked this way at all** — see the blind spot below.

  **macOS/cpal cannot report the input path** (its capture timestamp is just
  the buffer size), so the seed is still _measured_, not derived. On the dev
  machine the true total is **~85ms**, and the seed is
  `micLatencyCalibrationMs + AudioContext.outputLatency`. The older ~105ms
  figure came from 25ms-hop data and reads high.

- **Bands** (`BAND_THRESHOLDS`) sit on the **displayed** number, not the raw
  composite, so retuning the formula means re-fitting `DISPLAY_CURVE` and
  leaves the ladder alone: SSS ≥97, SS ≥93, S ≥87, A ≥78, B ≥68, C ≥55, else D.

## The data-collection loop

1. Set `pitchProbeEnabled: true` in config.yaml (macOS dev:
   `~/Library/Application Support/Electron/config.yaml`; packaged:
   `~/Library/Application Support/karafriends/config.yaml`).
2. Launch the app however you normally do — Finder double-click is fine for the
   packaged app. **No terminal capture or `tee` needed**: while the flag is on,
   the app writes samples itself to `<userData>/probe-logs/probe-<date>.log`
   (packaged: `~/Library/Application Support/karafriends/probe-logs/`; dev:
   under `.../Electron/`). A `PROBE_PITCH capture enabled` breadcrumb also
   prints to the renderer console if you want to confirm the flag took.
3. Sing one or more songs, full voice, **no seeking** (a seek resets the
   tally), let each end naturally. A day's songs append to the same dated file.
4. `node scripts/measureMicLatency.mjs --log <that probe-<date>.log> --melody
$TMPDIR/karafriends_tmp/joysound-<songId>-melody.bin [--song <songId>]` →
   latency sweep. Each PROBE_PITCH line carries the songId, so a multi-song log
   is split automatically; with several songs the tool lists them and wants
   `--song` to pick one (and the matching `--melody`).
5. For scoring behaviour (not latency), replay the samples through the real
   `ScoreAccumulator` at the app's actual compensation with
   `node scripts/replayScoring.mjs` — it finds every take in the probe logs,
   prints a table, and can snapshot/diff results across a change (`--out`,
   `--diff`). `ScoreAccumulator.samples()` exposes the per-sample trace for
   metrics that don't live in `finalize()`.

**Leaving the probe on indefinitely**: fine — the app writes the log itself (no
terminal), each line is songId-tagged so a whole session splits cleanly by
song, and the per-day file is in userData (survives an OS temp sweep). Turn the
flag off when done collecting to stop the writes.

## The melody cache, and why the corpus was lost once

`replayScoring.mjs` needs two things per take: the probe log and the song's
extracted guide melody. The logs live in `userData` and are safe. The melodies
used to live only in the temp dir — and macOS sweeps `/var/folders/.../T/` by
**age**, roughly three days untouched, not only on reboot. The 25–26 July
melodies were gone by 30 July and every corpus take reported "no cached melody".

Melodies are now **mirrored to `<userData>/melodies/`** as they are extracted
(`src/main/joysoundMelody.ts`). The temp copy stays the primary read path — it
sits beside the composited video, where the rest of the pipeline looks — and a
mirror hit is restored into the temp dir on the way past, so a swept cache heals
itself on the next play instead of re-running an ffmpeg decode and a pitch-track
pass. `replayScoring.mjs` searches `userData` first, then temp.

This does not bring the original corpus back: those melodies predate the mirror.
Re-queueing each song regenerates them. The numbers recorded in this doc and in
`docs/scoring-scorecard-proposal.md` are the measurements the formula was
calibrated on, and can't be re-derived until that happens.

The composited videos are a genuine cache and should keep expiring — they
re-download. A melody is a few KB of deterministic output per song and is the
one offline-scoring input that can't be reconstructed from a log.

## Gotchas (each of these cost real time)

- **`measureMicLatency.mjs` is now largely redundant for tuning.** The app
  fits the compensation itself per take, so the config value only has to be in
  the right ballpark; `ScoreResult.compensationMs` across a night is the better
  estimate. The sweep is still the way to establish that ballpark on a new
  machine. Either way, don't quote the sweep number as a score — run
  `replayScoring.mjs` for that.
- **Per-machine / per-output-device.** The calibration is specific to this
  machine and its current output. Bluetooth vs wired output alone swings the
  live term tens of ms (that part auto-adjusts; the fixed part doesn't).
- **Score cards auto-save** to `<userData>/score-cards/` as
  `<timestamp>_<song>_<band>_<score>.png` on every reveal (packaged:
  `~/Library/Application Support/karafriends/score-cards/`). These PNGs are the
  only record of a take's card, and they are genuinely useful to measure — the
  dead band in the layout was found by scanning one for rows of uniform
  background.
- **`run-dev` and the packaged app do not share anything.** Separate userData,
  so separate `config.yaml`, `scores.json`, `song-history.json`, `melodies/` and
  `probe-logs/`. A take sung under `run-dev` writes nothing the packaged app can
  see, and `pitchProbeEnabled` set in one is not set in the other. This has cost
  a whole take's trace at least once.
- **`historyRecordingEnabled` defaults off in dev**, and it gates `recordScore`
  as well as `songHistory`. Under `run-dev` no score is persisted at all, which
  is correct but looks like a bug when `scores.json` never appears.
- **Two takes of one song in one night** used to merge into a single impossible
  take in `replayScoring.mjs` — they share a `<log stem>/<songId>` key. Split on
  the video clock restarting now; the first take keeps the bare key so older
  snapshots still diff.

## Where this stands

The scoring rebuild described in `scoring-scorecard-proposal.md` is implemented
and **has been sung on**. As of 2 Aug 2026 the card has rendered live, the 10ms
hop is confirmed against a real microphone at a 10.00ms median, `scores.json`
persists with `personId` and formula version, and the latency fit is confirmed
to identify a real peak.

The formula is at **v3** (`SCORING_FORMULA_VERSION`). Scores are only compared
within a version, so the v1 records from 1 Aug do not compete as personal bests.

What changed after the first live takes, all measured against the 54-take
corpus with `replayScoring.mjs --diff`:

- **v2** — timing onsets moved off the sliding 25ms grid into continuous time,
  and quartiles interpolated. Fixed a 12-point swing per millisecond of fitted
  compensation. Confined to timing: pitch, long tone, coverage and all 24
  buckets are identical on every corpus take. Display +0.65 mean.
- **v3** — onset gate widened 150ms → 80ms (corpus median 7 → 10 onsets,
  unscorable takes 18 → 12) and timing blended toward pitch by onset count.
  Display −0.04 mean against v1: v2's rise was the grid artifact, v3 returns it.

**The one thing still unrendered is the personal-best line.** It needs two takes
of one song at the same formula version, and the version has moved twice.

## Open items / next steps

Ordered by what unblocks the most.

1. **Rewrite `DISPLAY_CURVE` against a current corpus.** It is fitted to
   25ms-hop traces scored under **v1**, and is stale on both counts: the denser
   sampling is worth ~2 display points (measured, see above) and the timing axis
   is a different measurement now. This is the largest known inaccuracy in the
   score. It needs singing — a night's worth, not a take.
2. **Surface scores on the remocon.** The data is there (`scores.json`,
   `scoreHistory`) and nothing reads it. The phone is where people actually
   re-read a result; the TV card is gone in nine seconds. No new data needed —
   this is the biggest thing that can be built today.
3. **Raise timing's sample size, or stop scoring it.** ~10 qualifying onsets per
   take from ~400 notes, and takes still go `null`. The confidence ramp keeps a
   thin reading from doing much damage but does not make it informative. The
   honest options are a better onset detector or demoting timing to an unscored
   tendency like the median attack error.
4. **Write the vibrato detector.** The 10ms hop makes rate measurable — a unit
   test recovers 5.5Hz / ±50 cents from a synthetic tone, which the old framing
   could not represent at all. The detector itself (4.5-8Hz band, coherence
   gate, ≥3 cycles) still has to be written against
   `ScoreAccumulator.samples()`, and validated on singing rather than a
   synthesised tone. Depth is probably already measurable; rate was the blocker.
5. **Cache DAM scoring blobs so DAM takes can be replayed.** See the blind spot
   below. Four of seven takes on 2 Aug were invisible to every offline tool.
6. **Redefine stability on held notes.** Frame-to-frame wobble measured 12-22
   cents across every take in the corpus — the tracker's own noise floor, not
   the singers. If it earns an axis it should be drift from note start to end,
   and worst excursion within the note, where the corpus does show spread.
7. **100-150ms notes** (~8% of a typical song) were unresolvable at a 25ms hop,
   hit only ~36% of the time even generously. The 10ms hop gives them 2-3x the
   readings; whether that is enough is untested and needs #1's corpus.
8. **Scoop/fall counting** needs takes where somebody deliberately scooped, to
   set a gate against. The prototype swung between 0% and 50% of notes on gate
   choice alone.
9. **A vocal-range readout** needs octave-corrected range estimation first: the
   2nd percentile of detected pitch was MIDI 42-44 on every corpus take, which
   is F2 for singers who plainly were not there.

## The DAM blind spot

Every offline tool here — `replayScoring.mjs`, `backfillMelodies.mjs`, the
latency sweep — works from an extracted JOYSOUND guide melody. **DAM songs ship
their own scoring blob and we never cache it**, so a DAM take leaves a probe
trace that nothing can score.

This is not hypothetical. On 2 Aug, four of seven takes were DAM. They are also
the takes whose fitted compensations looked alarming (10ms, 47.5ms, 62.5ms
against 80-90ms for the JOYSOUND ones) — and there is no way to tell whether
that is a real difference in DAM's reference timing or a bug, because they
cannot be replayed. Caching the blob beside the melody would close this; the
parse already exists in `scoringData.ts`.

## Decisions waiting on a human

None of these block the work above; they change what it should look like.

- **Is the band distribution right?** Under v3 the curve puts the 54-take corpus
  at D:1 C:6 B:16 A:13 S:13 SS:5 SSS:1. Whether a sixth of a party reading
  C-or-below is honest feedback or a bad night out is a product call, and it is
  one table to change. SSS is no longer unearned — a strong God knows take
  reached it on 2 Aug, at 97.6.
- **`micLatencyCalibrationMs` is 80; the 10ms data says it should be ~60.**
  Three sung takes put the _total_ compensation at 80–90ms, and the seed is
  `micLatencyCalibrationMs + AudioContext.outputLatency`. If that live term is
  ~25ms on this machine the constant wants to be ~60. **Confirm the output
  latency before changing it** rather than assuming 25 — that assumption is
  where the old ~105 figure came from. The per-take fit absorbs the error either
  way, so this is accuracy, not urgency.
- **Upstream `dc712b36` ("Upgrade rubato") is not merged here.** It drops the
  FFT resampler's output delay, which _reduces_ monitor latency and therefore
  shifts the right seed above. Worth merging, and worth re-checking the seed
  after.
- **Duets score as the melody line only.** Every open mic feeds one accumulator
  and the per-slot dedupe keeps the closest reading, so a harmony part reads as
  off-pitch. _Beauty and the Beast_ scoring 58.5/C is partly this. Per-mic
  scoring is possible — `pollPitch` already knows the mic index — but mic bleed
  makes attribution unreliable without hard-panned inputs.

## Rebuilding the corpus

If `replayScoring.mjs` reports "no cached melody", the melodies expired (see
above) and the probe logs are still fine. Start the app and run:

```
node scripts/backfillMelodies.mjs
```

It takes every JOYSOUND songId in the probe logs, fetches each song's audio
through the app's own session, and re-extracts. ~8s a song, and melodies now
land in the `userData` mirror where the sweep can't reach them.

## The corpus

54 takes from 25–26 July 2026 — six singers, two nights, one room — **all at the
25ms hop**, plus a handful of 10ms takes from 1–2 August. `replayScoring.mjs`
replays whatever it finds in the probe logs, so the two are mixed in its output;
they are not the same measurement and the mixture is only safe for A/B diffing a
code change, never for fitting.

That is one room's worth of singing, and the display curve is fitted to the old
half of it. Enough to tell a rough take from a strong one; not enough to know
how a different room sings, and no longer enough to place the bands (open item
#1).

DAM takes never enter the corpus at all — see the blind spot above.

## Where the code is

- `src/common/scoring.ts` — axes, weights, `DISPLAY_CURVE`, `BAND_THRESHOLDS`,
  `SCORING_FORMULA_VERSION` (with a changelog comment per version),
  `placeSamples`, `fitCompensation`, `timingScore`, `timingConfidence`,
  `ScoreAccumulator`. The onset gate constants carry the measurements that set
  them — read those before retuning either one.
- `src/common/config.ts` — `micLatencyCalibrationMs`, `pitchProbeEnabled`.
- `src/renderer/Player.tsx` — compensation seed (config + live output), arming
  and revealing, the play-count and personal-best fetches, score recording.
- `src/renderer/ScoreCard.tsx`, `NoteRibbon.tsx` — the card and its ribbon.
- `src/renderer/PianoRoll.tsx` — the pitch poll and the PROBE_PITCH capture.
- `src/main/scores.ts` — persisted scores and `scoreHistoryFor`.
- `src/main/joysoundMelody.ts` — melody extraction, the userData mirror.
- `src/main/graphql.ts` — `songPlayCount`, `scoreHistory`, `recordScore`,
  `backfillGuideMelody`, and the `historyRecordingEnabled` gate on `popSong`.
- `native/karafriends-lib/src/pitch_framer.rs` — the sliding window, its hop,
  and the synthetic-tone tests.
- `scripts/replayScoring.mjs` — replay a corpus, print the distribution,
  snapshot and diff across a change. `--decimate-hop <ms>` thins a capture to a
  coarser hop, which is how the 10ms sampling lift was measured: score one take
  at both densities and the difference is the framing, with the singing held
  constant. It only runs dense → sparse — readings never captured cannot be
  invented, which is why the 25ms corpus cannot answer questions about 10ms.
- `scripts/backfillMelodies.mjs` — rebuild a lost melody cache.
- `scripts/measureMicLatency.mjs` — the original latency sweep. Largely
  superseded by the per-take fit; still the way to establish a seed on a new
  machine.
