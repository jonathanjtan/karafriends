// Scores a sung performance against the guide-melody reference notes.
//
// Like guideMelody.ts this is pure logic with no electron/DOM/network
// imports, so it can be exercised offline against a recorded pitch trace.
//
// The reference material (DAM's scoring blob, or the equivalent Joysound
// melody extraction) contains notes, phrase intervals, chorus regions and a
// display grid -- but no scoring *rules*: no thresholds, no weights, and a
// per-note flags word that is a constant 100 across every song surveyed.
// There is therefore nothing to reverse-engineer and no way to agree with a
// real DAM machine; the formula below is ours, and is meant to be tuned.

import { ScoringInterval, ScoringNote } from "./scoringData";

// DAM divides the sung span into exactly 24 windows for its end-of-song
// graph. Verified on 96 songs: always 24, never song-length dependent.
export const SCORE_BUCKET_COUNT = 24;

// Pitch credit is graded, not a step. A sample inside SOFT_FULL_SEMIS of the
// note gets full credit; past it the credit ramps to zero at SOFT_ZERO_SEMIS.
//
// The old hard 1.0-semitone threshold scored 0.99 semitones as a perfect frame
// and 1.01 as nothing, which is what made the score jitter by ~20 points of
// coverage across a few milliseconds of compensation (docs/scoring-tuning-
// handoff.md). 50 cents is about where a listener stops hearing "the note, a
// bit off" and starts hearing "a different note"; 125 is comfortably past any
// reading that deserves credit.
const SOFT_FULL_SEMIS = 0.5;
const SOFT_ZERO_SEMIS = 1.25;
// The threshold for the yes/no questions that remain -- whether a slot counts
// towards a sustained run, and whether a note was "landed". Half credit.
const ON_PITCH_TOLERANCE_SEMIS = (SOFT_FULL_SEMIS + SOFT_ZERO_SEMIS) / 2;

// Pitch is polled on this cadence (PianoRoll's setInterval), so it also
// defines a "frame slot": at most one sample per note per slot counts. With
// several mics open, the same instant otherwise contributes several samples
// and inflates coverage.
const SAMPLE_SLOT_MS = 25;

// A song needs this much reference material for a score to mean anything.
const MIN_SCOREABLE_NOTES = 24;

// A note's accuracy is the better of its flat frame-average and how well the
// singer *sustained* the pitch, so a short note they clearly hit isn't dragged
// down by the boundary frames where the 25ms detector window blends it with
// its neighbours. Measured on real takes: 150-300ms notes were hit ~88% of the
// time but scored 65-70% on the flat average; crediting the best sustained
// stretch recovers them, while long notes (already high) barely move.
// "Sustained" means holding on-pitch across at least this fraction of the
// note's slots for full credit; a shorter run scales down proportionally, so a
// single lucky frame earns little.
const SUSTAIN_FRACTION = 0.5;

// One accepted mic sample, exactly as the poll loop read it.
//
// Deliberately un-processed: the compensation is NOT applied here and the
// sample is not yet attached to a reference note. Both happen in
// placeSamples(), which finalize() runs more than once at different
// compensations to find the one that actually fits the take -- and it can only
// do that if the samples are still where the singer put them.
export interface ScoreSample {
  // Video-clock time the sample was read, in seconds, uncompensated.
  timeSecs: number;
  // The detected pitch as it arrived, unfolded, so a metric can recover what
  // octave folding would hide -- which register the singer was actually in.
  midiNumber: number;
  // The pitch shift in force when this sample was read. Per-sample rather than
  // per-take because it is a synced setting somebody can turn mid-song.
  pitchShiftSemis: number;
  // Input level at this sample, or null when the caller didn't supply one
  // (the native addon's rms is absent if Parcel reused a cached index.node).
  rms: number | null;
}

