// Measures a singer's range from the guided exercise, reads a song's range off
// its reference melody, and suggests a key shift when one would genuinely help.
//
// Pure logic, no electron/DOM/network imports, so it can be exercised offline
// against a recorded trace, the same contract as scoring.ts and guideMelody.ts.
//
// **This module never produces a negative judgement about a song or a singer.**
// suggestKeyShift returns null rather than nagging, and sitsComfortably is a
// positive-only signal whose absence means "no opinion", which is also what an
// uncached song legitimately conveys. Nothing here should ever grow a "you
// can't sing this" reading; people sing whatever they want.

import { SAMPLE_SLOT_MS, ScoreSample } from "./scoring";
import { parseScoringData, ScoringNote } from "./scoringData";
import { TuningPhase, TuningTarget } from "./tuningExercise";

// Bump when a change here would make a stored range incomparable to a new one.
// Persisted records carry it (see main/vocalRanges.ts), same reasoning as
// SCORING_FORMULA_VERSION.
//
// 1: unfolded target-anchored acceptance, 300ms sustain to count as reached.
export const VOCAL_RANGE_VERSION = 1;

// How far from the target a sample may sit and still count, in semitones,
// measured **without octave folding**.
//
// This one line is why the exercise exists. scoring.ts deliberately folds every
// deviation into +/-6 semitones (an octave-down performance is a legitimate
// performance and must not lose points), but folding is exactly what makes a
// song take useless for range: a tracker octave error or a rumble at half the
// frequency folds neatly onto the note and is credited. Reading the 2nd
// percentile of detected pitch that way put every take in the corpus at MIDI
// 42-44, F2, for singers who plainly were not there
// (docs/scoring-scorecard-proposal.md:207). Here the target is known, so an
// octave error is simply 12 semitones away and gets dropped.
const REACH_TOLERANCE_SEMIS = 1.0;
// Ignore the attack: the detector's 25ms window blends the onset with the
// silence before it, and nobody lands a cold note instantly.
const ATTACK_SKIP_SECS = 0.25;
// Continuous on-target time before a target counts as reached at all.
const REACH_MIN_MS = 300;
// For "comfortable", rather than merely "reached": most of the note held, and
// held accurately. A note you can just about hit is not one you want to sing a
// whole song in.
const SOLID_HOLD_FRACTION = 0.6;
const SOLID_TOLERANCE_SEMIS = 0.5;

// One target, and what the singer did with it.
export interface TargetOutcome {
  index: number;
  // The pitch actually asked for, after any pitch shift in force (see
  // effectiveMidi below).
  midiNumber: number;
  phase: TuningPhase;
  // Longest continuous on-target stretch, in ms.
  sustainedMs: number;
  // Median absolute deviation over accepted samples, semitones. Null when
  // nothing was accepted.
  medianDeviationSemis: number | null;
  reached: boolean;
  solid: boolean;
}

export interface VocalRangeResult {
  version: number;
  // Null throughout when the exercise produced nothing usable: an empty room,
  // a muted mic. A null range is reported as "we couldn't hear you", never as a
  // range of zero.
  lowMidi: number | null;
  highMidi: number | null;
  comfortableLowMidi: number | null;
  comfortableHighMidi: number | null;
  targets: TargetOutcome[];
  // The singer reached the lowest/highest target the exercise offered, so the
  // exercise ran out before their voice did. The card offers a re-run centred
  // lower or higher rather than presenting this as their limit.
  hitFloor: boolean;
  hitCeiling: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Longest run of consecutive 25ms slots, in slots. Slots are absolute indices,
// so consecutive means n immediately followed by n+1. A gap, whether silent
// or off-target, breaks the run. Mirrors longestOnPitchRun in scoring.ts.
function longestRun(slots: Set<number>): number {
  const indices = [...slots].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const idx of indices) {
    run = prev !== null && idx === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = idx;
  }
  return best;
}

