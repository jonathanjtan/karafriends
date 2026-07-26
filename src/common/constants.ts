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
// discarded while the Pitch Gate setting is on. Singing into a properly
// gained mic runs around -20..-12 dBFS RMS, while a mixer's FX-return bleed
// on an idle channel sits well below its dry source. The pitch detector is
// amplitude-invariant, so this floor — not confidence — is what separates
// the two.
//
// The working value is the synced micRmsGateThreshold setting rather than a
// constant, because no single number is right for every room: how far the
// bleed sits below the dry signal depends on the mixer's gain staging and on
// how much FX send is up, and it can only be judged with people actually
// singing — which a packaged app can't be rebuilt to do mid-session.
// The bounds run from -46 dBFS (barely above a quiet room) to -16.5 dBFS,
// which is already inside normal singing level: past that you gate the
// singer, not the bleed.
export const DEFAULT_MIC_RMS_GATE_THRESHOLD = 0.02;
export const MIN_MIC_RMS_GATE_THRESHOLD = 0.005;
export const MAX_MIC_RMS_GATE_THRESHOLD = 0.15;

// The threshold is stored linear (that is how it gets compared against a
// frame's RMS) but presented in dBFS. A linear slider crams every useful
// setting into its bottom sixth, whereas dB spaces them evenly and is the
// unit the "bleed sits N dB below its source" reasoning already works in.
// The same conversion drives the mic level meters, so these are deliberately
// generic rather than threshold-specific.
export function linearToDbfs(linear: number): number {
  return 20 * Math.log10(linear);
}

export function dbfsToLinear(dbfs: number): number {
  return 10 ** (dbfs / 20);
}
