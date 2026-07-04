# Configuration

Karafriends reads a single YAML file, `config.yaml`, the first time it
starts. If the file doesn't exist, it's created with safe defaults — but
several fields contain placeholders like `YOUR_USERNAME_HERE` that you
must fill in before features depending on them work.

## Where the file lives

It's stored in Electron's per-user "userData" folder, which varies by
operating system:

| OS      | Path                                                    |
| ------- | ------------------------------------------------------- |
| Windows | `%APPDATA%\karafriends\config.yaml`                     |
| macOS   | `~/Library/Application Support/karafriends/config.yaml` |
| Linux   | `~/.config/karafriends/config.yaml`                     |

If you delete the file, the next run will recreate it from defaults.

On every startup, karafriends re-reads the file and then _writes it back_
merged with defaults. That means any new fields added in a future
version will appear in your file automatically; it also means comments
and key ordering won't survive a restart.

## Fields

All fields are defined in [src/common/config.ts](../src/common/config.ts).

### Song-source credentials

| Field              | Default              | Meaning                                                   |
| ------------------ | -------------------- | --------------------------------------------------------- |
| `damUsername`      | `YOUR_USERNAME_HERE` | DAMtomo account user code. Required to queue DAM songs.   |
| `damPassword`      | `YOUR_PASSWORD_HERE` | DAMtomo account password.                                 |
| `joysoundEmail`    | `YOUR_EMAIL_HERE`    | JOYSOUND account email. Required to queue JOYSOUND songs. |
| `joysoundPassword` | `YOUR_PASSWORD_HERE` | JOYSOUND account password.                                |

You need a real account with each service. YouTube and Niconico work
without any credentials.

If you only have one set of credentials, that's fine — searches against
the other service just won't return results.

### Playback behaviour

| Field               | Default | Meaning                                                                                                      |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `useLowBitrateUrl`  | `false` | If true, fetch the lower-bitrate stream from DAM. Useful on flaky connections.                               |
| `paxSongQueueLimit` | `1`     | How many songs a single non-admin guest is allowed to have queued at once. "pax" = guest. Admins are exempt. |

### Networking

| Field         | Default | Meaning                                                                                                          |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `devPort`     | `3000`  | Port the Parcel dev server runs on. Only relevant in development.                                                |
| `remoconPort` | `8080`  | Port the Electron main process serves the remocon and `/graphql` on. This is the port guests' phones connect to. |

The QR code on the TV is built from `karafriends.local` (via mDNS) plus
`remoconPort`, so if you change `remoconPort` your QR code changes
automatically.

### Outbound HTTP proxy

These let karafriends route its outgoing HTTP traffic — DAM, JOYSOUND,
YouTube, Niconico — through a corporate proxy. Most users leave
`proxyEnable` false.

| Field         | Default           | Meaning              |
| ------------- | ----------------- | -------------------- |
| `proxyEnable` | `false`           | Master switch.       |
| `proxyHost`   | `PROXY_HOST_HERE` | Hostname or IP.      |
| `proxyPort`   | `1234`            | Port.                |
| `proxyUser`   | `PROXY_USER_HERE` | HTTP Basic username. |
| `proxyPass`   | `PROXY_PASS_HERE` | HTTP Basic password. |

The Electron window's session and the Apollo data sources are both
configured to honor these. Local addresses (RFC1918 ranges) bypass the
proxy automatically, so the remocon traffic over your LAN is unaffected.

### Admin and moderation

| Field            | Default | Meaning                                                                                                                      |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `adminNicks`     | `[]`    | List of remocon nicknames considered admin.                                                                                  |
| `adminDeviceIds` | `[]`    | List of stable device IDs considered admin.                                                                                  |
| `supervisedMode` | `false` | When true, non-admins can't perform destructive operations (skipping/removing songs they didn't queue, force-popping, etc.). |

The remocon assigns each phone a random "deviceId" on first visit and
stores it in localStorage so it stays stable. The user types a nickname
themselves. Either can identify an admin, depending on how strict you
want to be — nicknames are easy to spoof, deviceIds aren't.

Setting at least one admin is highly recommended; otherwise mischievous
guests can skip each other's songs at will (well, unless you turn on
supervised mode, but then nobody can).

## Environment overrides

A couple of fields can be overridden via environment variables. These
exist so the test suite can run multiple instances of karafriends on
different ports simultaneously:

| Variable                   | Overrides     |
| -------------------------- | ------------- |
| `KARAFRIENDS_DEV_PORT`     | `devPort`     |
| `KARAFRIENDS_REMOCON_PORT` | `remoconPort` |

You probably never need these as a normal user.

## Example config.yaml

A minimal but functional configuration with a DAM account and a single
admin:

```yaml
useLowBitrateUrl: false
paxSongQueueLimit: 2
devPort: 3000
remoconPort: 8080

damUsername: "12345678"
damPassword: "hunter2"

joysoundEmail: "YOUR_EMAIL_HERE"
joysoundPassword: "YOUR_PASSWORD_HERE"

adminNicks:
  - "alice"
adminDeviceIds: []
supervisedMode: false

proxyEnable: false
proxyHost: "PROXY_HOST_HERE"
proxyPort: 1234
proxyUser: "PROXY_USER_HERE"
proxyPass: "PROXY_PASS_HERE"
```

Note that JOYSOUND credentials are left as placeholders here. JOYSOUND
search will fail at the API level but the rest of the app remains
fully functional.
