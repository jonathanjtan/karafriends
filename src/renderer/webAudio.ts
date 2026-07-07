// Joysound's composited videos carry 3.0-channel audio: stereo backing on
// FL/FR and the guide melody isolated on FC. Chromium's default 3.0->stereo
// downmix folds the center channel into both ears at -3dB; routing the video
// through an explicit splitter/merger instead reproduces that mix while
// making the melody's contribution adjustable. Stereo sources (DAM, YouTube,
// Nico) pass through unchanged: their up-mix to the splitter's three
// channels leaves FC silent, so the melody gain has nothing to act on.
const CENTER_DOWNMIX_GAIN = Math.SQRT1_2;

export default class KarafriendsAudio {
  private gainNode: GainNode;
  private vocoderNode: AudioWorkletNode | null;
  private videoInputNode: GainNode;
  private guideMelodyGainNode: GainNode;

  audioContext: AudioContext;

  constructor() {
    this.audioContext = new AudioContext();
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);

    this.videoInputNode = this.audioContext.createGain();
    const splitterNode = this.audioContext.createChannelSplitter(3);
    const mergerNode = this.audioContext.createChannelMerger(2);
    this.guideMelodyGainNode = this.audioContext.createGain();
    this.guideMelodyGainNode.gain.value = CENTER_DOWNMIX_GAIN;

    this.videoInputNode.connect(splitterNode);
    splitterNode.connect(mergerNode, 0, 0);
    splitterNode.connect(mergerNode, 1, 1);
    splitterNode.connect(this.guideMelodyGainNode, 2);
    this.guideMelodyGainNode.connect(mergerNode, 0, 0);
    this.guideMelodyGainNode.connect(mergerNode, 0, 1);
    mergerNode.connect(this.gainNode);

    this.vocoderNode = null;
    this.audioContext.audioWorklet
      .addModule(
        new URL("worklet:./audio/phazeAudioWorklet.ts", import.meta.url),
      )
      .then(
        () => {
          this.vocoderNode = new AudioWorkletNode(
            this.audioContext,
            "phase-vocoder",
          );
          this.gainNode.disconnect();
          this.gainNode.connect(this.vocoderNode);
          this.vocoderNode.connect(this.audioContext.destination);
        },
        (e) => {
          console.log(
            "could not load pitch shift audio worklet, pitch shift will not work",
            e,
          );
        },
      );
  }

  pitchShift(semitones: number) {
    if (this.vocoderNode) {
      // @ts-expect-error i swear there's a .get method on this object.
      this.vocoderNode.parameters.get("pitchFactor").value = Math.pow(
        2,
        semitones / 12,
      );
    }
  }

  gain(gain: number) {
    this.gainNode.gain.value = gain;
  }

  // 1.0 reproduces the default downmix level; 0 mutes the guide melody.
  guideMelodyGain(gain: number) {
    this.guideMelodyGainNode.gain.value = gain * CENTER_DOWNMIX_GAIN;
  }

  sink(): AudioNode {
    return this.vocoderNode || this.gainNode;
  }

  // Entry point for the karaoke <video> element's audio. Routed through the
  // guide-melody split/merge stage and then the shared gain -> pitch shift
  // chain; connecting into gainNode (rather than sink()) keeps the video
  // subject to gain() regardless of when the vocoder worklet finishes
  // loading.
  videoSink(): AudioNode {
    return this.videoInputNode;
  }
}
