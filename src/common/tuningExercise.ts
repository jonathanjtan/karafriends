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

// Whole tones. A semitone walk doubles the length to buy resolution the
// "comfortable range" reading doesn't use -- the edge of a range is not a
// sharp boundary in the first place.
export const DEFAULT_STEP_SEMIS = 2;

// The piano roll's vertical window is exactly +/-18 semitones around the song's
// median note (midiNumberToYCoord divides by 36, and PianoRollMidi.vert.glsl
// clips outside 0..1), and notes are drawn one semitone thick either side. So
// an exercise wider than +/-17 around its centre would have its extremes -- the
// most interesting part -- silently clipped off the top and bottom of the
// canvas. Every preset below stays inside +/-16.
export const MAX_SPAN_FROM_CENTRE_SEMIS = 16;

// One preset per rough voice height rather than a single compromise default:
// the centre is what decides whether the walk spends its notes anywhere useful,
// and no one centre suits a bass and a soprano. The remocon offers all three;
// "mixed" is the default.
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
  stepSemis: number;
  floorMidi: number;
  ceilingMidi: number;
}

export interface TuningExerciseOptions {
  centreMidi?: number;
  stepSemis?: number;
  // Defaults derive from the centre and MAX_SPAN_FROM_CENTRE_SEMIS. Passing
  // these explicitly is allowed but they are clamped to the roll's window --
  // an exercise whose extremes are invisible measures nothing anybody can see.
  floorMidi?: number;
  ceilingMidi?: number;
}

function clampToWindow(value: number, centreMidi: number): number {
  return Math.max(
    centreMidi - MAX_SPAN_FROM_CENTRE_SEMIS,
    Math.min(centreMidi + MAX_SPAN_FROM_CENTRE_SEMIS, value),
  );
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
  const stepSemis = Math.max(
    1,
    Math.round(options.stepSemis ?? DEFAULT_STEP_SEMIS),
  );
  const floorMidi = clampToWindow(
    options.floorMidi ?? centreMidi - MAX_SPAN_FROM_CENTRE_SEMIS,
    centreMidi,
  );
  const ceilingMidi = clampToWindow(
    options.ceilingMidi ?? centreMidi + MAX_SPAN_FROM_CENTRE_SEMIS,
    centreMidi,
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
  for (
    let midi = centreMidi - stepSemis;
    midi >= floorMidi;
    midi -= stepSemis
  ) {
    push(midi, "descend");
  }

  cursorSecs += REST_BETWEEN_LEGS_SECS;

  for (
    let midi = centreMidi + stepSemis;
    midi <= ceilingMidi;
    midi += stepSemis
  ) {
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
    stepSemis,
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
