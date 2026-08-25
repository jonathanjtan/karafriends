import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import path from "path";
import { parse, stringify } from "yaml";

export interface KarafriendsConfig {
  // Whether to use the low bitrate URLs for DAM songs
  useLowBitrateUrl: boolean;
  // Whether to download DAM songs locally instead of streaming them
  paxSongQueueLimit: number;
  // Which port to connect to the development server on
  devPort: number;
  // Which port to listen on for the remocon server
  remoconPort: number;
  // DAM username for DAM creds
  damUsername: string;
  // DAM password for DAM creds
  damPassword: string;
  // Joysound email for joysound creds
  joysoundEmail: string;
  // Joysound password for joysound creds
  joysoundPassword: string;
  // List of admins by nickname
  adminNicks: string[];
  // List of admins by deviceId
  adminDeviceIds: string[];
  // Whether to enable supervised mode
  supervisedMode: boolean;
  // Whether to use a HTTP proxy (for outgoing connections)
  proxyEnable: boolean;
  // hostname or address of the HTTP proxy to use
  proxyHost: string;
  // port of the HTTP proxy to use
  proxyPort: number;
  // HTTP Basic username of the HTTP proxy to use
  proxyUser: string;
  // HTTP Basic password of the HTTP proxy to use
  proxyPass: string;
  // Path to a Netscape-format cookies.txt with youtube.com cookies, passed
  // to yt-dlp so age-restricted/bot-checked videos can be downloaded. Empty
  // means "look for youtube-cookies.txt next to this config file, else go
  // without cookies".
  youtubeCookiesPath: string;
  // Fixed part of the mic-to-score latency compensation, in milliseconds. The
  // singer hears the karaoke through the output path and is themselves
  // recorded through the input path, so a sung pitch reaches the scorer late;
  // scoring shifts each sample back by this much to line it up with the note
  // it was actually aimed at. Live output latency (AudioContext.outputLatency)
  // is added on top at runtime. This covers everything that latency can't
  // see, chiefly the input/ADC/USB path, which the OS does not report
  // truthfully on macOS. Machine-specific: measure it with
  // scripts/measureMicLatency.mjs (its answer minus the ~25ms live output
  // term) and set it here. 0 disables scoring compensation entirely.
  micLatencyCalibrationMs: number;
  // Log one PROBE_PITCH line per accepted pitch sample during scoring, for
  // recalibrating micLatencyCalibrationMs with scripts/measureMicLatency.mjs.
  // Off in normal use (a line per sample is ~40/s of log spam). Turn it on
  // here, run the app capturing stdout, sing a song, then turn it back off.
  pitchProbeEnabled: boolean;
}

const DEFAULT_CONFIG: KarafriendsConfig = {
  useLowBitrateUrl: false,
  paxSongQueueLimit: 1,
  devPort: 3000,
  remoconPort: 8080,
  damUsername: "YOUR_USERNAME_HERE",
  damPassword: "YOUR_PASSWORD_HERE",
  joysoundEmail: "YOUR_EMAIL_HERE",
  joysoundPassword: "YOUR_PASSWORD_HERE",
  adminNicks: [],
  adminDeviceIds: [],
  supervisedMode: false,
  proxyEnable: false,
  proxyHost: "PROXY_HOST_HERE",
  proxyPort: 1234,
  proxyUser: "PROXY_USER_HERE",
  proxyPass: "PROXY_PASS_HERE",
  youtubeCookiesPath: "",
  // Default from the sweep on the dev machine (measured ~105ms total minus
  // the ~25ms live output term). Re-measure per machine; a wrong value here
  // only skews scoring, never playback.
  micLatencyCalibrationMs: 80,
  pitchProbeEnabled: false,
};

function applyEnvironmentOverrides(config: KarafriendsConfig) {
  if (process.env.KARAFRIENDS_DEV_PORT)
    config.devPort = parseInt(process.env.KARAFRIENDS_DEV_PORT, 10);
  if (process.env.KARAFRIENDS_REMOCON_PORT)
    config.remoconPort = parseInt(process.env.KARAFRIENDS_REMOCON_PORT, 10);
  return config;
}

function getConfig(): KarafriendsConfig {
  // Refer to https://www.electronjs.org/docs/latest/api/app#appgetpathname
  // for where the config file should be placed. On Windows, it should be %APPDATA%/karafriends/config.yaml
  let config = DEFAULT_CONFIG;

  const configFilepath: string = path.join(
    app.getPath("userData"),
    "config.yaml",
  );

  console.log(`Checking ${configFilepath} for configs`);

  if (fs.existsSync(configFilepath)) {
    console.log(`Configs found. Loading them up.`);
    const localConfig: KarafriendsConfig = parse(
      fs.readFileSync(configFilepath, { encoding: "utf8", flag: "r" }),
    );
    config = { ...DEFAULT_CONFIG, ...localConfig };
  } else {
    console.log("No local configs found. Using default.");
  }

  // write back defaults
  fs.mkdirSync(path.dirname(configFilepath), { recursive: true });
  fs.writeFileSync(configFilepath, stringify(config));

  return applyEnvironmentOverrides(config);
}

const karafriendsConfig: KarafriendsConfig = getConfig();

export default karafriendsConfig;