// A sample attached to a reference note at a particular compensation.
export interface PlacedSample {
  // Absolute frame-slot index on the SAMPLE_SLOT_MS grid. Absolute rather
  // than per-note, so "consecutive" (n then n+1) still means something across
  // a note boundary and not only inside one note.
  slot: number;
  // Which reference note this sample was credited to.
  noteIndex: number;
  // Octave-folded distance from the reference pitch in semitones, **signed**.
  // The sign is what separates a scoop into a note from a fall out of one, and
  // a wobble around the pitch from a drift off it.
  deviation: number;
  midiNumber: number;
  rms: number | null;
}

// note index -> (frame slot -> the one sample kept for that slot)
export type Placement = Map<number, Map<number, PlacedSample>>;

// Attach raw samples to reference notes at a given compensation.
//
// Exported and pure so the metrics that don't live in finalize() -- long tone,
// timing, vibrato -- work from exactly the placement the headline scored, and
// so a recorded take can be re-placed offline at any offset.
//
// Samples falling in a gap between phrases are dropped rather than credited to
// the nearest note: a rest is not a note, and crediting humming between
// phrases would score it.
export function placeSamples(
  notes: readonly ScoringNote[],
  samples: readonly ScoreSample[],
  compensationMs: number,
): Placement {
  const placement: Placement = new Map();
  // Time-ordered, so one forward-only pass over the notes suffices. Sorting
  // here also makes the result independent of the order several mics' polls
  // happened to interleave in, which the old arrival-time cursor was not.
  const ordered = [...samples].sort((a, b) => a.timeSecs - b.timeSecs);
  let cursor = 0;

  for (const sample of ordered) {
    const t = sample.timeSecs - compensationMs / 1000;
    while (cursor < notes.length && notes[cursor].endTime < t) cursor++;
    if (cursor >= notes.length) break;

    const note = notes[cursor];
    if (t < note.startTime) continue;

    const slot = Math.floor((t * 1000) / SAMPLE_SLOT_MS);
    const deviation = signedOctaveFoldedDeviation(
      sample.midiNumber,
      note.midiNumber + sample.pitchShiftSemis,
    );

    let slots = placement.get(cursor);
    if (slots === undefined) {
      slots = new Map();
      placement.set(cursor, slots);
    }
    // One sample per note per slot: several open mics report the same instant,
    // and keeping them all would inflate coverage. The closest read wins
    // rather than the last one, so an idle channel's bleed can't displace the
    // singer.
    const existing = slots.get(slot);
    if (
      existing === undefined ||
      Math.abs(deviation) < Math.abs(existing.deviation)
    ) {
      slots.set(slot, {
        slot,
        noteIndex: cursor,
        deviation,
        midiNumber: sample.midiNumber,
        rms: sample.rms,
      });
    }
  }

  return placement;
}

// Graded pitch credit for one sample, 0..1. See SOFT_FULL_SEMIS.
function pitchCredit(deviation: number): number {
  const off = Math.abs(deviation);
  if (off <= SOFT_FULL_SEMIS) return 1;
  if (off >= SOFT_ZERO_SEMIS) return 0;
  return (SOFT_ZERO_SEMIS - off) / (SOFT_ZERO_SEMIS - SOFT_FULL_SEMIS);
}

// How well one note was sung, 0..1: the better of its graded frame average and
// how well the singer *sustained* the pitch (see SUSTAIN_FRACTION), so a short
// note they clearly hit isn't dragged down by the boundary frames where the
// 25ms detector window blends it with its neighbours.
function noteCredit(
  note: ScoringNote,
  slots: Map<number, PlacedSample>,
): number {
  let graded = 0;
  for (const sample of slots.values()) graded += pitchCredit(sample.deviation);

  const expected = Math.max(
    1,
    Math.round(((note.endTime - note.startTime) * 1000) / SAMPLE_SLOT_MS),
  );
  const sustainSlots = Math.max(1, Math.ceil(expected * SUSTAIN_FRACTION));
  const sustained = Math.min(1, longestOnPitchRun(slots) / sustainSlots);

  return Math.max(graded / slots.size, sustained);
}

