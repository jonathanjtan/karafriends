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

// The singer reacts to audio that has already been through output latency,
// and each reading is up to one poll interval stale, so samples arrive
// systematically *late* relative to video.currentTime. Positive values shift
// samples earlier. Left at 0 until measured on real hardware -- it differs
// between CoreAudio and the ASIO path, so it wants calibrating per machine
// rather than a guessed constant baked in here.
const MIC_LATENCY_COMPENSATION_MS = 0;

// Accuracy answers "when they sang, were they on the note"; coverage answers
// "did they sing the song at all". Scoring accuracy alone gives a full score
// to someone who nails four notes and mumbles the rest, so both must count.
const ACCURACY_WEIGHT = 0.7;
const COVERAGE_WEIGHT = 0.3;

// A song needs this much reference material for a score to mean anything.
const MIN_SCOREABLE_NOTES = 24;

export type ScoreBand = "S" | "A" | "B" | "C" | "D";

const BAND_THRESHOLDS: [ScoreBand, number][] = [
  ["S", 0.9],
  ["A", 0.8],
  ["B", 0.65],
  ["C", 0.45],
  ["D", 0],
];

export interface ScoreResult {
  // 0..1, the blended headline figure.
  overall: number;
  band: ScoreBand;
  // 0..1, of the frames where they sang inside a note, how many were within
  // tolerance.
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
// semitones. Deliberately stateless: PianoRoll's PitchDetectionBuffer keeps a
// *running* octave offset tuned to stop a drawn trace jumping mid-phrase,
// which carries state across notes and can drift after a bad frame. Scoring
// wants each frame judged on its own.
export function octaveFoldedDeviation(
  sungMidi: number,
  referenceMidi: number,
): number {
  const raw = sungMidi - referenceMidi;
  const folded = ((((raw + 6) % 12) + 12) % 12) - 6;
  return Math.abs(folded);
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

// Accumulates mic samples against the reference notes over one song.
//
// Fed from PianoRoll's poll loop (all mics into one accumulator -- whoever is
// singing counts) and read once when the song ends. Samples arriving outside
// any note are discarded rather than credited to the nearest one: the poll
// loop's own note cursor reports the *upcoming* note during a rest, so
// crediting by cursor position would score humming between phrases.
export class ScoreAccumulator {
  private notes: readonly ScoringNote[];
  private windowStart: number;
  private windowEnd: number;
  // note index -> (frame slot -> best absolute deviation seen in that slot)
  private hits: Map<number, Map<number, number>> = new Map();
  private cursor = 0;

  constructor(
    notes: readonly ScoringNote[],
    lyricsIntervals: readonly ScoringInterval[],
  ) {
    this.notes = notes;
    const bounds = scoreWindowBounds(notes, lyricsIntervals);
    this.windowStart = bounds?.startTime ?? 0;
    this.windowEnd = bounds?.endTime ?? 0;
  }

  // timeSecs is the video clock at the moment the sample was read, midiNumber
  // the raw detected pitch. pitchShiftSemis is applied to the reference note
  // here rather than baked into the stored notes: it is a synced setting that
  // can change mid-song, and the accumulator outlives the piano roll's GL
  // effect (which rebuilds on every parent render).
  addSample(timeSecs: number, midiNumber: number, pitchShiftSemis: number) {
    const t = timeSecs - MIC_LATENCY_COMPENSATION_MS / 1000;

    // Advance past notes that have already finished. The cursor only moves
    // forward; a seek resets it via reset().
    while (
      this.cursor < this.notes.length &&
      this.notes[this.cursor].endTime < t
    ) {
      this.cursor++;
    }
    if (this.cursor >= this.notes.length) return;

    const note = this.notes[this.cursor];
    // In a gap between phrases the cursor sits on the upcoming note; a sample
    // there belongs to no note at all.
    if (t < note.startTime) return;

    const slot = Math.floor((t * 1000) / SAMPLE_SLOT_MS);
    const deviation = octaveFoldedDeviation(
      midiNumber,
      note.midiNumber + pitchShiftSemis,
    );

    let slots = this.hits.get(this.cursor);
    if (slots === undefined) {
      slots = new Map();
      this.hits.set(this.cursor, slots);
    }
    const existing = slots.get(slot);
    if (existing === undefined || deviation < existing) {
      slots.set(slot, deviation);
    }
  }

  // Seeking invalidates the forward-only cursor and would otherwise strand it
  // past notes the singer is about to sing.
  reset() {
    this.hits.clear();
    this.cursor = 0;
  }

  finalize(): ScoreResult | null {
    if (!isScoreable(this.notes) || this.windowEnd <= this.windowStart) {
      return null;
    }

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

      const slots = this.hits.get(i);
      if (slots === undefined) continue;
      notesAttempted++;

      let noteOnPitch = 0;
      for (const deviation of slots.values()) {
        if (deviation <= ON_PITCH_TOLERANCE_SEMIS) noteOnPitch++;
      }

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
