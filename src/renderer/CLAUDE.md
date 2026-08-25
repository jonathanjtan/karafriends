# src/renderer: big-screen display subsystems

Loaded when working under `src/renderer`. Root `CLAUDE.md` has the always-on
rules, in particular the **queue-advance contract** (every song-start path must
terminate in `play()` or `pollQueue()`, `.catch` included), which lives there
because breaking it wedges the whole app.

## Piano roll (`PianoRoll.tsx` + `shaders/`)

Continuous right-to-left scroll past a fixed "now" cursor at
`CURSOR_FRACTION=0.3` of canvas width, `TIME_WIDTH_SECS=7`. All shader programs
take a `cursorFraction` uniform. Opacity/size are synced settings applied as
plain CSS (the GL effect's deps are `[props]`, so a hook-state change re-renders
without rebuilding the GL pipeline; canvas backing-store resize is handled by a
ResizeObserver). Size `0` = "Off" (hides the canvas). JOYSOUND telop lyrics
reflow to clear the roll (`remapLyricsYPos` in JoysoundRenderer).

- **WebGL test harness lesson**: `drawImage`/late `readPixels` from a WebGL
  canvas without `preserveDrawingBuffer` returns blank after compositing, so
  pixel assertions must run synchronously right after draw. `readPixels`
  y-origin is bottom-left.

## The sidebar, and its pop-out window (`Sidebar.tsx`)

The QR + Settings + Queue column is one component rendered in two places:
docked beside the video (`variant="docked"`, drag-resizable, collapsible) and in
a **second BrowserWindow** (`variant="window"`), opened by the pop-out button in
the Settings header. That window loads the _same renderer bundle_ with
`?panel=settings`; `renderer/index.tsx` routes on it and mounts `SettingsPanel`
instead of `App` (no audio graph, no kuromoji dictionary, no Player). While it's
open the docked sidebar stays collapsed, so the big screen is all video.

- There is a **second panel window**, `?panel=qr` → `QrPanel`: the join QR and
  its URL, nothing else, to drag onto a laptop beside the TV and leave idle.
  Opened from the hover affordance on the sidebar QR. It needs no bus at all.
  `hostname` is a synced setting (main owns the LAN-address default), which is
  exactly why it was moved off renderer state. The remocon's `/join` view is the
  phone-to-phone counterpart, and uses `window.location.origin` rather than
  `hostname`: that's an address the holder's phone demonstrably reaches the app
  on.
- Every setting in there is a **synced setting**, so both windows just talk to
  the main process over GraphQL and need no coordination. The two exceptions are
  **mic selection** and the **mic level meters**: `InputDevice`s are created
  through the preload's native binding and are owned by the process whose
  PianoRoll polls them, so the big screen owns them and the panel drives them
  over a small IPC bus (`renderer/settingsPanelBus.ts` + preload's
  `settingsPanel` + the relay in `main/index.ts`). The panel sends intents
  ("select this mic") and renders the snapshots it gets back; levels are
  published at ~15Hz only while the panel is open. **Don't create an InputDevice
  in the panel window.** It would be a second, silent capture stream that
  scores nothing.
- Narrow-sidebar layout is a **`@container sidebar` query** on `.appSidebar` (it
  reflows against the sidebar's dragged width, not the window's). Placements
  from the wide 3-column grid must be re-stated in there: a leftover
  `grid-column: 2 / 4` in a 2-column grid silently creates an _implicit_ third
  column, which is what used to push the value column off the clipped edge at
  180px. The other way to overflow that grid is a wide _intrinsic_ minimum.
  `1fr` is `minmax(auto, 1fr)`, so a nowrap label ("Scoring (experimental)") or
  a `<select>`'s widest `<option>` sets the column width regardless of the
  container. Labels wrap and selects get `min-width: 0` in there.

## BGM

Bundled tracks in `src/common/bgmTracks.ts` (normalized to −20 LUFS; see the
file header for the re-encode recipe). Track selection and volume are synced
settings; the renderer plays them between songs.