// The pitch axis: the mean of noteCredit over **every** reference note, a note
// nobody sang counting as zero.
//
// Averaging over every note rather than only the attempted ones does two jobs.
// It folds participation in for free -- sitting out the last chorus costs you
// those notes -- and, more importantly, it makes this the same quantity the
// compensation is fitted on, which is what guarantees fitting can never lower
// a singer's pitch score. An average over *attempted* notes would let the fit
// wander to an offset that strands most samples in the rests and then flatter
// the handful that survived.
//
// Note-averaged rather than frame-pooled so one held note can't outweigh a
// whole verse, and so this number and the per-note graph agree.
export function pitchScore(
  notes: readonly ScoringNote[],
  placement: Placement,
): number {
  if (notes.length === 0) return 0;
  let total = 0;
  for (const [index, slots] of placement) {
    total += noteCredit(notes[index], slots);
  }
  return total / notes.length;
}

// The compensation that best fits this take, searched within FIT_WINDOW_MS of
// the caller's seed and judged on pitchScore -- the very axis the headline
// leads with, so a fitted take can never score worse on pitch than the seed
// would have.
//
// Returns the midpoint of the plateau rather than the argmax: the surface is
// flat and wide around the truth, so the peak itself is noise. Falls back to
// the seed when nothing landed on a note at all, which is the empty-room case.
export function fitCompensation(
  notes: readonly ScoringNote[],
  samples: readonly ScoreSample[],
  seedMs: number,
): number {
  const scored: [number, number][] = [];
  let best = 0;
  let peak = 0;
  for (
    let offset = seedMs - FIT_WINDOW_MS;
    offset <= seedMs + FIT_WINDOW_MS;
    offset += FIT_STEP_MS
  ) {
    const score = pitchScore(notes, placeSamples(notes, samples, offset));
    if (score > best) {
      best = score;
      peak = scored.length;
    }
    scored.push([offset, score]);
  }
  if (best <= 0) return seedMs;

  // Walk out from the peak while the score stays within tolerance, rather than
  // filtering the whole sweep: a filter would include a second, separate hump
  // and put the "midpoint" in the dip between the two, which is the one offset
  // in the window that fits nothing.
  const floor = best - FIT_PLATEAU_TOLERANCE;
  let lo = peak;
  let hi = peak;
  while (lo > 0 && scored[lo - 1][1] >= floor) lo--;
  while (hi < scored.length - 1 && scored[hi + 1][1] >= floor) hi++;
  const fitted = (scored[lo][0] + scored[hi][0]) / 2;

  // The plateau midpoint is normally the stable estimate, but it is not
  // guaranteed to beat the seed on a lumpy surface. Since pitchScore is the
  // criterion *and* the headline's leading axis, refusing a fit that would
  // score worse than the seed makes "we scored you at the offset that suited
  // you" unconditionally true.
  const seedScore = pitchScore(notes, placeSamples(notes, samples, seedMs));
  const fittedScore = pitchScore(notes, placeSamples(notes, samples, fitted));
  return fittedScore >= seedScore ? fitted : seedMs;
}

// A reference note this long is a held note, and worth judging as one. Below
// it there is nothing to sustain.
const LONG_TONE_MIN_SECS = 1.0;
// Fraction of a held note the singer has to stay on pitch for full credit.
// Not 1.0: the attack and the release both cost frames nobody could hold.
const LONG_TONE_HOLD_FRACTION = 0.7;

// The long-tone axis: over reference notes at least LONG_TONE_MIN_SECS long,
// how much of each one the singer actually held on pitch. Null when the song
// has no held notes at all -- a fast song can't be judged on this, and saying
// so is better than scoring it as a failure.
//
// This was the widest-spread axis after pitch on the corpus (12-92 against a
// median 47), which is why it earns a place on the card.
export function longToneScore(
  notes: readonly ScoringNote[],
  placement: Placement,
): { score: number | null; count: number } {
  let count = 0;
  let total = 0;
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (note.endTime - note.startTime < LONG_TONE_MIN_SECS) continue;
    count++;
    const slots = placement.get(i);
    if (slots === undefined) continue;
    const expected = Math.max(
      1,
      Math.round(((note.endTime - note.startTime) * 1000) / SAMPLE_SLOT_MS),
    );
    total += Math.min(
      1,
      longestOnPitchRun(slots) / (expected * LONG_TONE_HOLD_FRACTION),
    );
  }
  return { score: count > 0 ? total / count : null, count };
}

