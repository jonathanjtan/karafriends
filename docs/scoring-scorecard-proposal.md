# Scoring & score card — proposal

Engineering companion to the visual proposal (mocks, distributions, the
before/after cards). This file is the code-level half: what to change, where,
and which claims are backed by measurement rather than taste.

Complements `scoring-tuning-handoff.md`, which describes the current formula and
the probe capture loop. Nothing here has been implemented.

## The corpus this rests on

29 takes, 25–26 July 2026 — every song where a captured probe trace
(`<userData>/probe-logs/probe-2026-07-2{5,6}.log`) and its cached
`$TMPDIR/karafriends_tmp/joysound-<songId>-melody.bin` both survived. Replayed
through the real `ScoreAccumulator` the replay reproduces the saved cards
(`<userData>/score-cards/`) closely: replay mean **77.2** / range **61.8–91.1**
against the saved cards' mean **76.4** / range **60–91** over 49 files, so the
offline harness is a faithful stand-in for the app.

Scratch harness used (not committed): compile `scoring.ts` + `scoringData.ts`
with `tsc` to a temp dir the way `scripts/measureMicLatency.mjs` does, then
replay the probe lines. If this work goes ahead, that harness is worth
committing as `scripts/replayScoring.mjs` — it is the only way to compare two
formulas on identical input.

## Findings

### 1. Coverage is largely measuring our own detector

`overall = 0.7·accuracy + 0.3·coverage`, and coverage answers "did they sing the
song at all". Across the corpus, notes-attempted ran **91–100%** — that question
is already settled for every real take. What coverage actually tracks is how many
25 ms slots the tracker voiced, which is dominated by breath, consonants and
quiet passages.

The clearest case: josh's _Scenes from an Italian Restaurant_ attempted 91% of
its 441 notes and scored **57%** coverage. A 43-point shortfall at a 0.30 weight
is **12.9** points off the headline for singing normally.

Recommendation: demote coverage from a weighted term to a **participation gate**
(no effect above ~60% of notes attempted, damping below), and keep the frame
figure on the card as a diagnostic rather than a score component.

### 2. The displayed scale uses four of seven bands

Over 49 saved cards: no C, no D, no SSS. Range 60–91. `BAND_THRESHOLDS` sits on a
raw ratio, so every formula change moves every band — which is exactly the
re-tuning treadmill open item #2 in the handoff describes.

Recommendation: separate the **formula** from the **display scale**. A monotone
piecewise-linear `DISPLAY_CURVE` maps the raw composite to the shown number, with
band thresholds pinned at fixed display values. Re-tuning the formula then edits
one table instead of the ladder. This is structurally what the commercial screens
do — JOYSOUND's 音程 34.136/40 is not linear in raw pitch accuracy, and their
headline is a sum of generously-curved subscores plus a bounded bonus.

With the curve in the visual proposal, the same 29 takes spread to **48–96** and
all seven bands become reachable (D 1, C 3, B 8, A 9, S 5, SS 3).

### 3. Latency compensation should be fitted per take, and the residual is rhythm

