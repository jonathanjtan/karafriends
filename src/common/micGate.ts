import { dbfsToLinear } from "./constants";

// The mic level gate: decides, from level alone, which pitch frames are the
// singer and which are the mixer's FX-return bleeding into an idle channel.
//
// Pure and framework-free on purpose, so the renderer's poll loop and an
// offline replay of a captured PROBE_FRAME log run the *same* gate. That is
// the only way a change here can be judged against a night of real singing
// rather than one take and a hunch, the same arrangement scripts/
// replayScoring.mjs already gives the scoring formula.
//
// Why a state machine, where this used to be a single `rms < threshold` test
// per frame: a sung note is not a rectangle. Its level dips through
// consonants, through the release at the end of a phrase, and through every
// breath, so a phrase sitting anywhere near the threshold does not fail
// cleanly, it *chatters*, punching holes through the middle of notes the
// singer is plainly still on. Those holes are not only cosmetic on the roll.
// They cost coverage inside the note, they break the consecutive-slot runs
// longToneScore counts, and one in the wrong place looks to the onset detector
// exactly like the silence that precedes an attack.
//
// Hence the classic noise-gate shape: hysteresis plus hold. Open at the
// threshold, then stay open until the level has sat below a *lower* close
// threshold for longer than the hold. Note that both terms can only ever admit
// frames the old test rejected, since a frame at or above the threshold is
// accepted exactly as it was before, so turning this on cannot newly cut a
// singer off. What it costs is a bounded tail of bleed at the end of a phrase,
// no longer than the hold.
//
// What it deliberately does not attempt: separating a quiet verse from the
// bleed of a loud chorus. Bleed is a scaled copy of the dry voice, so the
// quantity that separates them is a ratio and the quantity thresholded here is
// a level. No setting of an absolute threshold, adaptive or not, is right in
// both sections at once. That needs a cross-channel comparison, which is a
// separate change.

// How far below the open threshold the gate closes. Half the amplitude: wide
// enough to ride the dip between two syllables of one word, narrow enough that
// it does not silently halve the threshold the operator dialled in against the
// room.
export const MIC_GATE_HYSTERESIS_DB = 6;

// How long the gate stays open after the level last cleared the close
// threshold. Longer than a consonant or a snatched breath, and comfortably
// longer than one 25ms scoring slot, but far shorter than the gap between two
// sung phrases, so the end of a phrase cannot hold the gate open into the
// bleed that follows it.
export const MIC_GATE_HOLD_MS = 150;

// A backwards step in sample time larger than this is a seek rather than the
// few ms of jitter that ordinary polling produces (the video clock is read
// once per poll and each frame's age subtracted from it, so consecutive polls
// can disagree slightly at the boundary). A seek restarts the machine; the
// jitter must not, or the gate would reset several times a second.
const SEEK_BACKSTEP_SECS = 0.25;

export class MicGate {
  private open = false;
  // Sample time of the most recent frame at or above the close threshold.
  private lastAboveSecs = 0;
  // Sample time of the most recent frame seen at all, which is what lets a
  // seek be told from the ordinary forward march.
  private lastSeenSecs = 0;

  constructor(
    private readonly hysteresisDb: number = MIC_GATE_HYSTERESIS_DB,
    private readonly holdMs: number = MIC_GATE_HOLD_MS,
  ) {}

  // Call when the audio being fed in is no longer continuous with what came
  // before: a seek, a new song, or the gate having been switched off and back
  // on. Without it the machine would carry a stale "open" across the
  // discontinuity and pass whatever sits on the other side of it.
  reset(): void {
    this.open = false;
    this.lastAboveSecs = 0;
    this.lastSeenSecs = 0;
  }

  // `timeSecs` is the video-clock time the frame was sung at, not the time the
  // poll collected it: the hold is a duration of *audio*, and a batch of
  // frames collected in one poll spans several hold-lengths' worth of it.
  accepts(rms: number, timeSecs: number, thresholdLinear: number): boolean {
    if (timeSecs < this.lastSeenSecs - SEEK_BACKSTEP_SECS) this.reset();
    this.lastSeenSecs = Math.max(this.lastSeenSecs, timeSecs);

    const closeThreshold = thresholdLinear * dbfsToLinear(-this.hysteresisDb);

    if (rms >= closeThreshold) {
      // Clearing the *open* threshold is what opens a shut gate. Between the
      // two thresholds a frame can only sustain a gate that is already open,
      // which is the whole point of the hysteresis.
      if (rms >= thresholdLinear) this.open = true;
      if (!this.open) return false;
      this.lastAboveSecs = timeSecs;
      return true;
    }

    if (!this.open) return false;
    if ((timeSecs - this.lastAboveSecs) * 1000 <= this.holdMs) return true;
    this.open = false;
    return false;
  }
}