// A note needs this much silence in front of it for its attack to be locatable
// at all: mid-phrase, one note runs into the next and there is no onset to
// measure. This is why the timing axis has so few samples per song.
const ONSET_GAP_SECS = 0.15;
// Slots of quiet required before the note starts, so the tail of the previous
// phrase can't be mistaken for this note's attack.
const ONSET_SILENT_SLOTS = 4;
// How far either side of the note's start an attack is looked for.
const ONSET_SEARCH_BEFORE_SLOTS = 4;
const ONSET_SEARCH_AFTER_SLOTS = 12;
// Fewer clean onsets than this and the spread is noise, not a rhythm reading.
const ONSET_MIN_SAMPLES = 6;
// Interquartile spread of attack error mapping to full marks and to zero.
// 40ms is about as tight as the 25ms sampling can show; 260ms is ragged.
const ONSET_TIGHT_MS = 40;
const ONSET_LOOSE_MS = 260;

// The timing axis: how *consistent* the singer's attacks are, not how early or
// late. Consistency is the skill; a uniform lag is either the room's latency or
// a stylistic choice, and the fitted compensation has already absorbed it.
//
// Returns the interquartile spread of attack error in ms alongside the score,
// and the median as a tendency (negative = ahead of the beat, positive =
// behind) for the card to show without scoring it. Null when too few notes have
// a locatable attack.
export function timingScore(
  notes: readonly ScoringNote[],
  samples: readonly ScoreSample[],
  compensationMs: number,
): {
  score: number | null;
  spreadMs: number | null;
  medianMs: number | null;
  count: number;
} {
  // Voiced slots across the whole take, so "was it quiet before this note" is
  // answerable independently of which note a sample was placed against.
  const voiced = new Map<number, ScoreSample>();
  for (const sample of samples) {
    const t = sample.timeSecs - compensationMs / 1000;
    const slot = Math.floor((t * 1000) / SAMPLE_SLOT_MS);
    if (!voiced.has(slot)) voiced.set(slot, sample);
  }

  const errors: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    const gapBefore =
      i === 0 ? Infinity : notes[i].startTime - notes[i - 1].endTime;
    if (gapBefore < ONSET_GAP_SECS) continue;

    const startSlot = Math.floor((notes[i].startTime * 1000) / SAMPLE_SLOT_MS);
    let quiet = true;
    for (let s = startSlot - ONSET_SILENT_SLOTS; s < startSlot - 1; s++) {
      if (voiced.has(s)) {
        quiet = false;
        break;
      }
    }
    if (!quiet) continue;

    for (
      let s = startSlot - ONSET_SEARCH_BEFORE_SLOTS;
      s <= startSlot + ONSET_SEARCH_AFTER_SLOTS;
      s++
    ) {
      const sample = voiced.get(s);
      if (sample === undefined) continue;
      // Require roughly the right pitch, so a cough or a neighbour's voice in
      // the gap isn't taken for the attack.
      const off = Math.abs(
        signedOctaveFoldedDeviation(
          sample.midiNumber,
          notes[i].midiNumber + sample.pitchShiftSemis,
        ),
      );
      if (off > SOFT_ZERO_SEMIS) continue;
      const t = sample.timeSecs - compensationMs / 1000;
      errors.push((t - notes[i].startTime) * 1000);
      break;
    }
  }

  if (errors.length < ONSET_MIN_SAMPLES) {
    return {
      score: null,
      spreadMs: null,
      medianMs: null,
      count: errors.length,
    };
  }

  const sorted = [...errors].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const spreadMs = at(0.75) - at(0.25);
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    score: Math.max(
      0,
      Math.min(
        1,
        (ONSET_LOOSE_MS - spreadMs) / (ONSET_LOOSE_MS - ONSET_TIGHT_MS),
      ),
    ),
    spreadMs,
    medianMs,
    count: errors.length,
  };
}

