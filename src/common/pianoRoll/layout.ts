// The per-song description a piano roll is drawn from: notes, bands, and the
// vertical window they were laid out in.
//
// The big screen derives this from the song's scoring blob once, draws from it,
// and publishes it to main (publishSongPianoRoll) so the remocon's lyrics panel
// can draw the same roll. The phone never sees the scoring blob: the pitch
// shift is already folded in here, so a key change on the TV reaches the phone
// as a republished layout rather than as something for it to recompute.

import { parseScoringData, ScoringInterval, ScoringNote } from "../scoringData";
import { median, spanSemisFor } from "./geometry";

// Bumped whenever the shape below changes. A phone holding a layout it doesn't
// understand says so and asks for a reload, rather than drawing nonsense.
export const PIANO_ROLL_LAYOUT_VERSION = 1;

export interface PianoRollLayout {
  version: number;
  // Guide melody notes with pitchShiftSemis already applied.
  notes: ScoringNote[];
  // Gaps between sung phrases, drawn as dimmed bands.
  freeTimeIntervals: ScoringInterval[];
  pogIntervals: ScoringInterval[];
  // Where the floating vertical axis sits, and how tall its window is.
  medianMidiNumber: number;
  spanSemis: number;
}

// Null when the song has no guide melody to draw (a JOYSOUND song whose
// melody channel yielded nothing, a YouTube video, an unscored DAM song).
export function buildPianoRollLayout(
  scoringData: readonly number[],
  pitchShiftSemis: number,
): PianoRollLayout | null {
  if (scoringData.length === 0) return null;

  const {
    notes: rawNotes,
    freeTimeIntervals,
    pogIntervals,
  } = parseScoringData(scoringData);
  if (rawNotes.length === 0) return null;

  const notes = rawNotes.map((note) => ({
    ...note,
    midiNumber: note.midiNumber + pitchShiftSemis,
  }));
  const midiNumbers = notes.map((note) => note.midiNumber);
  const medianMidiNumber = median(midiNumbers);

  return {
    version: PIANO_ROLL_LAYOUT_VERSION,
    notes,
    freeTimeIntervals,
    pogIntervals,
    medianMidiNumber,
    // Widens only when the note set genuinely doesn't fit the historical
    // +/-18 window, which in practice means only the guided range exercise.
    spanSemis: spanSemisFor(midiNumbers, medianMidiNumber),
  };
}
