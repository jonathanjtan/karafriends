export interface BgmTrack {
  filename: string;
  label: string;
}

export const BGM_DIR = "./bgm/";

// Sentinel value for the "Shuffle" option, distinct from any real filename.
export const SHUFFLE_VALUE = "__shuffle__";

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
