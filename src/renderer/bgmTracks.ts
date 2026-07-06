export interface BgmTrack {
  filename: string;
  label: string;
}

export const BGM_DIR = "./bgm/";

// Sentinel value for the "Shuffle" option, distinct from any real filename.
export const SHUFFLE_VALUE = "__shuffle__";

// All bundled tracks are loudness-normalized to -20 LUFS integrated so no
// single track jumps out at a given BGM volume setting. When adding a track,
// measure it (ffmpeg -i in.webm -filter:a ebur128 -f null -) and re-encode
// with a static gain of (-20 - measured LUFS) dB:
//   ffmpeg -i in.webm -filter:a volume=<gain>dB -c:a libopus -b:a 160k out.webm
export const BGM_TRACKS: readonly BgmTrack[] = [
  {
    filename: "joysound-magazine-song-selection.webm",
    label: "JOYSOUND Switch",
  },
  {
    filename: "joysound-streamer.webm",
    label: "JOYSOUND STREAMER",
  },
  {
    filename: "2-23-am.webm",
    label: "2:23 AM (Sharou)",
  },
];
