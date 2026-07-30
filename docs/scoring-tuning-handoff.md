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

  **This changes what future probe logs look like.** They carry ~2.5x the lines
  (a night is ~15-22MB rather than 6-9MB), and because `ScoreAccumulator` still
  buckets to 25ms slots and keeps the _closest_ reading per slot, each slot now
  picks the best of ~2.5 candidates instead of the only one. Expect live scores
  to sit slightly above what the same singing would have scored before — small,
  but unmeasured until there is a 10ms-hop corpus. **Re-check `DISPLAY_CURVE`
  once one exists**; the current fit is from 25ms-hop traces, which replay
  unchanged.

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
    notes with a locatable onset — a gap in front and quiet before it. `null`
    below 6 such notes, which is common; the median attack error is reported as
    a tendency but never scored.
  - A `null` axis is filled with the take's own **pitch**, not renormalized
    away: renormalizing makes a song with no held notes systematically easier.
  - **coverage** is no longer in the headline. Across the corpus it varied
    mostly with what the pitch tracker managed to voice, not with the singing;
    it survives on `ScoreResult` as a diagnostic.
- **Latency compensation**: a sung pitch reaches the scorer late (output path
  the singer reacts to + input/ADC/USB capture path). The config value
  (`micLatencyCalibrationMs` + live `AudioContext.outputLatency`) is now only a
  **seed**: `finalize()` fits the compensation per take within ±120ms of it,
  judged on `pitchScore` — the same axis the headline leads with, so a fitted
  take can never score worse on pitch than the seed would have. The fit walks
  out from the peak and returns the plateau midpoint (the surface is flat and
  wide around the truth, so the argmax is noise), and refuses any fit that
  wouldn't beat the seed.
  **macOS/cpal cannot report the input path** (its capture timestamp is just
  the buffer size), so the seed is still _measured_, not derived. Dev machine:
  ~80ms calibration (measured total ~105ms − ~25ms live output). The **median
  of `ScoreResult.compensationMs` across a night is an estimate of the
  machine's real latency**, which is a cheaper way to re-derive that constant
  than a probe session.
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

## Gotchas (learned the hard way this session)

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
  `~/Library/Application Support/karafriends/score-cards/`).
- Verifying anything scoring-related end-to-end needs a real mic — the model is
  validated offline against captured takes, but a live-sung card has never been
  eyeballed rendering. See open item #3.

## Where this stands

The scoring rebuild described in `scoring-scorecard-proposal.md` is implemented:
the trace-keeping accumulator, the weighted-axis formula on a display curve, the
per-take latency fit, the note-ribbon card, play counts, persisted scores, the
history-recording gate, the melody mirror, and the 10ms pitch hop.

**Everything measurable offline has been measured.** What has never happened is
somebody singing a song on this build. That single act closes three open items
at once (#1, #2, #3 below), so it is worth doing before anything else here.

## Open items / next steps

Ordered by what unblocks the most.

1. **Sing one song and watch the card.** Nobody has seen a live-sung card render
   — not the ribbon, not the play-count line, not the personal best. Everything
   about them is offline-validated or built-and-typechecked only. This is the
   longest-standing gap in this doc.
2. **Confirm the 10ms poll loop against a real microphone.** `PitchFramer` is
   unit-tested against synthetic tones and the addon exports the new binding,
   but `pollPitch` has never run with a live mic. A "not a function" or a
   mis-shaped batch would show up in the first second of singing.
3. **Capture a corpus on the new framing and re-check `DISPLAY_CURVE`.** Live
   scores will read slightly above the 25ms-hop corpus the curve was fitted on,
   because `ScoreAccumulator` still buckets to 25ms slots and now picks the
   closest of ~2.5 readings per slot instead of the only one. Small, unmeasured,
   and only measurable with new singing. Probe logs are ~2.5x bigger now too
   (~15-22MB a night).
4. **Surface scores on the remocon.** The data is there (`scores.json`,
   `scoreHistory`) and nothing reads it yet. The phone is where people actually
   re-read a result; the TV card is gone in nine seconds.
5. **Write the vibrato detector.** The 10ms hop makes rate measurable — a unit
   test recovers 5.5Hz / ±50 cents from a synthetic tone, which the old framing
   could not represent at all. The detector itself (4.5-8Hz band, coherence
   gate, ≥3 cycles) still has to be written against
   `ScoreAccumulator.samples()`, and validated on singing rather than a
   synthesised tone. Depth is probably already measurable; rate was the blocker.
6. **Redefine stability on held notes.** Frame-to-frame wobble measured 12-22
   cents across every take in the corpus — the tracker's own noise floor, not
   the singers. If it earns an axis it should be drift from note start to end,
   and worst excursion within the note, where the corpus does show spread.
7. **100-150ms notes** (~8% of a typical song) were unresolvable at a 25ms hop,
   hit only ~36% of the time even generously. The 10ms hop gives them 2-3x the
   readings; whether that is enough is untested and needs #3.
8. **Scoop/fall counting** needs takes where somebody deliberately scooped, to
   set a gate against. The prototype swung between 0% and 50% of notes on gate
   choice alone.
9. **A vocal-range readout** needs octave-corrected range estimation first: the
   2nd percentile of detected pitch was MIDI 42-44 on every corpus take, which
   is F2 for singers who plainly were not there.

## Decisions waiting on a human

None of these block the work above; they change what it should look like.

- **Is the band distribution right?** The curve puts 54 real takes at D:1 C:7
  B:11 A:18 S:12 SS:5. Whether a fifth of a party reading C-or-below is honest
  feedback or a bad night out is a product call, and it is one table to change.
  SSS is currently set above the best take ever recorded, so it is reachable but
  unearned — also a choice.
- **`micLatencyCalibrationMs` is 80; the corpus fits ~105.** The per-take fit
  absorbs the difference, so this is not urgent, but a better seed makes better
  fits. `ScoreResult.compensationMs` across a night re-derives it.
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

54 takes from 25–26 July 2026 — six singers, two nights, one room. Every
JOYSOUND song from those nights whose probe trace survived; the one DAM take
(`3747-03`) can't be replayed because DAM ships its own scoring blob rather than
a melody we extract.

That is one room's worth of singing, and the display curve is fitted to it. It
is enough to tell a rough take from a strong one; it is not enough to know how a
different room sings.

## Where the code is

- `src/common/scoring.ts` — axes, weights, `DISPLAY_CURVE`, `BAND_THRESHOLDS`,
  `SCORING_FORMULA_VERSION`, `placeSamples`, `fitCompensation`,
  `ScoreAccumulator`.
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
  snapshot and diff across a change.
- `scripts/backfillMelodies.mjs` — rebuild a lost melody cache.
- `scripts/measureMicLatency.mjs` — the original latency sweep. Largely
  superseded by the per-take fit; still the way to establish a seed on a new
  machine.
