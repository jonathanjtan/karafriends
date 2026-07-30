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

## Open items / next steps

1. ~~Tag songId in the probe and split multi-song logs.~~ **Done** — each
   PROBE_PITCH line is `PROBE_PITCH <songId> <videoTime> <midi> <shift>`, and
   `measureMicLatency.mjs` splits by song (`--song` to pick when several).
2. ~~Re-tune band thresholds.~~ **Superseded.** The ladder sits on the displayed
   number with `DISPLAY_CURVE` in between, so the formula and the scale move
   independently — re-fit the curve, not the ladder. Currently fitted to the
   54-take corpus by placing each band boundary at a chosen quantile, giving
   38.8–96.6, mean 80.4, bands D:1 C:7 B:11 A:18 S:12 SS:5 SSS:0.
   `scripts/replayScoring.mjs` prints that distribution.

   **Fit it on more than one room.** The first version of this curve was fitted
   to 29 takes — all that survived a temp sweep — and that subset turned out to
   be biased toward the better half of the room: on the full 54 it read about 4
   points generous at the median and put a fifth of all takes into C.

3. **Visually confirm a live-sung card.** Everything is offline-validated;
   nobody has watched a real card render with the compensation + best-frame
   applied. First sung song after this build settles it.
4. **100–150ms notes** (~8% of a typical song) were unresolvable at a 25ms hop,
   hit only ~36% of the time even generously. The 10ms hop gives them 2-3x the
   readings; whether that is enough is untested, and needs a corpus captured on
   the new framing.
5. **Vibrato is unblocked but unbuilt.** `PitchFramer` recovers a 5.5Hz / ±50
   cent vibrato from a synthetic tone (a unit test asserts it), which the old
   framing could not represent at all. Nothing yet reads that: the detector
   described in the proposal — 4.5-8Hz band, coherence gate, ≥3 cycles — still
   has to be written against `ScoreAccumulator.samples()`, and validated on real
   singing rather than a synthesised tone.

## Data captured so far

- **God Knows** (124975): latency ~105ms; A→S with compensation. Log was
  overwritten (both takes teed to the same path).
- **Vaundy 怪獣の花唄** (485151): latency ~104ms (consistent with God Knows —
  calibration is stable across takes). Scored **S**: 81.2% raw → 86.2% with
  best-frame credit. Log at `/tmp/latency-run.log` (until next capture
  overwrites it).

## Where the code is

- `src/common/scoring.ts` — the formula, bands, `ScoreAccumulator`,
  best-frame credit.
- `src/common/config.ts` — `micLatencyCalibrationMs`, `pitchProbeEnabled`.
- `src/renderer/Player.tsx` — compensation assembly (config + live output),
  card reveal, screenshot trigger.
- `src/renderer/PianoRoll.tsx` — pitch poll, the PROBE_PITCH capture (gated,
  songId-tagged; songId is passed in from Player purely for this).
- `src/main/index.ts` — score-card screenshot handler + probe-log file
  appender (both write under userData).
- `native/karafriends-lib/src/lib.rs` — pitch detection, the pitch ring (now
  drops stale audio, not fresh, on a late poll).
- `scripts/measureMicLatency.mjs` — the latency sweep / calibration tool.