// Measures the take. compensationMs shifts every sample back before it is
// matched to a target, exactly as placeSamples does. The singer hears through
// the output path and is recorded through the input path, so a sung pitch
// arrives late.
export function estimateVocalRange(
  targets: readonly TuningTarget[],
  samples: readonly ScoreSample[],
  compensationMs: number,
): VocalRangeResult {
  const ordered = [...samples].sort((a, b) => a.timeSecs - b.timeSecs);
  const compSecs = compensationMs / 1000;
  const outcomes: TargetOutcome[] = [];

  for (const target of targets) {
    const from = target.startTime + ATTACK_SKIP_SECS;
    const to = target.endTime;

    const slots = new Set<number>();
    const deviations: number[] = [];
    const shifts: number[] = [];

    for (const sample of ordered) {
      const t = sample.timeSecs - compSecs;
      if (t < from) continue;
      if (t > to) break;

      // Unfolded, and against the pitch actually being heard: the guide synth
      // feeds guideMelodySynthSink(), which sits ahead of the pitch-shift
      // stage, so a shift moves the reference tone with the song.
      const deviation =
        sample.midiNumber - (target.midiNumber + sample.pitchShiftSemis);
      if (Math.abs(deviation) > REACH_TOLERANCE_SEMIS) continue;

      slots.add(Math.floor((t * 1000) / SAMPLE_SLOT_MS));
      deviations.push(Math.abs(deviation));
      shifts.push(sample.pitchShiftSemis);
    }

    const sustainedMs = longestRun(slots) * SAMPLE_SLOT_MS;
    const noteMs = (target.endTime - target.startTime) * 1000;
    const medianDeviationSemis =
      deviations.length > 0 ? median(deviations) : null;
    const reached = sustainedMs >= REACH_MIN_MS;

    outcomes.push({
      index: target.index,
      // What the singer was actually asked to produce. Shift is 0 in every
      // normal run (Player resets it at pop and the exercise has no track to
      // shift), but recording the effective pitch keeps the reading honest if
      // somebody moves it mid-test.
      midiNumber:
        target.midiNumber +
        (shifts.length > 0 ? Math.round(median(shifts)) : 0),
      phase: target.phase,
      sustainedMs,
      medianDeviationSemis,
      reached,
      solid:
        reached &&
        sustainedMs >= noteMs * SOLID_HOLD_FRACTION &&
        medianDeviationSemis !== null &&
        medianDeviationSemis <= SOLID_TOLERANCE_SEMIS,
    });
  }

  // Settle repeats are excluded: they exist so the singer can find the tone
  // before anything is measured, and crediting them would report a range of one
  // note for somebody who never got going.
  const measured = outcomes.filter((outcome) => outcome.phase !== "settle");
  const reachedMidis = measured
    .filter((outcome) => outcome.reached)
    .map((outcome) => outcome.midiNumber);
  const solidMidis = measured
    .filter((outcome) => outcome.solid)
    .map((outcome) => outcome.midiNumber);

  const descending = measured.filter((o) => o.phase === "descend");
  const ascending = measured.filter((o) => o.phase === "ascend");

  return {
    version: VOCAL_RANGE_VERSION,
    lowMidi: reachedMidis.length > 0 ? Math.min(...reachedMidis) : null,
    highMidi: reachedMidis.length > 0 ? Math.max(...reachedMidis) : null,
    comfortableLowMidi: solidMidis.length > 0 ? Math.min(...solidMidis) : null,
    comfortableHighMidi: solidMidis.length > 0 ? Math.max(...solidMidis) : null,
    targets: outcomes,
    hitFloor:
      descending.length > 0 && descending[descending.length - 1].reached,
    hitCeiling: ascending.length > 0 && ascending[ascending.length - 1].reached,
  };
}

// Records the warm-up's mic samples and measures them when it ends.
//
// Deliberately the same shape as ScoreAccumulator (addSample / reset /
// finalize), so PianoRoll's poll loop feeds whichever one is armed without
// knowing which kind of item is playing. Only one is ever armed at a time: a
// warm-up produces a range and no score, a song produces a score and no range.
export class RangeAccumulator {
  private targets: readonly TuningTarget[];
  private trace: ScoreSample[] = [];
  private compensationMs: number;

  constructor(targets: readonly TuningTarget[], compensationMs: number = 0) {
    this.targets = targets;
    this.compensationMs = compensationMs;
  }

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
      rms: typeof rms === "number" ? rms : null,
    });
  }

  // The raw take, for an offline re-measurement under a different estimator.
  samples(): readonly ScoreSample[] {
    return this.trace;
  }

  // A seek invalidates the measurement: the exercise is a walk, and somebody
  // who skipped its bottom half was never asked for those notes.
  reset() {
    this.trace = [];
  }

  finalize(): VocalRangeResult | null {
    if (this.targets.length === 0) return null;
    return estimateVocalRange(this.targets, this.trace, this.compensationMs);
  }
}

// Where a song lives, in MIDI numbers.
export interface SongRange {
  lowMidi: number;
  highMidi: number;
  // Duration-weighted 5th/95th percentiles: where the song actually sits, as
  // opposed to the one grace note at each extreme.
  tessituraLowMidi: number;
  tessituraHighMidi: number;
  noteCount: number;
  // Seconds of singing at each MIDI number, as [midi, seconds] pairs.
  //
  // This is what makes the whole feature affordable. Every fit question,
  // "does this sit comfortably" or "would -2 help", is a duration-weighted
  // count of note time inside a band, which needs the note list. Shipping or
  // re-fetching that per song is out of the question (a DAM blob is a network
  // call, a JOYSOUND melody is an 8s extraction), but the histogram answers all
  // of them exactly, compresses ~400 notes into ~40 pairs, and caches happily.
  histogram: ReadonlyArray<readonly [number, number]>;
}

