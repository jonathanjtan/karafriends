export const HOSTNAME = "karafriends.local";

export const RUBY_FONT_SIZE = 20;
export const RUBY_FONT_STROKE = 3;

// Where the top of the piano roll sits, as a fraction of the player screen
// height. Its height below that point is the synced pianoRollSize setting.
// Shared so the Joysound lyrics layout can keep rows out from under it.
export const PIANO_ROLL_TOP_FRACTION = 0.05;

// The piano roll's visible window is TIME_WIDTH_SECS wide, with "now"
// pinned at CURSOR_FRACTION from the left edge; notes scroll right-to-left
// past it. Shared so callers can know how far ahead of "now" upcoming notes
// become visible (LOOKAHEAD_SECS), e.g. to un-duck the roll before notes
// scroll in rather than only once they're due.
export const PIANO_ROLL_TIME_WIDTH_SECS = 7.0;
export const PIANO_ROLL_CURSOR_FRACTION = 0.3;
export const PIANO_ROLL_LOOKAHEAD_SECS =
  PIANO_ROLL_TIME_WIDTH_SECS * (1 - PIANO_ROLL_CURSOR_FRACTION);

// Absolute RMS floor (linear full-scale) below which pitch frames are
// discarded while the Pitch Gate setting is on. 0.02 ≈ -34 dBFS: singing
// into a properly gained mic runs around -20..-12 dBFS RMS, while a mixer's
// FX-return bleed on an idle channel sits well below its dry source. The
// pitch detector is amplitude-invariant, so this floor — not confidence —
// is what separates the two.
export const MIC_RMS_GATE_THRESHOLD = 0.02;
