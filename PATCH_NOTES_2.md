# Karafriends Patch Notes #2

Everything since the last set of notes.

## New Features

**Scoring (experimental)**

- The app can now score your singing against the guide melody and put a card up when the song ends. Off by default — turn it on from the settings on either your phone or the big screen.
- Grades run D / C / B / A / S / SS / SSS, calibrated against what real singing actually scores rather than a theoretical perfect run.
- Accuracy (how on-pitch you were) and coverage (how much of the melody you actually sang) are tracked separately, so nailing four notes and mumbling the rest doesn't get you a full score.
- End-of-song graph showing how you did across 24 slices of the song.
- The formula is ours, not DAM's — the numbers are **not** comparable to a real DAM machine.
- Every score card is auto-saved as a screenshot in the app's data folder.
- YouTube and Niconico songs have no guide melody, so they never show a card.

**Singer accounts**

- Songs are now attributed to a _person_ instead of a phone. Clearing your browser data no longer makes you a stranger, and one person on two devices is no longer two people with two full queue limits.
- A new phone gets a "New phone, who this?" screen to claim an account, replacing the browser popup.
- Tap the avatar in the nav bar to switch accounts — for the phone that gets passed around the room.
- Admins get an "Edit accounts" mode for cleaning up duplicates and one-time guests.
- Your queue limit now counts per person rather than per device.

**Oricon charts**

- Added an "Oricon Top 10" button beside YouTube and Niconico.
- Leads with Oricon's live weekly karaoke Top 20, with yearly Top 10 charts for 2013–2025 behind it.
- Nothing gets looked up until you tap a row; then it searches both DAM and JOYSOUND for that title.

**Microphone controls (for running through a mixer)**

- Added a "Software Echo" toggle that mutes the mics through the app's own speakers while keeping pitch tracking and scoring working — for when you're mixing the mics externally instead.
- Added a "Pitch Gate" for that same setup: if your mixer's echo/reverb return bleeds back into the mic channels, an idle mic would ghost-draw the active singer's melody on the piano roll. The gate ignores anything below a level floor.
- The gate's threshold is adjustable live from either screen, with level meters showing each mic's level and where the threshold sits — so you can dial it in mid-song instead of guessing.

**Pop-out windows**

- The big-screen sidebar can now be popped out into its own window and dragged onto a laptop or second display. The TV then shows nothing but video.
- The join QR can be popped out the same way, so you can leave it up somewhere without covering the song.
- The phone remote gets a "Show Join QR" page with its own QR code, for handing the room to whoever's standing next to you.

**Avatars**

- In case you missed it: you can give yourself a nickname and a Pokémon Mystery Dungeon portrait as your avatar, framed like a PMD dialogue box. It shows up next to your songs in the queue and on the between-songs screen.
- The portrait picker now runs entirely off a copy bundled with the app — no internet needed, and searching is instant instead of one request per keystroke.
- You can browse the whole dex by default instead of having to search first; the text box filters the grid.
- Frame colour moved above the picker, and the version/emotion panel now appears above the grid so it isn't off-screen when you tap something halfway down the list.

**Music videos for JOYSOUND songs**