// Duration-weighted percentile of note pitch.
function weightedPercentile(
  notes: readonly ScoringNote[],
  fraction: number,
): number {
  const sorted = [...notes].sort((a, b) => a.midiNumber - b.midiNumber);
  const totalMs = sorted.reduce(
    (acc, note) => acc + (note.endTime - note.startTime),
    0,
  );
  if (totalMs <= 0) return sorted[0].midiNumber;

  let cumulative = 0;
  for (const note of sorted) {
    cumulative += note.endTime - note.startTime;
    if (cumulative >= totalMs * fraction) return note.midiNumber;
  }
  return sorted[sorted.length - 1].midiNumber;
}

// Reads a song's range off the same scoring blob the piano roll draws.
//
// Tessitura is duration-weighted percentiles rather than min/max **on purpose**.
// JOYSOUND's own guide synth caps its register, playing the top note or two of a
// song an octave below the rest of the melody (~9% of notes in validation,
// see the header of guideMelody.ts), and that is a property of JOYSOUND's audio,
// not of our tracker. Absolute min/max is precisely the statistic those notes
// poison; a percentile shrugs them off. The absolute bounds are reported too,
// but nothing decides anything on them.
export function songRangeFromScoringData(
  scoringData: readonly number[],
): SongRange | null {
  const { notes } = parseScoringData(scoringData);
  if (notes.length === 0) return null;

  const seconds = new Map<number, number>();
  for (const note of notes) {
    const duration = note.endTime - note.startTime;
    if (duration <= 0) continue;
    seconds.set(
      note.midiNumber,
      (seconds.get(note.midiNumber) ?? 0) + duration,
    );
  }

  const midis = notes.map((note) => note.midiNumber);
  return {
    lowMidi: Math.min(...midis),
    highMidi: Math.max(...midis),
    tessituraLowMidi: weightedPercentile(notes, 0.05),
    tessituraHighMidi: weightedPercentile(notes, 0.95),
    noteCount: notes.length,
    histogram: [...seconds.entries()].sort((a, b) => a[0] - b[0]),
  };
}

// Everything below works from the histogram, so a cached song range answers
// every fit question with no notes, no fetch and no extraction.
export type PitchHistogram = ReadonlyArray<readonly [number, number]>;

// The comfortable band a suggestion is measured against.
export interface SingerBand {
  comfortableLowMidi: number;
  comfortableHighMidi: number;
}

// The octave (a whole number of them, in semitones) that puts this song where
// the singer would actually sing it.
//
// **This is not a correction of the singer, it is a correction of the data.**
// Measured across 56 song/take pairs, every cached melody with a probe trace
// of somebody singing it, the extracted JOYSOUND guide melody sits an octave
// above the singer on 33, two octaves above on 20, and in the same octave on
// only 3. Remove whole octaves and the residual median is 0.03 semitones: the
// pitch classes are exactly right and only the register is displaced. Two
// causes stack, and neither is a defect in the singing:
//
//   * JOYSOUND's guide synth plays above notation (guideMelody.ts's header
//     documents the register capping; F0_MAX_HZ is 1500 to accommodate tones
//     around 1.1-1.25kHz, which is D6), and
//   * people sing in whichever octave suits them, which is normal and correct.
//     A lower voice taking a high vocal line down an octave is not an error
//     and must never be treated as one.
//
// So the octave is not a meaningful axis for matching: the singer picks it,
// unconsciously and for free. Only the semitones inside it are what the
// transpose button changes, and only those are ever suggested.
export function songOctaveShiftFor(
  histogram: PitchHistogram,
  band: SingerBand,
): number {
  if (histogram.length === 0) return 0;
  const bandCentre = (band.comfortableLowMidi + band.comfortableHighMidi) / 2;
  // Duration-weighted, so the register the song *spends its time in* decides,
  // not a couple of outlying notes.
  let weighted = 0;
  let total = 0;
  for (const [midi, seconds] of histogram) {
    weighted += midi * seconds;
    total += seconds;
  }
  if (total <= 0) return 0;
  return Math.round((bandCentre - weighted / total) / 12) * 12;
}

