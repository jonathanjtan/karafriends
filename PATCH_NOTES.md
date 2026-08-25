# Karafriends Patch Notes #1

Everything that's changed since we forked karafriends from the original project.

## New features

**Background music**

- The app now fades in and out background music during intermissions. Multiple tracks to choose from, plus a "Shuffle" option.
- Volume slider available from remocon or sidebar.

**Piano roll (the scrolling note guide)**

- The scrolling note guide now works for JOYSOUND songs too (previously DAM only).
- Resizable (Off/Small/Medium/Large) with opacity adjustments.
- Smooth scrolling instead of paginating.

**Guide melody (the "helper" tune you can hear)**

- Added a volume control for the sung guide melody, adjustable from your phone or the big screen, for both JOYSOUND and DAM songs.

**Music videos for JOYSOUND songs**

- The app can now automatically find and suggest the official YouTube music video for a JOYSOUND song instead of requiring you to search yourself.
- Added the option to turn off video/audio syncing per song, in case it ever produces a bad sync.

**Search**

- Searching in plain English/romaji (e.g. typing "aidoru") now also finds Japanese-titled songs.
- JOYSOUND search results now show a romanized (English-letter) version of Japanese titles and artist names, matching what DAM already did. Uses DAM as the canonical romanization source w/ a DIY fallback.

**Queue and playback controls**

- Added the ability to reorder songs in the queue (move them up or down) from your phone.
- Added a "Clear Queue" button to empty the whole queue and skip the current song.
- Added a "Break" feature that pauses the show with a countdown and an optional custom message (e.g. a water break reminder) shown on the big screen.
- Added a between-songs "Up Next" screen showing what's coming up, who queued it, and a QR code so people can join in.

**Look and feel**

- Added a dark mode toggle for the phone remote.
- Added an "OLED Friendly" mode for the big screen that inverts the settings sidebar to reduce screen burn-in risk on OLED TVs.
- The big-screen sidebar can now be collapsed and resized by dragging, and it animates smoothly when opening/closing.
- Added a QR code to the "between songs" screen so people can scan it to start queuing songs.

**Other**

- (Windows Only) Added a factory reset tool that wipes local data (queue, downloaded songs, etc.) without touching config.yaml.
- The app now announces instrumental breaks partway through JOYSOUND songs and dims the piano roll.

## Bug fixes

- Fixed the queue getting permanently stuck after certain playback errors. The app now skips ahead automatically instead of freezing.
- Fixed songs occasionally vanishing from the queue silently if the streaming service had a hiccup; the app now skips forward and shows a message instead.
- Fixed the app sometimes crashing entirely while downloading a song's video.
- Fixed a crash on startup on Windows.
- Fixed the phone remote occasionally showing a blank white screen instead of loading properly.
- Fixed the queue and playback state sometimes getting corrupted after closing and reopening the app.
- Fixed login problems with the DAM service after switching networks or VPNs. The app now shows a clearer error and retries automatically.

## Improvements and polish

- Sped up loading JOYSOUND songs you've already viewed or queued before.
- Reworked the settings panels on both the phone and big screen to be more compact and organized.
- Added a live status indicator showing whether DAM/JOYSOUND are currently reachable, with a manual "Check now" button.
- Smoother transitions, better spacing, and clearer labels.

## Platform support

- Added support for running the app natively on Apple Silicon Macs (M-series chips).
- Various fixes to make development and building work consistently across macOS, Windows, and Linux.
- Fixed the bundled YouTube-downloading tool going stale and causing music video downloads to silently fail. It's now kept up to date automatically with every build.