`micLatencyCalibrationMs` is 80 in config, plus ~25 ms live output ≈ **105 ms**
applied. Sweeping compensation per take, the best offset ran **90–312 ms**,
median **130**. Fitting per take recovered up to **11.5** points (Sora's
_Bad Apple!!_ +11.5, _Who's Crying Now_ +10.6, _言って。_ +9.3).

Those are not calibration errors — they are singers sitting behind the beat,
which the current formula charges to _pitch_. Splitting them:

- Fit the offset per take, score pitch at that offset.
- Report the leftover onset timing as a separate axis, so a laid-back singer is
  judged once rather than twice.
- The **median fitted offset across a night is the machine's latency**, so
  `micLatencyCalibrationMs` becomes measurable from ordinary singing instead of a
  dedicated probe session. This corpus says ~105 for the dev machine against the
  configured 80.

Guard rails: fit on the **plateau midpoint**, not the argmax (plateaus are
50–130 ms wide and the argmax lands on noise), and reject a fit that falls
outside a sane band around the configured value.

### 4. Graded tolerance, and note averaging

`ON_PITCH_TOLERANCE_SEMIS = 1.0` is a hard step: 0.99 semitones scores full
credit, 1.01 scores nothing. Full credit inside 50 cents ramping to zero at 125
removes the boundary jitter the handoff describes as "~20 points of coverage
across a few ms".

Frame pooling also lets one held note outweigh a verse. Averaging **per note**
fixes that and makes the headline and the per-note graph read the same number,
which is what lets the card's ribbon and its score agree.

### 5. Do not renormalize over missing axes

The first draft of the composite renormalized over whichever axes were
measurable. Long tone is the axis singers score lowest on (corpus median 47),
so dropping it is a free boost: _言って。_ and _Bad Apple!!_ — the two songs in
the corpus with no note over a second long — both came out straight SS on that
version.

Substituting the take's own pitch score for a missing axis is closer to neutral,
but it still leans the headline harder on pitch. So the card should **show the gap
explicitly** ("—", with the reason) rather than quietly folding it in. The two
biggest climbers under the proposed formula are still those two songs; that is a
known limitation, not a win.

## Metrics: what measured up

| Metric                              | Reference            | Corpus behaviour                                | Verdict                          |
| ----------------------------------- | -------------------- | ----------------------------------------------- | -------------------------------- |
| Pitch (note-avg, soft credit)       | 音程 /40             | 38–87, wide and stable                          | build                            |
| Long tone                           | ロングトーン /10     | 12–92, widest axis after pitch                  | build                            |
| Timing consistency (onset IQR)      | リズム タメ/走り     | 36–251 ms, but median only ~6 clean onsets/song | show; don't weight heavily       |
| Stability                           | 安定感 /30           | 12–22 cents across all takes                    | redefine first                   |
| Vibrato depth / presence            | ビブラート           | 47–142 cents, plausible throughout              | build, with a tightened detector |
| Vibrato rate (and so the type grid) | ビブラート 早い/遅い | pinned at 6.7 Hz on every take                  | blocked on the pitch hop         |
| Scoops / falls                      | しゃくり・フォール   | 0–50% of notes depending on gate                | needs labelled takes             |

### Vibrato: rate is blocked on the framing, depth probably isn't

Extrema counting on the pitch trace returned **6.7 Hz** for every singer on every
song. That is 1/(2 × 75 ms) — three sample slots per half cycle. At a 25 ms hop,
vibrato rate can only land on 10.0 / 6.7 / 5.0 / 4.0 Hz: the detector was
reporting the sampling grid. A sinusoid fit over the residual spread the estimates
out but piled 55 of 158 episodes onto the low edge of the 3 Hz scan bound, which
is slow drift being read as vibrato.

Depth is in better shape. `pitch_detector.rs` already parabola-interpolates the
YIN minimum (`quadratic_peak_pos`), so pitch resolution is sub-bin — roughly a
cent at a typical vocal F0 — and the prototype's depth figures (47–142 cents) were
plausible throughout while rate was nonsense. So JOYSOUND's 3×3 rate×depth grid
is not deliverable today, but **depth and presence/duration probably are**, with a
tightened detector (4.5–8 Hz band, coherence gate, ≥3 cycles).

**What blocks rate is the framing, in two places in `lib.rs`:**

- `pitch_sample_count = sample_rate.div_ceil(40)` — a 25 ms window — and
  `get_pitch()` pops exactly one window per call. One estimate per JS poll,
  windows never overlapping.
- `skip_stale_pitch_samples` _discards_ any backlog beyond the newest window. When
  the 25 ms `setInterval` in `PianoRoll` runs late — which its own comment says
  happens routinely, since it shares a renderer with the WebGL draw loop — that
  audio is thrown away. So the effective hop is ≥25 ms _and_ irregular.

The fix is to move framing into Rust: keep the 25 ms analysis window, slide it
every 5–10 ms, run the detector on its own thread, and return the **series** of
estimates since the last poll (`get_pitch` → `get_pitches`, a vec of
`(offsetMs, midi, confidence, rms)`). Notes:

- The window can stay 25 ms. At 6 Hz it spans 15% of a cycle, so it mildly
  attenuates depth rather than hiding the modulation; shrinking it would hurt
  low-F0 detection instead. Only the hop needs to change.
- YIN here is FFT-based (`realfft`), so O(W log W) — running it 2.5–5× more often
  is affordable, and off the audio callback.
- This decouples analysis resolution from renderer scheduling, which also removes
  the discarded-audio share of the coverage artifact in finding 1, and gives short
  notes more frames to be judged on (handoff open item #4).

One change unblocks vibrato, ornament detection and short notes — but it is a real
DSP project and shouldn't start on the strength of a mock.

### `rubato` does not help here

Asked directly, since upstream `dc712b36` ("Upgrade rubato") is not merged into
this branch and looks relevant. It isn't, for vibrato:

- `rubato` sits only on the **monitor/speaker path**. In `input_data_callback`,
  `pitch_tx.push_slice(&mono_samples)` happens at the raw input rate _before_ the
  reverb and dry/wet mix; the resampler only converts `output_samples` when the
  input and output device rates differ. The pitch feed never touches it.
- Resampling wouldn't help even if it were on that path. Vibrato rate resolution
  is set by how often the detector runs, not by sample rate; upsampling adds no
  information about the modulation envelope.

It does matter for scoring, elsewhere: `dc712b36` swaps `SincFixedIn` for
`rubato::Fft` and drops `output_delay()` frames, **reducing** monitor latency.
Anyone singing through the app's own output is reacting to that path, so merging
it likely shifts the right value of `micLatencyCalibrationMs`. The per-take offset
fit in finding 3 would re-derive that on its own, which is another argument for
doing the fit rather than maintaining a hand-measured constant. If the fit isn't
built first, re-measure the calibration after merging.

### Stability needs a different definition

Frame-to-frame wobble of the octave-folded deviation came out in a **12–22 cent**
band across all 29 takes — the tracker's own noise floor, not a property of the
singers. Naive within-note pitch standard deviation is worse: it reads 400–580
cents on several takes because tracker octave jumps dominate it.

If stability gets an axis, define it on **held notes**, where the corpus does show
spread: drift from note start to note end, and worst excursion within the note.

### Two things not to put on the card

- **No vocal-range (声域) keyboard yet.** The 2nd percentile of detected pitch was
  MIDI 42–44 on every take — F2, for singers who plainly weren't there. Octave
  errors and low-frequency room noise own the tails, so the readout would be
  confidently wrong. Needs octave-corrected, note-anchored range estimation.
- **There is no サビ marker to shade.** DAM's graph labels the chorus from its
  authored blob; the `pogIntervals` we parse are Perfect-On-Guide windows, not
  chorus, and `buildScoringData` leaves them empty for JOYSOUND anyway.
  Instrumental breaks we _can_ mark honestly — `findInstrumentalBreaks` already
  derives them.

## Card scope decisions

Settled while reviewing the mocks, recorded so they don't get re-litigated:

- **No room comparison.** No "vs the room tonight", no ranking against other
  singers, no ▲/▼ deltas. The card stays casual; the only comparison it makes is a
  singer against their own past take, which reads as a personal record rather than
  a scoreboard.
- **Times sung is in**, as a detail rather than a metric: "first time on this one",
  "3rd time you've sung this". It comes free — count occurrences of
  `(typename, songId)` in `songHistory`, which is already mirrored to `userData`
  and already survives a temp sweep. Per-person counts need `personId`, which is
  null on older history entries, so fall back to a room-wide count rather than
  guessing at attribution.
- **No generated comment.** An earlier draft had a 総評-style line chosen from a
  template table keyed on the strongest and weakest axis. Cut: the ribbon and the
  per-axis numbers already say where the singing was good, without the card
  editorialising about it. This also removes the only piece that would have needed
  copy maintained per metric combination.
- **Axis labels break onto two lines** (JP over EN) on every axis, so the three
  rows stay a uniform height instead of PITCH sitting on one line while LONG TONE
  and TIMING wrap.

## Don't record test queueing

A play count is only meaningful if test queueing doesn't inflate it, and today
every song queued to check a download or a sync fix enters `songHistory` exactly
like a real one.

The write is a single choke point — `popSong` unshifting `db.currentSong` into
`db.songHistory` (`src/main/graphql.ts:2875`) — so one gate covers history, play
counts and persisted scores together.

**Default it from `app.isPackaged`**: parties run the packaged build, development
runs `run-dev` (see the `live-session-packaged-app` memory), so dev builds don't
record and packaged builds do, with no one having to remember anything. Add a
synced override for the two real exceptions — testing on a packaged build, or
demoing from a dev build. The synced-setting trio + `useRoomSettings` + manifest
entry is the established pattern; see the root `CLAUDE.md`.

The failure mode worth designing against is leaving it in the wrong state at a
party, which loses a night that cannot be reconstructed. So make **"not
recording" the visible state**: a small persistent marker on the TV whenever
recording is off, and nothing at all in the normal case.

Sequencing note: this should land _before_ play counts are surfaced, or the first
counts anyone sees will already be wrong.

**Where this could go later.** An explicit night ("start the night" / "end the
night") would give sessions to hang things off — a night summary, "3rd time
tonight" distinct from "3rd time ever", and an unambiguous answer to whether a
song counts. That is more machinery than the toggle needs and the toggle doesn't
block it, so it's worth building only once something actually wants sessions.

## Suggested order of work

1. **Restructure `ScoreAccumulator` to keep the trace.** Today it reduces as it
   goes, storing one absolute deviation per (note, slot) — which is why none of
   the above can be computed after the fact. Keep **signed** deviation, the slot
   index, and the `rms` the poll loop already reads (`pollPitch` has it for the
   level meters and currently drops it before `addSample`). That is a few
   thousand small records per song and makes every metric a pure function of the
   trace, offline-replayable under any formula version.
   - Sites: `src/common/scoring.ts`, `src/renderer/PianoRoll.tsx:660`.
   - `rms` is what the dynamics axis (抑揚 /15) needs; it is the one proposed
     metric that could not be checked offline, because the probe log doesn't
     carry it. Piping it through makes that testable.
2. **Formula work** — graded tolerance, note averaging, per-take offset fit,
   participation gate, display curve. No new inputs; this is what moves the
   distribution from 62–91 to 48–96.
3. **The card** — axes with their evidence, the note ribbon, times sung.
   Renderer-only once step 1 returns a richer result.
   Sites: `src/renderer/ScoreCard.tsx`, `ScoreCard.css`.
4. **Gate history recording** on `app.isPackaged` plus a synced override (above).
   Small, independent of the rest, and a prerequisite for play counts meaning
   anything.
5. **Persist scores as data.** Today a result exists only as the PNG that
   `save-score-card` writes (`src/main/index.ts:310`). Structured scores keyed on
   `personId` unlock personal best, previous take, per-song room leaderboards and
   a night summary — and `main/people.ts` already says songs and "eventually
   scores" hang off `personId`. Write under `userData`, **not** the temp dir; the
   same reasoning as `people.json` and the history mirror.
6. **Then** the finer pitch hop in the native addon, and the metrics it unblocks.

Steps 1–3 are the ones this corpus supports directly.

## Open questions for whoever picks this up

- **Weights.** The visual proposal uses 0.65 pitch / 0.20 long tone / 0.15
  timing, chosen from which axes separated these 29 takes. That is one night's
  worth of two mics and six singers; it is a starting point, not a calibration.
- **How harsh is too harsh.** A more discriminating formula hands out C and D that
  the current one never does (one take drops to 48/D). The lever should be
  presentation — lead with the best axis, name the concrete failure, keep the
  ribbon — not arithmetic. Worth a decision before shipping.
- **Duets.** All open mics feed one accumulator and the per-slot dedupe keeps the
  _best_ deviation across them, so a duet always scores as whichever singer is
  better at each instant. Fine for a party; a per-mic breakdown is possible since
  `pollPitch` already knows `micIndex`, but mic bleed makes attribution
  unreliable without hard-panned inputs.