// Longest run of consecutive on-pitch slots within one note. Slots are keyed
// by absolute slot index, so "consecutive" is index n immediately followed by
// n+1 (a gap, whether silent or off-pitch, breaks the run).
function longestOnPitchRun(slots: Map<number, PlacedSample>): number {
  const indices = [...slots.keys()].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const idx of indices) {
    const onPitch =
      Math.abs((slots.get(idx) as PlacedSample).deviation) <=
      ON_PITCH_TOLERANCE_SEMIS;
    run =
      onPitch && prev !== null && idx === prev + 1 ? run + 1 : onPitch ? 1 : 0;
    best = Math.max(best, run);
    prev = idx;
  }
  return best;
}

// How far either side of the caller's compensation finalize() will look for a
// better fit, and at what resolution.
//
// The corpus put the best-fitting compensation between 90 and 312ms against a
// configured 105 (docs/scoring-scorecard-proposal.md, finding 3). Most of that
// spread is not miscalibration -- it is singers sitting behind the beat, which
// the old fixed offset charged to *pitch*. Fitting per take separates the two.
//
// The window is deliberately bounded rather than open: an unbounded search on
// a repetitive song can find a flattering alignment a whole phrase away, which
// would score the singer against the wrong bar of the song.
const FIT_WINDOW_MS = 120;
const FIT_STEP_MS = 5;
// A candidate has to beat the peak by less than this to count as part of the
// same plateau. The score surface around the true offset is flat and wide
// (50-130ms across the corpus), so the argmax lands on noise inside it; the
// midpoint of the plateau is the stable estimate. Measured in note-average
// pitch credit, so 0.01 is one point.
const FIT_PLATEAU_TOLERANCE = 0.01;

// Axis weights, chosen by how well each one separated the 29-take corpus
// rather than by taste: pitch spread 38-87, long tone 12-92, timing 36-251ms.
// Timing is real but thin -- a median of six locatable attacks per song -- so
// it carries the least.
const WEIGHT_PITCH = 0.65;
const WEIGHT_LONG_TONE = 0.2;
const WEIGHT_TIMING = 0.15;

// The display curve: raw composite -> the number shown.
//
// This exists so the formula and the scale are separate things. Band
// thresholds sit on the *displayed* number, so retuning the formula means
// re-fitting this table rather than moving every band -- which is the treadmill
// the old design was on.
//
// The anchors come from the corpus: a raw composite in the low 0.5s is a take
// that mostly worked, the high 0.7s is a strong one, and 0.9 raw is better than
// anybody in the corpus managed. Every band is reachable, which was not true
// before (49 saved cards used four of seven).
const DISPLAY_CURVE: [number, number][] = [
  [0.0, 0],
  [0.3, 45],
  [0.45, 62],
  [0.55, 72],
  [0.65, 80],
  [0.72, 86],
  [0.8, 92],
  [0.88, 97],
  [1.0, 100],
];