- The app now remembers which YouTube video you attached to a song and automatically re-attaches it (with your sync on/off choice) the next time anyone picks that song — no more re-searching. Queuing the song with the video detached makes it forget. Survives app restarts.
- Music videos uploaded at a slightly different _speed_ than the karaoke track are now stretched to match. (ロミオとシンデレラ's MV runs about 1.2% fast, which drifts 3+ seconds out by the end of the song — no fixed offset can fix that.)
- Videos that are region-locked outside Japan, or that don't allow embedding, no longer show a broken "Video unavailable" player on your phone. You get the thumbnail plus three stills from across the video so you can still check it's the right one. These still download and play fine as the background video.
- Age-restricted music videos can now be downloaded by supplying YouTube account cookies — drop a `youtube-cookies.txt` next to `config.yaml`. See the configuration docs for how to export one safely.

## Bug Fixes

- Fixed a DAM outage wedging the entire app: a song that couldn't load left a spinner, no background music, a stale "Now Playing", and a skip button that did nothing — relaunching was the only way out. Four separate bugs had to line up for it, and all four are fixed.
- Fixed music videos for very repetitive songs sometimes playing several seconds out of sync with the karaoke track (Shintakarajima ~3s ahead, Cruel Angel's Thesis missing its ~12s intro freeze). The sync measurement could lock onto the wrong repetition of a riff, or give up entirely when a karaoke re-recording's tempo wandered. It now collects every plausible alignment and picks the winner by checking whether the song's actual melody notes sound in the video at the times each alignment predicts.
- Fixed sometimes needing to press the queue button twice for a JOYSOUND song with a music video attached — pressing again while the video was still processing could wipe the in-progress work or error out invisibly. The button now shows "Processing video..." until the song actually lands in the queue, a repeat press is ignored, and failures show a visible error instead of sitting on "Waiting for server...".
- Fixed the singer's pitch trail being wiped mid-song. It was getting erased at every instrumental break and any time somebody queued a song.
- Fixed the score card never appearing for the last song of the night when there was nothing queued behind it — the most common case of singing one song and stopping.
- Fixed skipped songs flashing a D. Nobody sang a note; that's not a grade.
- Fixed the mic throwing away fresh audio whenever the app got busy — it was dropping the _newest_ audio and analysing stale samples instead.
- Fixed "Now Playing:" and "演奏中の曲:" drawing on top of each other for the first three seconds of every song.
- Fixed the off-state toggle knobs going invisible (black on black) in OLED Friendly mode.
- Fixed tied chart positions dropping rows — karaoke charts tie constantly, and two songs sharing a rank could make one of them disappear.
- Fixed the mic picker's "add a mic" row showing the mic you just picked instead of resetting, which made the next slot look pre-filled.
- Fixed the service status rows on the TV rendering scrambled, and the QR pop-out button disappearing in the exact arrangement it exists for.
- Fixed the app re-searching DAM for ~144 chart song readings on every single launch, forever. Second launch now issues zero.

## Improvements & Polish

- Score cards and the between-songs screen stay up about twice as long, so they're actually readable from across the room.
- The between-songs QR codes are noticeably bigger — they were paying for their white margin twice.
- Scoring now compensates for mic latency (the delay between you singing and the app hearing it), which was quietly costing everyone points near note boundaries. Worth roughly a full grade band.
- Short notes are now credited by how well you _held_ the pitch, instead of being dragged down by the blur at their edges. Notes in the 150–300ms range went from scoring ~65% to ~80% when actually hit.
- Settings on the phone and the TV now come from one shared list, so they can't drift apart anymore. The TV picked up the two settings it was missing (Scoring and Edit Break Message), both screens use the same names for the same things, and explanations show inline instead of hiding in tooltips nobody hovers over on a television.
- Mic controls, Software Echo and the Pitch Gate all live under one MICROPHONE section on both screens now, instead of trailing off the end of the volume settings.
- The remocon's "Software Echo: Off" buttons — whose label showed the current value rather than what tapping would do — are now proper switches.
- TV settings switches are right-aligned with the rest of the grid, and section headers have room to breathe.
- Diagnostic logs and score cards now save to the app's own data folder instead of your Pictures library.

## Setup Notes (for whoever's hosting)

- **NordVPN no longer works for DAM.** Its entire Japan pool is flagged as an anonymizer in the IP feeds DAM's video CDN filters on, and Osaka — the last working region — died all at once when its single address block got listed.
- Fixed DAM and JOYSOUND _logins_ ignoring the configured proxy while every other request honoured it — so the app looked correctly configured and failed anyway. This one was maddening to track down.
- Fixed a single Niconico song permanently un-proxying DAM downloads for the rest of the session. It only ever showed up mid-party.
- Note that `run-dev` and the packaged app read **different** `config.yaml` files. Configure one and the other silently keeps its defaults.
