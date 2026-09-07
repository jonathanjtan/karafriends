// A smoothed read of a <video>'s playback position, for animation only.
//
// Both scrolling surfaces (the piano roll, and the JOYSOUND telop wipe) derive
// where to draw from the media clock every frame. Sampled raw, that clock is
// not smooth: it advances at the audio renderer's update granularity, which
// beats against the display's refresh. Measured against a 29.97fps composite on
// a 60Hz display, `currentTime` sits within +/-3.5ms of the wall clock in a
// repeating ~6-frame sawtooth. On a 1920px canvas at TIME_WIDTH_SECS=7 that
// turns an ideal 4.57px scroll step into one ranging 3.5-5.5px (p05-p95), with
// outliers at 1.6px and 6.6px: a +/-20% velocity wobble at a *perfect* 60fps
// with no dropped frames. It reads as judder even though nothing is slow, which
// is why chasing it as a frame-rate problem finds nothing.
//
// Playback rate is 1, so the offset between media time and wall time is a
// constant plus that jitter, and one-pole filtering the offset removes the
// jitter while still tracking the real clock.
//
// This is for DRAWING ONLY. Pitch samples are still stamped with the raw
// `currentTime` (see PianoRoll's pollPitch): the mic-latency calibration was
// measured through that path, and quietly re-basing it on a smoothed clock
// would shift a number that was tuned by ear against a real room.

// Past this the media clock has genuinely moved rather than jittered: a seek, a
// stall, a loop, or the first frame after play. Snap to it instead of slewing,
// so a seek lands immediately rather than sliding into place over a second.
const RESYNC_SECS = 0.25;

// One-pole coefficient, applied once per animation frame. At 60Hz this is a
// ~0.5s time constant: it attenuates the sawtooth above by well over an order
// of magnitude, and still pulls out any genuine drift inside a second.
const SMOOTHING_ALPHA = 0.03;

export default class MediaClock {
  // Media time minus wall time. Null means "not anchored", so the next running
  // frame adopts whatever the element reports.
  private offsetSecs: number | null = null;
  private lastMediaSecs = 0;

  // The position to draw at, in seconds. Call once per animation frame: the
  // filter is driven by call frequency, so a second caller on a different
  // cadence (a setInterval, say) needs its own instance rather than sharing
  // this one.
  now(video: HTMLVideoElement): number {
    const raw = video.currentTime;

    // Nothing to smooth while the clock isn't running, and a playbackRate other
    // than 1 breaks the constant-offset assumption the filter rests on. Both
    // fall back to the raw clock and re-anchor on the next running frame.
    if (video.paused || video.seeking || video.playbackRate !== 1) {
      this.offsetSecs = null;
      this.lastMediaSecs = raw;
      return raw;
    }

    const wallSecs = performance.now() / 1000;
    const offset = raw - wallSecs;

    if (
      this.offsetSecs === null ||
      Math.abs(offset - this.offsetSecs) > RESYNC_SECS
    ) {
      this.offsetSecs = offset;
      this.lastMediaSecs = raw;
      return raw;
    }

    this.offsetSecs += (offset - this.offsetSecs) * SMOOTHING_ALPHA;
    const smoothed = wallSecs + this.offsetSecs;

    // Never hand back a position behind the last one. A moment of backwards
    // scroll is far more visible than the sub-millisecond error clamping it
    // costs, and a real backwards seek resyncs above rather than arriving here.
    // The wall clock advances ~16.7ms a frame against at most ~0.1ms of offset
    // correction, so this cannot stall the clock.
    this.lastMediaSecs = Math.max(this.lastMediaSecs, smoothed);
    return this.lastMediaSecs;
  }

  // Re-anchor on the next frame, for when the position is known to have jumped
  // (a seek) and there is no reason to wait for RESYNC_SECS to notice.
  reset() {
    this.offsetSecs = null;
  }
}
