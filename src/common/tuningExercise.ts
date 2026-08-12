// Generates the guided warm-up exercise behind the range check.
//
// The exercise is a sequence of sustained tones walking outward from a
// comfortable centre: a few repeats to let the singer find the tone, then down
// to the floor, then up to the ceiling. One target pitch at a time is the whole
// point -- because the target is known, vocalRange.ts can accept or reject a
// mic sample against it *without* octave folding, which is what makes the
// measurement trustworthy where a post-hoc read of a song take is not (see
// docs/scoring-scorecard-proposal.md:207, where the 2nd percentile of detected
// pitch read F2 on every take in the corpus).
//
// Like scoring.ts and guideMelody.ts this is pure logic with no
// electron/DOM/network imports, so it can be exercised offline.

import { GuideMelodyNote } from "./guideMelody";

// How long each target is held, and the silence after it. 1.5s is long enough
// to need real support (and to give the 300ms sustain gate room) without
// turning a 19-note exercise into a chore.
const NOTE_SECS = 1.5;
const GAP_SECS = 0.5;
// Repeats of the centre note before the walk starts, so nobody is measured on
// the first sound they make.
const SETTLE_REPEATS = 3;
// Silence before the first target. The piano roll fades in
// PIANO_ROLL_LOOKAHEAD_SECS (4.9s) before the first note reaches the cursor, so
// this is roughly "the roll is already on screen when the exercise starts".
const LEAD_IN_SECS = 5;
// Breather between the descending and ascending legs. Deliberately under
// guideMelody's PHRASE_GAP_MS (4000), so the whole exercise stays a single
// phrase: two phrases would have the piano roll shade the gap as free time,
// and findInstrumentalBreaks needs 12s so neither reading invents a break.
const REST_BETWEEN_LEGS_SECS = 3;
// Enough for the last note to scroll clear of the cursor and the roll to fade
// out (PIANO_ROLL_CURSOR_FRACTION * PIANO_ROLL_TIME_WIDTH_SECS is 2.1s), plus a
// beat before the card.
const PIANO_ROLL_TAIL_SECS = 3;

// The walk moves by scale degree, not by a fixed number of semitones.
//
// It used to step a constant 2 semitones, which is a **whole-tone scale** --
// C D E F# G# A#, no perfect fifth and no leading tone. That is the Debussy
// dream-sequence sound, and it reads as eerie and unresolved to anybody asked
// to sing it. A major scale is what a vocal warm-up actually uses, it is
// singable without a reference chord, and its average step (~1.7 semitones) is
// slightly finer than whole tones, so the range reading gets marginally better
// resolution rather than worse.
//
// Semitone offsets of the major scale from its tonic.
const MAJOR_SCALE_SEMIS = [0, 2, 4, 5, 7, 9, 11];

// The note `degree` scale steps from `tonic` (negative walks down). Octaves are
// handled by flooring, so degree -1 from C4 is B3 rather than anything clever.
function scaleNote(tonic: number, degree: number): number {
  const octave = Math.floor(degree / MAJOR_SCALE_SEMIS.length);
  const step =
    ((degree % MAJOR_SCALE_SEMIS.length) + MAJOR_SCALE_SEMIS.length) %
    MAJOR_SCALE_SEMIS.length;
  return tonic + 12 * octave + MAJOR_SCALE_SEMIS[step];
}

// The walk covers the whole plausible singing range regardless of where it
// starts, so nobody's measurement is cut short by a preset they picked before
// they had any information. E2 is below most bass ranges and C6 above most
// sopranos; anyone who reaches either end genuinely has more range than this
// test measures, and the card says so rather than pretending it is a limit.
//
// This used to be a +/-16 window around the centre, because the piano roll's
// vertical axis was fixed at +/-18 semitones and a wider exercise had its
// extremes -- the interesting part -- silently clipped off the canvas. The roll
// now scales to whatever it is given (see midiNumberToYCoord's spanSemis), so
// the exercise is bounded by human voices instead of by the display.
export const VOCAL_FLOOR_MIDI = 40; // E2
export const VOCAL_CEILING_MIDI = 84; // C6

// One preset per rough voice height. It picks only where the walk *starts*, so
// nobody is cold-started at an extreme; the range covered is the same either
// way. The remocon offers all three; "mixed" is the default.
export interface TuningPreset {
  id: "lower" | "mixed" | "higher";
  label: string;
  centreMidi: number;
}