// Maps a raw 0..1 composite onto the 0..100 shown, piecewise-linearly.
export function displayScore(raw: number): number {
  if (raw <= 0) return 0;
  for (let i = 1; i < DISPLAY_CURVE.length; i++) {
    const [x1, y1] = DISPLAY_CURVE[i];
    if (raw <= x1) {
      const [x0, y0] = DISPLAY_CURVE[i - 1];
      return y0 + ((raw - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 100;
}

export type ScoreBand = "SSS" | "SS" | "S" | "A" | "B" | "C" | "D";

// Thresholds on the **displayed** number, not the raw composite, so retuning
// the formula is a change to DISPLAY_CURVE and leaves this ladder alone.
const BAND_THRESHOLDS: [ScoreBand, number][] = [
  ["SSS", 97],
  ["SS", 93],
  ["S", 87],
  ["A", 78],
  ["B", 68],
  ["C", 55],
  ["D", 0],
];

// One reference note, positioned for drawing. The card's note ribbon replays
// the whole melody from these, so it needs every note -- including the ones
// nobody sang, which are what make a missed phrase visible as a gap.
export interface ScoredNote {
  // Position and width within the scored window, both 0..1, so a caller can
  // draw the take without knowing anything about the song's timing.
  x: number;
  width: number;
  midiNumber: number;
  // How well it was sung (noteCredit), or null if it got no samples at all.
  credit: number | null;
}

export interface ScoreResult {
  // The number to show, 0..100, after DISPLAY_CURVE. This is what `band` is
  // derived from and what the card leads with.
  display: number;
  band: ScoreBand;
  // 0..1, the raw weighted composite before the display curve. Kept because
  // it, not `display`, is the quantity to compare across formula versions.
  overall: number;
  // The axes, each 0..1. longTone and timing are null when the song can't be
  // judged on them (no held notes; too few locatable attacks) -- the card shows
  // that gap rather than hiding it, because a missing axis leans the headline
  // harder on pitch.
  pitch: number;
  longTone: number | null;
  timing: number | null;
  // Held notes the long-tone axis looked at, and locatable attacks the timing
  // axis measured, so the card can show the evidence beside the score.
  longToneCount: number;
  timingCount: number;
  // Interquartile spread of attack error in ms (what timing scores), and its
  // median as a tendency: negative is ahead of the beat, positive behind.
  // Reported, never scored -- see timingScore.
  timingSpreadMs: number | null;
  timingMedianMs: number | null;
  // 0..1, of the reference note time, how much received any voiced input. No
  // longer part of the headline: across the corpus it varied mostly with what
  // the pitch tracker managed to voice rather than with the singing (see
  // finding 1 in docs/scoring-scorecard-proposal.md). Kept as a diagnostic.
  coverage: number;
  // Per-bucket note-average credit across the 24 display windows, null where
  // the singer produced nothing at all in that window (an instrumental break,
  // or a phrase they sat out) -- distinct from 0, which means they sang and
  // missed.
  buckets: (number | null)[];
  // Reference notes that had at least one voiced frame, and the total, so
  // the UI can say "you sang 41 of 58 phrases" without recomputing.
  notesAttempted: number;
  notesTotal: number;
  // Every reference note, positioned for the ribbon, plus the reference pitch
  // range to scale it against and the window the positions are relative to.
  // The window bounds are here so a caller can place anything else it knows in
  // absolute seconds -- instrumental breaks, say -- on the same axis.
  notes: ScoredNote[];
  pitchLo: number;
  pitchHi: number;
  windowStartSecs: number;
  windowEndSecs: number;
  // The compensation the take was actually scored at, after fitting (see
  // fitCompensation), and the seed it was fitted from. The difference is the
  // singer's own timing against this song; the median of `compensationMs`
  // across a night is an estimate of the machine's real latency, which is what
  // micLatencyCalibrationMs is trying to be.
  compensationMs: number;
  seedCompensationMs: number;
}

// Octave-agnostic distance from a sung pitch to a reference pitch, in
// semitones, keeping the direction: negative means the singer was under the
// note, positive over it. Deliberately stateless: PianoRoll's
// PitchDetectionBuffer keeps a *running* octave offset tuned to stop a drawn
// trace jumping mid-phrase, which carries state across notes and can drift
// after a bad frame. Scoring wants each frame judged on its own.
export function signedOctaveFoldedDeviation(
  sungMidi: number,
  referenceMidi: number,
): number {
  const raw = sungMidi - referenceMidi;
  return ((((raw + 6) % 12) + 12) % 12) - 6;
}

// How far off the note a sample landed, direction discarded -- what the
// pitch-accuracy terms below want. Anything that cares which side of the note
// the singer was on wants signedOctaveFoldedDeviation instead.
export function octaveFoldedDeviation(
  sungMidi: number,
  referenceMidi: number,
): number {
  return Math.abs(signedOctaveFoldedDeviation(sungMidi, referenceMidi));
}

// The span DAM's 24 display windows cover: the intersection of the note range
// and the lyrics range. Verified exact on 96/96 songs surveyed -- the naive
// "first note to last note" is right for most songs but breaks when a song
// ends on a held note that outlasts the final lyric phrase.
export function scoreWindowBounds(
  notes: readonly ScoringNote[],
  lyricsIntervals: readonly ScoringInterval[],
): { startTime: number; endTime: number } | null {
  if (notes.length === 0) return null;

  const notesFirst = notes[0].startTime;
  const notesLast = notes[notes.length - 1].endTime;
  if (lyricsIntervals.length === 0) {
    return { startTime: notesFirst, endTime: notesLast };
  }

  const lyricsFirst = lyricsIntervals[0].startTime;
  const lyricsLast = lyricsIntervals[lyricsIntervals.length - 1].endTime;
  const startTime = Math.max(notesFirst, lyricsFirst);
  const endTime = Math.min(notesLast, lyricsLast);
  return endTime > startTime ? { startTime, endTime } : null;
}

export function isScoreable(notes: readonly ScoringNote[]): boolean {
  return notes.length >= MIN_SCOREABLE_NOTES;
}

function bandFor(overall: number): ScoreBand {
  for (const [band, threshold] of BAND_THRESHOLDS) {
    if (overall >= threshold) return band;
  }
  return "D";
}

// Records one song's worth of mic samples, and scores them when it ends.
//
// Fed from PianoRoll's poll loop (all mics into one accumulator -- whoever is
// singing counts) and read once when the song ends. addSample only records;
// attaching samples to reference notes is placeSamples' job, run from
// finalize(), because the placement depends on a compensation that finalize
// gets to choose.
export class ScoreAccumulator {
  private notes: readonly ScoringNote[];
  private windowStart: number;
  private windowEnd: number;
  // The raw take, in arrival order. Placing samples against notes is
  // finalize()'s job now, not addSample's -- see placeSamples.
  private trace: ScoreSample[] = [];
  private compensationMs: number;

  // compensationMs shifts every sample back before it is placed against a
  // note, correcting the mic-to-score latency (the singer hears through the
  // output path and is recorded through the input path, so a sung pitch
  // arrives late). The caller supplies it -- config calibration plus live
  // output latency in the renderer; the offline sweep leaves it 0 and applies
  // its own trial offset -- so this class stays pure and dependency-free.
  constructor(
    notes: readonly ScoringNote[],
    lyricsIntervals: readonly ScoringInterval[],
    compensationMs: number = 0,
  ) {
    this.notes = notes;
    this.compensationMs = compensationMs;
    const bounds = scoreWindowBounds(notes, lyricsIntervals);
    this.windowStart = bounds?.startTime ?? 0;
    this.windowEnd = bounds?.endTime ?? 0;
  }

  // timeSecs is the video clock at the moment the sample was read, midiNumber
  // the raw detected pitch. pitchShiftSemis is applied to the reference note
  // here rather than baked into the stored notes: it is a synced setting that
  // can change mid-song, and the accumulator outlives the piano roll's GL
  // effect (which rebuilds on every parent render). rms is the input level, if
  // the caller has one -- it is scored by nothing today and only recorded on
  // the trace, since the dynamics metric that wants it can't be validated
  // until real takes carry it.
  addSample(
    timeSecs: number,
    midiNumber: number,
    pitchShiftSemis: number,
    rms?: number,
  ) {
    this.trace.push({
      timeSecs,
      midiNumber,
      pitchShiftSemis,
      // typeof rather than a default parameter: an addon predating the rms
      // field leaves it absent, and callers on that path would otherwise
      // record a level of zero, which is a lie a dynamics metric would read.
      rms: typeof rms === "number" ? rms : null,
    });
  }

  // The take so far, in arrival order and uncompensated. Raw material for
  // metrics that don't live in finalize() and for an offline re-score under a
  // different formula; pair it with placeSamples() to attach it to notes.
  samples(): readonly ScoreSample[] {
    return this.trace;
  }

  // A performance that skipped part of the song can't be judged against the
  // whole melody, so a seek starts the take over.
  reset() {
    this.trace = [];
  }

  finalize(): ScoreResult | null {
    if (!isScoreable(this.notes) || this.windowEnd <= this.windowStart) {
      return null;
    }

    // Fit the alignment to this take rather than trusting the seed. A singer
    // who sits behind the beat used to have that charged to pitch; scoring at
    // the offset they actually sang at judges the timing once, and leaves the
    // residual (compensationMs - seedCompensationMs) as the honest measure of
    // it for the timing axis to read.
    const compensationMs = fitCompensation(
      this.notes,
      this.trace,
      this.compensationMs,
    );
    const hits = placeSamples(this.notes, this.trace, compensationMs);

    let coveredFrames = 0;
    let expectedFrames = 0;
    let notesAttempted = 0;

    // The 24-window graph is note-averaged, exactly like the pitch axis, so a
    // window's height and the headline are the same measurement at different
    // resolutions.
    const bucketCredit = new Array<number>(SCORE_BUCKET_COUNT).fill(0);
    const bucketNotes = new Array<number>(SCORE_BUCKET_COUNT).fill(0);
    const windowSpan = this.windowEnd - this.windowStart;
    const scoredNotes: ScoredNote[] = [];

    for (let i = 0; i < this.notes.length; i++) {
      const note = this.notes[i];
      const durationMs = (note.endTime - note.startTime) * 1000;
      const expected = Math.max(1, Math.round(durationMs / SAMPLE_SLOT_MS));
      expectedFrames += expected;

      const slots = hits.get(i);
      // Every note goes on the ribbon, sung or not: an unsung phrase reads as
      // a gap, which is information.
      scoredNotes.push({
        x: (note.startTime - this.windowStart) / windowSpan,
        width: (note.endTime - note.startTime) / windowSpan,
        midiNumber: note.midiNumber,
        credit: slots === undefined ? null : noteCredit(note, slots),
      });

      if (slots === undefined) continue;
      notesAttempted++;

      // Capped: several mics, or a note shorter than one slot, can otherwise
      // report more frames than the note has room for.
      coveredFrames += Math.min(slots.size, expected);

      const bucket = Math.min(
        SCORE_BUCKET_COUNT - 1,
        Math.max(
          0,
          Math.floor(
            ((note.startTime - this.windowStart) / windowSpan) *
              SCORE_BUCKET_COUNT,
          ),
        ),
      );
      bucketNotes[bucket]++;
      bucketCredit[bucket] += noteCredit(note, slots);
    }

    const pitch = pitchScore(this.notes, hits);
    const longTone = longToneScore(this.notes, hits);
    const timing = timingScore(this.notes, this.trace, compensationMs);
    const coverage = expectedFrames > 0 ? coveredFrames / expectedFrames : 0;

    // An unmeasurable axis is filled with the take's own pitch score, NOT
    // renormalized away. Renormalizing made a song with no held notes
    // systematically easier, because long tone is the axis singers score
    // lowest on -- the first draft handed 言って。 and Bad Apple!! straight SS
    // for the crime of being fast. Substituting pitch is the neutral choice;
    // that it still leans the headline on pitch is why ScoreResult reports the
    // gap for the card to show.
    const axis = (value: number | null) => (value === null ? pitch : value);
    const overall =
      WEIGHT_PITCH * pitch +
      WEIGHT_LONG_TONE * axis(longTone.score) +
      WEIGHT_TIMING * axis(timing.score);
    const display = displayScore(overall);

    return {
      display,
      band: bandFor(display),
      overall,
      pitch,
      longTone: longTone.score,
      timing: timing.score,
      longToneCount: longTone.count,
      timingCount: timing.count,
      timingSpreadMs: timing.spreadMs,
      timingMedianMs: timing.medianMs,
      coverage,
      buckets: bucketNotes.map((count, i) =>
        count > 0 ? bucketCredit[i] / count : null,
      ),
      notesAttempted,
      notesTotal: this.notes.length,
      notes: scoredNotes,
      pitchLo: Math.min(...this.notes.map((note) => note.midiNumber)),
      pitchHi: Math.max(...this.notes.map((note) => note.midiNumber)),
      windowStartSecs: this.windowStart,
      windowEndSecs: this.windowEnd,
      compensationMs,
      seedCompensationMs: this.compensationMs,
    };
  }
}
