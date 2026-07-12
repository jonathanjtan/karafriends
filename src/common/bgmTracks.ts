export interface BgmTrack {
  filename: string;
  label: string;
  // Full "Title - Artist/Source" credit shown on the intermission screen's
  // "Now Playing" line (label stays short for the remocon dropdown).
  canonicalName: string;
  // True when the track's end flows seamlessly back into its start, so
  // shuffling into the same track can restart it without a fade.
  loopable?: boolean;
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
    canonicalName:
      "Magazine/Song Selection - カラオケJOYSOUND for Nintendo Switch",
    loopable: true,
  },
  {
    filename: "joysound-streamer.webm",
    label: "JOYSOUND STREAMER",
    canonicalName:
      "Stream_BGM_LoFiChill_03.wav - カラオケJOYSOUND for STREAMER",
    loopable: true,
  },
  {
    filename: "2-23-am.webm",
    label: "2:23 AM (Sharou)",
    canonicalName: "2:23 AM - Sharou",
    loopable: true,
  },
];