// Fraction of the song's note *time* landing inside the singer's comfortable
// band at a given shift. Time-weighted rather than note-counted so a long held
// note outside the band counts for what it costs to sing.
function comfortableFraction(
  histogram: PitchHistogram,
  band: SingerBand,
  shiftSemis: number,
): number {
  let inside = 0;
  let total = 0;
  for (const [rawMidi, seconds] of histogram) {
    total += seconds;
    const midi = rawMidi + shiftSemis;
    if (midi >= band.comfortableLowMidi && midi <= band.comfortableHighMidi) {
      inside += seconds;
    }
  }
  return total > 0 ? inside / total : 0;
}

// At or above this much of the song inside the band, the song is a nice fit and
// we say so. Below it we simply say nothing. There is no "bad fit" state.
//
// Fitted against the 54 cached melodies rather than chosen by taste, and only
// meaningful *after* octave normalisation (before it, real songs sat 1-2 octaves
// off the band and nothing ever cleared any threshold). Real songs span a median
// 18 semitones absolute / 12 tessitura, so a band of typical width cannot hold
// all of one. At 0.75 the corpus lands: a narrow 10-semitone band marks 63% of
// songs comfortable and offers a key on 24%; a typical 14-semitone band marks
// 85% and offers 11%; an 18-semitone band marks everything and offers nothing,
// which for a singer with three octaves of comfortable range is simply true.
//
// **The corpus is biased and this number should be re-fitted.** These 54 songs
// are ones this room already chose and sang, so they are pre-selected toward
// singable; a Top 100 list browsed cold would be far more varied and the marker
// would be correspondingly scarcer. Re-fit once there is data from songs people
// looked at rather than songs people finished.
const COMFORTABLE_ENOUGH = 0.75;
// A shift has to buy at least this much more of the song before it is worth
// mentioning. Without it every song acquires a suggestion, which is nagging.
const MEANINGFUL_IMPROVEMENT = 0.12;
// ...and it has to land somewhere genuinely good, not merely better. A shift
// that leaves most of the song outside the band still reads as confident advice
// when it is shown, so it is better left unsaid.
const SUGGESTION_WORTH_MAKING = 0.6;
// Shifts offered. Matches the range the remocon's PitchControls can reach in a
// few taps, and beyond a fifth the arrangement stops sounding like itself.
const MAX_SHIFT_SEMIS = 6;

export interface KeyShiftSuggestion {
  semis: number;
  comfortableFractionAtShift: number;
  comfortableFractionAtZero: number;
}

// The positive-only marker: is this song already a nice fit, in the octave the
// singer would naturally take it in?
export function sitsComfortably(
  histogram: PitchHistogram,
  band: SingerBand,
): boolean {
  if (histogram.length === 0) return false;
  const octave = songOctaveShiftFor(histogram, band);
  return comfortableFraction(histogram, band, octave) >= COMFORTABLE_ENOUGH;
}

// A kinder key, or null.
//
// Null is the common and correct answer: the song already fits, or no shift
// meaningfully helps, or we have no measurement. The caller shows nothing at
// all in that case: never a warning, never a "this is a stretch". A returned
// suggestion is an offer that sits *beside* the normal queue button, never in
// place of it.
export function suggestKeyShift(
  histogram: PitchHistogram,
  band: SingerBand,
): KeyShiftSuggestion | null {
  if (histogram.length === 0) return null;

  // Everything below is measured on top of the octave the singer would take
  // this song in anyway, so the suggestion is purely the semitone part, the
  // only part the transpose button changes. See songOctaveShiftFor.
  const octave = songOctaveShiftFor(histogram, band);
  const atZero = comfortableFraction(histogram, band, octave);
  if (atZero >= COMFORTABLE_ENOUGH) return null;

  let best = 0;
  let bestFraction = atZero;
  // Ascending |shift| so the smallest shift wins ties naturally, since a
  // strictly greater test never replaces an equally good, smaller move.
  for (let magnitude = 1; magnitude <= MAX_SHIFT_SEMIS; magnitude++) {
    for (const semis of [-magnitude, magnitude]) {
      const fraction = comfortableFraction(histogram, band, octave + semis);
      if (fraction > bestFraction) {
        bestFraction = fraction;
        best = semis;
      }
    }
  }

  if (best === 0) return null;
  if (bestFraction - atZero < MEANINGFUL_IMPROVEMENT) return null;
  // A shift that still leaves the song mostly outside the band is not worth
  // announcing: "-6 would help" reads as confident advice, and it should only
  // be given when it actually lands somewhere good.
  if (bestFraction < SUGGESTION_WORTH_MAKING) return null;

  return {
    semis: best,
    comfortableFractionAtShift: bestFraction,
    comfortableFractionAtZero: atZero,
  };
}
