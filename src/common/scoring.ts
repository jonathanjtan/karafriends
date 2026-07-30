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

// How far off a note a sample can land and still count as on-pitch. A
// semitone is the natural unit here -- beyond it the singer is on a
// different note.
const ON_PITCH_TOLERANCE_SEMIS = 1.0;

// Pitch is polled on this cadence (PianoRoll's setInterval), so it also
// defines a "frame slot": at most one sample per note per slot counts. With
// several mics open, the same instant otherwise contributes several samples
// and inflates coverage.
const SAMPLE_SLOT_MS = 25;

// Accuracy answers "when they sang, were they on the note"; coverage answers
// "did they sing the song at all". Scoring accuracy alone gives a full score
// to someone who nails four notes and mumbles the rest, so both must count.
const ACCURACY_WEIGHT = 0.7;
const COVERAGE_WEIGHT = 0.3;

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

export type ScoreBand = "SSS" | "SS" | "S" | "A" | "B" | "C" | "D";

// Calibrated against real singing rather than a theoretical 100%: a solid
// full-voice take on this formula lands around 0.75, so A starts at 0.70 and
// the S ladder sits above it. The headline percentage stays a true 0..1 --
// the bands, not the number, carry "you did well".
const BAND_THRESHOLDS: [ScoreBand, number][] = [
  ["SSS", 0.95],
  ["SS", 0.9],
  ["S", 0.8],
  ["A", 0.7],
  ["B", 0.55],
  ["C", 0.4],
  ["D", 0],
];

export interface ScoreResult {
  // 0..1, the blended headline figure.
  overall: number;
  band: ScoreBand;
  // 0..1, how on-pitch the sung frames were, per note the better of the flat
  // frame-average and the best sustained on-pitch stretch (see
  // SUSTAIN_FRACTION), then pooled across notes weighted by voiced frames.
  accuracy: number;
  // 0..1, of the reference note time, how much received any voiced input.
  coverage: number;
  // Per-bucket accuracy across the 24 display windows, null where the singer
  // produced nothing at all in that window (an instrumental break, or a
  // phrase they sat out) -- distinct from 0, which means they sang and
  // missed.
  buckets: (number | null)[];
  // Reference notes that had at least one voiced frame, and the total, so
  // the UI can say "you sang 41 of 58 phrases" without recomputing.
  notesAttempted: number;
  notesTotal: number;
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

    const hits = placeSamples(this.notes, this.trace, this.compensationMs);

    let onPitchFrames = 0;
    let voicedFrames = 0;
    let coveredFrames = 0;
    let expectedFrames = 0;
    let notesAttempted = 0;

    const bucketOnPitch = new Array<number>(SCORE_BUCKET_COUNT).fill(0);
    const bucketVoiced = new Array<number>(SCORE_BUCKET_COUNT).fill(0);
    const windowSpan = this.windowEnd - this.windowStart;

    for (let i = 0; i < this.notes.length; i++) {
      const note = this.notes[i];
      const durationMs = (note.endTime - note.startTime) * 1000;
      const expected = Math.max(1, Math.round(durationMs / SAMPLE_SLOT_MS));
      expectedFrames += expected;

      const slots = hits.get(i);
      if (slots === undefined) continue;
      notesAttempted++;

      let frameOnPitch = 0;
      for (const sample of slots.values()) {
        if (Math.abs(sample.deviation) <= ON_PITCH_TOLERANCE_SEMIS) {
          frameOnPitch++;
        }
      }
      // Credit the note by whichever is kinder: its flat frame-average, or how
      // well the pitch was sustained (see SUSTAIN_FRACTION). creditedOnPitch is
      // the equivalent on-pitch frame count -- feeding it to both the headline
      // accuracy and the per-bucket graph keeps the two in agreement.
      const frameAccuracy = frameOnPitch / slots.size;
      const sustainSlots = Math.max(1, Math.ceil(expected * SUSTAIN_FRACTION));
      const stretchCredit = Math.min(
        1,
        longestOnPitchRun(slots) / sustainSlots,
      );
      const noteOnPitch = Math.max(frameAccuracy, stretchCredit) * slots.size;

      voicedFrames += slots.size;
      onPitchFrames += noteOnPitch;
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
      bucketVoiced[bucket] += slots.size;
      bucketOnPitch[bucket] += noteOnPitch;
    }

    const accuracy = voicedFrames > 0 ? onPitchFrames / voicedFrames : 0;
    const coverage = expectedFrames > 0 ? coveredFrames / expectedFrames : 0;
    const overall = ACCURACY_WEIGHT * accuracy + COVERAGE_WEIGHT * coverage;

    return {
      overall,
      band: bandFor(overall),
      accuracy,
      coverage,
      buckets: bucketVoiced.map((voiced, i) =>
        voiced > 0 ? bucketOnPitch[i] / voiced : null,
      ),
      notesAttempted,
      notesTotal: this.notes.length,
    };
  }
}