export const TUNING_PRESETS: readonly TuningPreset[] = [
  { id: "lower", label: "Lower voices", centreMidi: 53 /* F3 */ },
  { id: "mixed", label: "Mixed", centreMidi: 60 /* C4 */ },
  { id: "higher", label: "Higher voices", centreMidi: 67 /* G4 */ },
];

export const DEFAULT_PRESET_ID = "mixed";

// Which leg of the walk a target belongs to. The card groups by this, and the
// settle notes are excluded from the measurement entirely.
export type TuningPhase = "settle" | "descend" | "ascend";

export interface TuningTarget {
  index: number;
  midiNumber: number;
  startTime: number;
  endTime: number;
  phase: TuningPhase;
}

export interface TuningExercise {
  targets: TuningTarget[];
  // The same tones as guide-melody notes, for buildScoringData. Includes the
  // settle repeats: they should be drawn and sounded like everything else, they
  // are just not measured.
  notes: GuideMelodyNote[];
  durationSecs: number;
  centreMidi: number;
  floorMidi: number;
  ceilingMidi: number;
}

export interface TuningExerciseOptions {
  centreMidi?: number;
  // Default to the full plausible vocal range. Overrides are clamped to it --
  // there is no musical reason to ask anybody for a note below E2 or above C6,
  // and an unbounded exercise would just be long.
  floorMidi?: number;
  ceilingMidi?: number;
}

function clampToVocalRange(value: number): number {
  return Math.max(VOCAL_FLOOR_MIDI, Math.min(VOCAL_CEILING_MIDI, value));
}

export function presetById(id: string): TuningPreset {
  return (
    TUNING_PRESETS.find((preset) => preset.id === id) ??
    TUNING_PRESETS.find((preset) => preset.id === DEFAULT_PRESET_ID)!
  );
}

// Builds the exercise. Targets come out time-ordered, which placeSamples' and
// phraseIntervals' forward-only cursors both rely on.
export function buildTuningExercise(
  options: TuningExerciseOptions = {},
): TuningExercise {
  const centreMidi = Math.round(
    options.centreMidi ?? presetById(DEFAULT_PRESET_ID).centreMidi,
  );
  const floorMidi = clampToVocalRange(options.floorMidi ?? VOCAL_FLOOR_MIDI);
  const ceilingMidi = clampToVocalRange(
    options.ceilingMidi ?? VOCAL_CEILING_MIDI,
  );

  const targets: TuningTarget[] = [];
  let cursorSecs = LEAD_IN_SECS;

  const push = (midiNumber: number, phase: TuningPhase) => {
    targets.push({
      index: targets.length,
      midiNumber,
      startTime: cursorSecs,
      endTime: cursorSecs + NOTE_SECS,
      phase,
    });
    cursorSecs += NOTE_SECS + GAP_SECS;
  };

  for (let i = 0; i < SETTLE_REPEATS; i++) push(centreMidi, "settle");

  // Down first: voices settle downward more easily than they leap upward, and
  // a singer who has already found the centre arrives at the bottom warmer.
  // The centre is the tonic, so each preset walks its own key (F, C, G major).
  for (let degree = -1; ; degree--) {
    const midi = scaleNote(centreMidi, degree);
    if (midi < floorMidi) break;
    push(midi, "descend");
  }

  cursorSecs += REST_BETWEEN_LEGS_SECS;

  for (let degree = 1; ; degree++) {
    const midi = scaleNote(centreMidi, degree);
    if (midi > ceilingMidi) break;
    push(midi, "ascend");
  }

  const notes: GuideMelodyNote[] = targets.map((target) => ({
    startMs: Math.round(target.startTime * 1000),
    endMs: Math.round(target.endTime * 1000),
    midi: target.midiNumber,
  }));

  return {
    targets,
    notes,
    // The trailing gap after the last target is deliberate: the roll needs
    // CURSOR_FRACTION * TIME_WIDTH_SECS to scroll the final note past the left
    // edge, and "ended" firing on top of the last note is an abrupt finish.
    durationSecs: cursorSecs - GAP_SECS + PIANO_ROLL_TAIL_SECS,
    centreMidi,
    floorMidi,
    ceilingMidi,
  };
}

// MIDI note number -> the name a singer would recognise. Sharps rather than
// flats throughout; this is a readout, not a key signature.
const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

export function midiToNoteName(midiNumber: number): string {
  const rounded = Math.round(midiNumber);
  // MIDI 60 is C4 in the scientific pitch notation singers and tuner apps use.
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${octave}`;
}
