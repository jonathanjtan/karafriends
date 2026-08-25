# Overview

Karafriends is a karaoke jukebox you run yourself.

If a term feels unfamiliar, check the
[Glossary](glossary.md). It covers both the karaoke domain (DAM, JOYSOUND,
romaji, furigana) and the stack (Electron, GraphQL, Relay, Rust/Neon,
Parcel, mDNS).

## The user story

You want to run a karaoke session somewhere. You have a TV, a computer
that can plug into it, some microphones, and everyone's phones (likely on the same network).

1. You start karafriends on the computer. A fullscreen window appears on the
   TV showing a big QR code, a (currently empty) queue, and a placeholder for
   the song video.
2. Participants point their phone cameras at the QR code, tap the link, and
   their phone's browser opens the **remocon** ("remote control"), a touch
   UI for finding and queuing songs.
3. Participants search for songs by title or artist, or paste a YouTube link, and
   tap "queue". The TV's queue updates instantly. Their nickname appears next
   to the song so everyone sees who picked it.
4. As songs play, the lyrics scroll on the TV in sync with the music.
5. (Configurable) Anyone with the remocon can pause, skip, reorder, change the key (pitch
   shift the music up or down a few semitones), or send emote reactions
   that float across the TV screen.

## What makes it different from "just play a YouTube video"

A few things you'd take for granted at a real karaoke booth that karafriends
goes out of its way to recreate:

- **Real lyrics rendered in real time.** YouTube videos don't always have
  proper karaoke-style lyrics. Songs queued from **DAM** or **JOYSOUND** (the
  two big Japanese karaoke services) include synchronized lyric data, and
  karafriends parses that data and draws the lyrics itself, with the right
  highlight timing as each syllable plays.
- **Furigana and romaji.** Japanese lyrics often contain kanji that not
  every singer can read. Karafriends can render small phonetic hints
  (_furigana_) above kanji, or convert lyrics entirely to romaji (Latin
  letters) for the brave. This uses a Japanese natural-language library
  called Kuroshiro along with a kanji-reading dictionary.
- **Pitch scoring.** A native (Rust) audio module listens to your mic, runs
  a pitch-detection algorithm, and the renderer overlays your detected
  pitch against the song's pitch track on a piano-roll-style graph.
- **Pitch shift.** Songs can be transposed up or down in semitones so they
  fit a singer's vocal range. This applies to both the music playback and
  the scoring target.
- **A real queue.** Multiple people can queue songs concurrently from
  different phones. Nicknames stick to queued items so the TV shows
  "Next: _X_, queued by Alice".
- **Reactions.** While someone sings, anyone holding the remocon can fire
  off emote characters that briefly fly across the TV.

## Song sources

Karafriends supports four places a song can come from. They fall into two
groups:

- **Real karaoke sources**, **DAM** and **JOYSOUND**. These provide proper
  karaoke renditions (instrumental tracks, sometimes a guide vocal), exact
  timed lyrics, and scoring data. Karafriends talks to the same back-end
  APIs that DAM/JOYSOUND's own apps use, so you need a user account with
  each service to use them. See [Configuration](configuration.md) for where
  to put credentials.
- **General video sources**, **YouTube** and **Niconico** (a Japanese
  video site). These are a fallback when a song isn't on DAM/JOYSOUND or
  you just want to sing along to a music video. There are no real lyrics
  data, so singers either rely on lyrics burned into the video, on YouTube
  captions (if the uploader added them), or on **adhoc lyrics**: a feature
  where the queue-er types lyrics into the remocon and they appear on the
  TV during playback. Pitch scoring is not available for video-source
  songs.

The remocon's home screen shows all four sources as tiles so guests pick
one before searching.

## What you, the operator, do

Once configured, karafriends mostly runs itself. The operator (whoever set
it up) typically:

1. Edits `config.yaml` once to add DAM/JOYSOUND credentials, and to mark
   themselves as an admin so they can do things like skip songs even when
   they didn't queue them.
2. Plugs the computer into the TV and runs the app.
3. Plugs in microphones, opens the renderer's small settings sidebar
   (press `Q` to toggle) to pick which audio input each microphone is.
4. Lets everyone scan the QR code, then sings.

Hostname resolution uses **mDNS**, so when phones on the same Wi-Fi look up
`karafriends.local`, the renderer machine answers. This is why the QR code
contains a link like `http://karafriends.local:8080/` rather than a raw IP
address, so guests don't have to know your network details.

## Where to go next

- [Architecture](architecture.md) explains how the renderer, the remocon,
  the Electron main process, and the Rust audio module fit together.
- [Configuration](configuration.md) covers every field in `config.yaml`,
  where the file lives on disk, and the few environment-variable overrides
  the dev/test scripts use.
- [Development](development.md) walks through getting the project to build
  from a clean checkout.
