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
- **Pitch**: native addon detects pitch over **25ms** windows (`sample_rate/40`);
  PianoRoll polls every 25ms and feeds `ScoreAccumulator.addSample`.
- **Formula**: `overall = 0.7·accuracy + 0.3·coverage`.
  - **accuracy**: per note, `max(frame-average on-pitch, best sustained
on-pitch stretch)`, pooled across notes by voiced-frame count. The
    best-sustained-stretch term (`SUSTAIN_FRACTION` in scoring.ts) was added
    this session so short notes the singer hit aren't dragged down by the
    boundary frames where the 25ms window blends adjacent pitches.
  - **coverage**: per note, fraction of its expected 25ms slots that got any
    sample, summed across notes (so it's time-weighted — long notes dominate).
- **Latency compensation**: a sung pitch reaches the scorer late (output path
  the singer reacts to + input/ADC/USB capture path). `ScoreAccumulator` shifts
  every sample back by `micLatencyCalibrationMs` (config, fixed, per-machine)
  `+` live `AudioContext.outputLatency` (added in Player at song start).
  **macOS/cpal cannot report the input path** (its capture timestamp is just
  the buffer size), so the fixed part is _measured_, not derived. Dev machine:
  ~80ms calibration (measured total ~105ms − ~25ms live output).
- **Bands** (`BAND_THRESHOLDS`): SSS ≥0.95, SS ≥0.90, S ≥0.80, A ≥0.70,
  B ≥0.55, C ≥0.40, else D.

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
   `ScoreAccumulator` at the app's actual compensation, and/or bin per-note by
   duration (throwaway scripts were used this session; not committed).

**Leaving the probe on indefinitely**: fine — the app writes the log itself (no
terminal), each line is songId-tagged so a whole session splits cleanly by
song, and the per-day file is in userData (survives an OS temp sweep). Turn the
flag off when done collecting to stop the writes.

## Gotchas (learned the hard way this session)

- **The sweep's "estimate" is a latency measurement, not the score the app
  shows.** It reports a deliberately-conservative plateau midpoint; the app
  applies the config offset, which can read a few points higher. The overall
  score jitters ~20pts of coverage across a few ms near note-slot boundaries.
  To know what the app scored, run the real `ScoreAccumulator` at the app's
  actual compensation — don't quote the sweep number.
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
2. **Re-tune band thresholds.** Best-frame credit lifted overall scores ~5pts,
   so the S ladder set earlier is now slightly easy. Needs several more takes
   across song types to recalibrate against real distributions.
3. **Visually confirm a live-sung card.** Everything is offline-validated;
   nobody has watched a real card render with the compensation + best-frame
   applied. First sung song after this build settles it.
4. **100–150ms notes are unresolvable** (~8% of a typical song) — near the 25ms
   detector's limit, hit only ~36% of the time even generously. Only a DSP
   change (onset-aware / shorter adaptive detection window in the native addon)
   would recover them; deferred as a real project.

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
