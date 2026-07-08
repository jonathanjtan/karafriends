import { GuideMelodyNote, parseScoringData } from "../common/guideMelody";

// Loudness of the synthesized guide at 100% guide melody volume. Calibrated
// against how prominently Joysound's real guide-melody channel sits in its
// mix: the FC channel's voiced RMS lands within 0.1dB of the full mix RMS,
// and DAM streams measure ~1.5dB quieter than Joysound mixes, so a tone
// peaking at 0.15 FS gives the synth roughly the same presence in a DAM mix.
const SYNTH_PEAK_GAIN = 0.15;
// A touch of 2nd harmonic keeps the tone audible over mid-heavy mixes
// without turning it into a piercing beep. The periodic wave is normalized,
// so this doesn't change the peak level.
const SECOND_HARMONIC_GAIN = 0.3;
const ATTACK_S = 0.015;
const RELEASE_S = 0.05;
// When resyncing mid-song, notes with less than this much time left aren't
// worth scheduling.
const MIN_REMAINING_S = 0.03;
// Fade time constant used when playback stops mid-note, so pausing doesn't
// click.
const STOP_FADE_S = 0.01;

interface ScheduledNote {
  oscillator: OscillatorNode;
  envelope: GainNode;
}

// Plays a synthesized guide melody for DAM songs, following the same scoring
// reference data the piano roll draws. DAM's streams are plain stereo with
// no isolated guide-melody channel (unlike Joysound's 3.0 oggs), so an
// adjustable guide has to be generated locally. Note scheduling tracks the
// karaoke <video> element: (re)synced whenever playback starts or seeks,
// silenced on pause/stall/src change. The output node this feeds
// (KarafriendsAudio.guideMelodySynthSink()) sits ahead of the master gain
// and pitch-shift stages, so tone shifts move the guide with the song.
export default class DamGuideMelodySynth {
  private audioContext: BaseAudioContext;
  private output: AudioNode;
  private video: HTMLVideoElement;
  private notes: GuideMelodyNote[];
  private wave: PeriodicWave;
  private scheduled: Set<ScheduledNote> = new Set();

  private handleResync = () => this.resync();
  private handleStop = () => this.stopAll();
  private handleSeeked = () => {
    if (!this.video.paused && !this.video.ended) this.resync();
  };

  constructor(
    audioContext: BaseAudioContext,
    output: AudioNode,
    video: HTMLVideoElement,
    scoringData: ArrayLike<number>,
  ) {
    this.audioContext = audioContext;
    this.output = output;
    this.video = video;
    this.notes = parseScoringData(scoringData);
    this.wave = audioContext.createPeriodicWave(
      new Float32Array([0, 0, 0]),
      new Float32Array([0, 1, SECOND_HARMONIC_GAIN]),
    );

    video.addEventListener("playing", this.handleResync);
    video.addEventListener("seeked", this.handleSeeked);
    video.addEventListener("pause", this.handleStop);
    video.addEventListener("seeking", this.handleStop);
    video.addEventListener("waiting", this.handleStop);
    video.addEventListener("ended", this.handleStop);
    video.addEventListener("emptied", this.handleStop);

    if (!video.paused && !video.ended) this.resync();
  }

  dispose() {
    this.stopAll();

    this.video.removeEventListener("playing", this.handleResync);
    this.video.removeEventListener("seeked", this.handleSeeked);
    this.video.removeEventListener("pause", this.handleStop);
    this.video.removeEventListener("seeking", this.handleStop);
    this.video.removeEventListener("waiting", this.handleStop);
    this.video.removeEventListener("ended", this.handleStop);
    this.video.removeEventListener("emptied", this.handleStop);
  }

  private resync() {
    this.stopAll();

    const now = this.audioContext.currentTime;
    // ctxTime = mediaTime + mediaToCtx
    const mediaToCtx = now - this.video.currentTime;

    for (const note of this.notes) {
      const startAt = note.startMs / 1000 + mediaToCtx;
      const stopAt = note.endMs / 1000 + mediaToCtx;
      if (stopAt < now + MIN_REMAINING_S) continue;
      this.scheduleNote(note, Math.max(startAt, now), stopAt);
    }
  }

  private scheduleNote(note: GuideMelodyNote, startAt: number, stopAt: number) {
    const oscillator = this.audioContext.createOscillator();
    oscillator.setPeriodicWave(this.wave);
    oscillator.frequency.value = 440 * Math.pow(2, (note.midi - 69) / 12);

    const envelope = this.audioContext.createGain();
    const attackEnd = Math.min(startAt + ATTACK_S, stopAt);
    envelope.gain.setValueAtTime(0, startAt);
    envelope.gain.linearRampToValueAtTime(SYNTH_PEAK_GAIN, attackEnd);
    envelope.gain.setValueAtTime(
      SYNTH_PEAK_GAIN,
      Math.max(stopAt - RELEASE_S, attackEnd),
    );
    envelope.gain.linearRampToValueAtTime(0, stopAt);

    oscillator.connect(envelope);
    envelope.connect(this.output);

    const entry = { oscillator, envelope };
    this.scheduled.add(entry);
    oscillator.onended = () => {
      envelope.disconnect();
      this.scheduled.delete(entry);
    };

    oscillator.start(startAt);
    oscillator.stop(stopAt);
  }

  private stopAll() {
    const now = this.audioContext.currentTime;
    for (const { oscillator, envelope } of this.scheduled) {
      envelope.gain.cancelScheduledValues(now);
      envelope.gain.setTargetAtTime(0, now, STOP_FADE_S);
      // Re-issuing stop() moves the already-scheduled stop time forward;
      // cleanup happens in onended. Notes scheduled entirely in the future
      // now stop before they start, which plays nothing and still fires
      // onended.
      oscillator.stop(now + STOP_FADE_S * 8);
    }
  }
}
