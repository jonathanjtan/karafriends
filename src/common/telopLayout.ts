// JOYSOUND telop lyrics as the big screen lays them out, and the canvas code
// that draws them. Shared by the TV (JoysoundRenderer, which uploads what this
// draws as WebGL textures) and the remocon's lyrics panel (which draws the
// same thing into a 2D canvas), so the phone mirrors the TV glyph for glyph:
// same reading guides, same word segmentation, same colors, same wipe.
//
// The layout is built once per song from the parser's output
// (toTelopLayout in joysoundParser.ts) on the TV, which is the only place
// kuroshiro and the kuromoji dictionary live. The TV then publishes it to main
// as JSON, which is how the phone gets romaji without a 12MB dictionary.
//
// Keep this file free of any import that isn't tiny: the remocon bundles it,
// and joysoundParser.ts drags kuroshiro and kuromoji along with it.

import { RUBY_FONT_SIZE, RUBY_FONT_STROKE } from "./constants";

// Bumped whenever the shape below changes, so a phone running a stale bundle
// can tell it is looking at a layout it can't draw rather than drawing it
// wrong.
export const TELOP_LAYOUT_VERSION = 2;

// The virtual screen JOYSOUND authors every telop position in.
export const TELOP_SCREEN_WIDTH = 720;
export const TELOP_SCREEN_HEIGHT = 480;
export const TELOP_TEXT_PADDING = 16;

// Lyrics are drawn this far behind the media clock. Both surfaces must apply
// it, or the phone's wipe runs 200ms ahead of the TV's.
export const TELOP_TIMING_OFFSET_MS = -200;

const TITLE_FONT_SIZE = 48;
const TITLE_FONT_STROKE = 4;

const ARTIST_FONT_SIZE = 32;
const ARTIST_FONT_STROKE = 4;

const METADATA_FONT_SIZE = 24;
const METADATA_FONT_STROKE = 3;

const MAIN_FONT_SIZE = 44;
const MAIN_FONT_STROKE = 4;

const ROMAJI_FONT_SIZE = 20;
const ROMAJI_FONT_STROKE = 2;

export const BREAK_FONT_SIZE = 32;
export const BREAK_FONT_STROKE = 3;
// Where the "（間奏　約N秒）" notice goes when the piano roll is hidden:
// JOYSOUND's own bottom-of-screen subtitle position. With the roll visible
// the TV instead centers the notice in the (ducked) roll's band, the one
// region placeTelopRows guarantees lyrics never occupy. Backing vocals can
// keep singing through a guide-melody gap, and the bottom position collided
// with their telop.
export const BREAK_Y_FRACTION = 0.82;
// The notice pops in a beat after the break starts and doesn't need to
// stay up for the whole break; the piano roll stays ducked regardless.
export const BREAK_TEXT_DELAY_MS = 500;
export const BREAK_TEXT_DURATION_MS = 5000;

const TEXT_PADDING = TELOP_TEXT_PADDING;
const SCREEN_WIDTH = TELOP_SCREEN_WIDTH;
const SCREEN_HEIGHT = TELOP_SCREEN_HEIGHT;

// A reading guide drawn on one side of the main text. The same three values
// as the LyricsAnnotation GraphQL enum, so a synced setting is a layout value
// with no mapping in between.
export type TelopAnnotation = "NONE" | "FURIGANA" | "ROMAJI";

export const TELOP_ANNOTATIONS: readonly TelopAnnotation[] = [
  "NONE",
  "FURIGANA",
  "ROMAJI",
];

// The three guides in the order every surface offers them, with the names
// it calls them. Shared so the settings screens and the queue page can't
// drift into labelling or ordering the same choice differently.
export const TELOP_ANNOTATION_CHOICES: {
  label: string;
  value: TelopAnnotation;
}[] = [
  { label: "Furigana", value: "FURIGANA" },
  { label: "Romaji", value: "ROMAJI" },
  { label: "Off", value: "NONE" },
];

// Which guide is drawn above the main text and which below it. A room
// setting, so the TV re-lays the current song out when it changes and the
// phone follows the republished layout.
export interface TelopAnnotations {
  top: TelopAnnotation;
  bottom: TelopAnnotation;
}

// Kana over the kanji as JOYSOUND authored it, and the pronunciation under
// the whole line for whoever can't read the kana either.
export const DEFAULT_TELOP_ANNOTATIONS: TelopAnnotations = {
  top: "FURIGANA",
  bottom: "ROMAJI",
};

// Narrows a value read off the wire or off disk (a persisted queue.json, a
// Relay "%future added value") to an annotation, else `fallback`.
export function asTelopAnnotation(
  value: unknown,
  fallback: TelopAnnotation,
): TelopAnnotation {
  return TELOP_ANNOTATIONS.includes(value as TelopAnnotation)
    ? (value as TelopAnnotation)
    : fallback;
}

// The title card's field labels follow the reader: anyone who wanted romaji
// under the lyrics wants "Lyrics:" rather than "作詞" too.
export function telopUsesLatinLabels(annotations: TelopAnnotations): boolean {
  return annotations.top === "ROMAJI" || annotations.bottom === "ROMAJI";
}

// One glyph of the main text row, already decoded (with the block's flags,
// which is what tells the card-suit glyphs apart from the Shift-JIS characters
// sharing their code points).
export interface TelopGlyph {
  text: string;
  // The advance JOYSOUND authored for this glyph, in telop units. Glyphs are
  // centered in it rather than laid out by the font's own metrics, which is
  // why a fallback font still lands every glyph in the right place.
  width: number;
  // 0 = Japanese, 1 = Korean. Picks the font face.
  font: number;
}

// One ruby annotation, one string per character: the ruby row is laid out a
// fixed pitch per character, so how many there are is part of the geometry.
export interface TelopFurigana {
  xPos: number;
  chars: string[];
}

export interface TelopRomaji {
  phrase: string;
  xPos: number;
  sourceWidth: number;
}

export interface TelopScrollEvent {
  time: number;
  speed: number;
}

export interface TelopBlock {
  xPos: number;
  yPos: number;
  // [r, g, b], 0-255. "pre" is the unsung color, "post" the wiped one.
  preFill: number[];
  postFill: number[];
  preBorder: number[];
  postBorder: number[];
  glyphs: TelopGlyph[];
  furigana: TelopFurigana[];
  // Sorted by xPos, which is the order they're drawn in.
  romaji: TelopRomaji[];
  scrollEvents: TelopScrollEvent[];
  // Telop milliseconds, compared against the media clock plus
  // TELOP_TIMING_OFFSET_MS. -1 when the timeline never showed the block.
  fadeinTime: number;
  fadeoutTime: number;
}

export interface TelopTitle {
  musicName: string;
  artistName: string;
  lyricistName: string;
  composerName: string;
  // The title card is up until this telop time.
  fadeoutTime: number;
}

// An instrumental break (間奏), in seconds. The same shape as scoringData's
// InstrumentalBreak, restated here so the remocon needn't import that module.
export interface TelopBreak {
  startTime: number;
  endTime: number;
  approxDurationSecs: number;
}

export interface TelopLayout {
  version: number;
  // The reading guides this layout was drawn with. Every block carries both
  // its furigana and its romaji regardless; this says which of them went
  // where.
  annotations: TelopAnnotations;
  title: TelopTitle;
  blocks: TelopBlock[];
  breaks: TelopBreak[];
}

// How telop units map onto a canvas's pixels. `rate` scales fonts and strokes;
// `x`/`y` scale positions. They differ on the TV, whose telop canvas is
// stretched over the video however wide the window is (glyphs keep their shape
// and the gaps between them widen); the phone scales uniformly.
export interface TelopRaster {
  rate: number;
  x: number;
  y: number;
  // Canvas font-family strings. The TV names its bundled faces; the phone
  // adds a fallback stack for while the bundled one is still downloading.
  jpFont: string;
  krFont: string;
}

function getFontFace(raster: TelopRaster, fontCode: number): string {
  switch (fontCode) {
    case 0:
      return raster.jpFont;
    case 1:
      return raster.krFont;
    default:
      return raster.jpFont;
  }
}

// --- Block geometry --------------------------------------------------------
//
// A block's image stacks, top to bottom: the top guide row (if any), the main
// text row, the bottom guide row (if any), with TEXT_PADDING around the lot.
// Each row is a stroke box (font size plus a stroke either side); adjacent
// stroke boxes touch, and the glyphs' own side bearings are the air between
// them. The block's authored yPos sits MAIN_ROW_OFFSET above the main row's
// stroke box, which is where JOYSOUND's own renderer puts it.

// A furigana or romaji row's stroke box. Both guides use RUBY_FONT_SIZE, and
// the taller furigana stroke sizes the row so switching guides doesn't move
// anything.
const GUIDE_ROW_HEIGHT = RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2;
const MAIN_ROW_HEIGHT = MAIN_FONT_SIZE + MAIN_FONT_STROKE * 2;
const MAIN_ROW_OFFSET = 8;
// Between the main row and a bottom guide row. Kanji ink stops short of the
// bottom of its em box and kana starts below the top of its own, so the rows
// can nearly touch and still read as spaced like the top guide does.
const BOTTOM_GUIDE_GAP = 2;
// The least air placeTelopRows leaves between one row's lowest stroke box and
// the next row's highest. JOYSOUND's own row pitch (94) leaves 16 above a
// furigana row, so a layout with no bottom guide is never respaced.
const ROW_AIR = 8;
// Kept clear below the lowest row, so glyphs don't sit flush against the
// bottom of the screen. The gap above the rows is the caller's, folded into
// the clearance it passes.
const SCREEN_BOTTOM_MARGIN = 8;

function getTopGuideHeight(annotations: TelopAnnotations): number {
  return annotations.top === "NONE" ? 0 : GUIDE_ROW_HEIGHT;
}

function getBottomGuideHeight(annotations: TelopAnnotations): number {
  return annotations.bottom === "NONE"
    ? 0
    : BOTTOM_GUIDE_GAP + GUIDE_ROW_HEIGHT;
}

export function getLyricsBlockWidth(lyricsBlock: TelopBlock): number {
  const mainBlockWidth = lyricsBlock.glyphs.reduce(
    (acc, curr) => acc + curr.width,
    0,
  );

  const rightmostFuriganaBlock =
    lyricsBlock.furigana[lyricsBlock.furigana.length - 1];
  const furiganaBlockWidth = rightmostFuriganaBlock
    ? rightmostFuriganaBlock.xPos +
      (RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2) *
        rightmostFuriganaBlock.chars.length
    : 0;

  return (
    MAIN_FONT_STROKE * 2 +
    Math.max(mainBlockWidth, furiganaBlockWidth) +
    TEXT_PADDING * 2
  );
}

export function getLyricsBlockHeight(annotations: TelopAnnotations): number {
  return (
    getTopGuideHeight(annotations) +
    MAIN_ROW_HEIGHT +
    getBottomGuideHeight(annotations) +
    TEXT_PADDING * 2
  );
}

// How far a block's image extends above its yPos (the top guide row and the
// padding) and below it (the rest). Ascent plus descent is the height.
export function getLyricsBlockAscent(annotations: TelopAnnotations): number {
  return getTopGuideHeight(annotations) + MAIN_ROW_OFFSET + TEXT_PADDING;
}

export function getLyricsBlockDescent(annotations: TelopAnnotations): number {
  return getLyricsBlockHeight(annotations) - getLyricsBlockAscent(annotations);
}

// The same two measured to the block's ink rather than to its image: a block
// carries TEXT_PADDING of transparency on every side so a stroke or a
// descender can't be clipped by the canvas it is drawn into. That padding is
// not margin, and fitting rows into a band must not spend the band on it, or
// the lyrics shrink for space nothing is drawn in.
function getInkAscent(annotations: TelopAnnotations): number {
  return getLyricsBlockAscent(annotations) - TEXT_PADDING;
}

function getInkDescent(annotations: TelopAnnotations): number {
  return getLyricsBlockDescent(annotations) - TEXT_PADDING;
}

export interface TelopRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Where a block's rasterized image goes, in telop units, with the block drawn
// at `yPos` (its own, unless placeTelopRows has moved its row). Its texture
// covers exactly this rect.
export function getLyricsBlockRect(
  lyricsBlock: TelopBlock,
  annotations: TelopAnnotations,
  yPos: number = lyricsBlock.yPos,
): TelopRect {
  return {
    left: lyricsBlock.xPos - TEXT_PADDING,
    top: yPos - getLyricsBlockAscent(annotations),
    width: getLyricsBlockWidth(lyricsBlock),
    height: getLyricsBlockHeight(annotations),
  };
}

// --- Row placement ---------------------------------------------------------

// Where a song's rows land on a surface: each authored yPos mapped to the
// yPos it's drawn at, and one scale every block shrinks by (about its own
// yPos and horizontal center) when the rows had to be compressed to fit.
export interface TelopRowPlacement {
  scale: number;
  rows: Map<number, number>;
}

// JOYSOUND authors its rows 94 units apart, enough for a furigana row above
// each line and nothing below it. A bottom guide row makes a line taller than
// that, so with both guides on, one row's romaji would sit on the next row's
// furigana. This spreads the rows apart until every pair clears, keeping the
// lowest row where JOYSOUND put it (the band JOYSOUND leaves the video above
// its lyrics is part of the look) and moving the others up. Only if the top
// row would then leave the screen does the whole set slide down, and only if
// that isn't enough does it shrink.
//
// `clearance` is how much of the top of the screen something else owns, on
// the TV the piano roll. With any clearance the rows are instead centered in
// the band below it, scaled down when the band can't hold them, so the
// lyrics don't hug the bottom of the screen as the roll grows. Compressing
// the spacing alone let a squeezed row's furigana overlap the main text of the
// row above it, so the blocks shrink in lockstep with the spacing. With no
// clearance and nothing to spread this is an exact no-op.
//
// Both surfaces run this: the phone with clearance 0, the TV with whatever
// the roll takes. It's what keeps a bottom guide row off the next line on
// both.
export function placeTelopRows(
  layout: TelopLayout,
  clearance: number,
): TelopRowPlacement {
  const authored = [...new Set(layout.blocks.map((block) => block.yPos))].sort(
    (a, b) => a - b,
  );
  const rows = new Map<number, number>();

  if (authored.length === 0) {
    return { scale: 1, rows };
  }

  const ascent = getInkAscent(layout.annotations);
  const descent = getInkDescent(layout.annotations);
  // Stroke box to stroke box: the padding on either side is transparent.
  const requiredPitch = ascent + descent + ROW_AIR;

  const offsets = [0];
  for (let i = 1; i < authored.length; i++) {
    offsets.push(
      offsets[i - 1] + Math.max(authored[i] - authored[i - 1], requiredPitch),
    );
  }
  const span = offsets[offsets.length - 1];
  const spread = span > authored[authored.length - 1] - authored[0];

  if (clearance <= 0 && !spread) {
    authored.forEach((yPos) => rows.set(yPos, yPos));
    return { scale: 1, rows };
  }

  let scale = 1;
  let first: number;

  const floor = SCREEN_HEIGHT - SCREEN_BOTTOM_MARGIN;

  if (clearance > 0) {
    // scale satisfies: scaled span plus the scaled ink above the first row
    // and below the last fits between the roll and the floor, so blocks
    // shrink in lockstep with spacing.
    scale = Math.max(
      0,
      Math.min(1, (floor - clearance) / (span + ascent + descent)),
    );
    const minAllowedYPos = clearance + ascent * scale;
    const maxAllowedYPos = floor - descent * scale;
    first =
      minAllowedYPos +
      Math.max(0, (maxAllowedYPos - minAllowedYPos - span * scale) / 2);
  } else {
    let last = authored[authored.length - 1];
    if (last - span - ascent < 0) {
      last = floor - descent;
    }
    if (last - span - ascent < 0) {
      scale = floor / (span + ascent + descent);
      last = floor - descent * scale;
    }
    first = last - span * scale;
  }

  authored.forEach((yPos, i) => rows.set(yPos, first + offsets[i] * scale));

  return { scale, rows };
}

// A block's on-screen rect once its row has been placed: getLyricsBlockRect
// at the placed yPos, shrunk about the block's horizontal center and its
// placed yPos by the placement's scale.
export function getPlacedLyricsBlockRect(
  lyricsBlock: TelopBlock,
  annotations: TelopAnnotations,
  placement: TelopRowPlacement,
): TelopRect {
  const yPos = placement.rows.get(lyricsBlock.yPos) ?? lyricsBlock.yPos;
  const rect = getLyricsBlockRect(lyricsBlock, annotations, yPos);
  const { scale } = placement;
  const centerX = rect.left + rect.width / 2;

  return {
    left: centerX - (rect.width / 2) * scale,
    top: yPos + (rect.top - yPos) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

// A telop x within a block (its wipe position, say) mapped through the same
// shrink as getPlacedLyricsBlockRect, so the wipe stays on the glyph it was
// authored for however small the block is drawn.
export function placeLyricsBlockX(
  lyricsBlock: TelopBlock,
  placement: TelopRowPlacement,
  x: number,
): number {
  const centerX =
    lyricsBlock.xPos - TEXT_PADDING + getLyricsBlockWidth(lyricsBlock) / 2;

  return centerX + (x - centerX) * placement.scale;
}

// The part of the telop screen a song's lyrics ever occupy (rows placed as a
// surface with nothing else on it places them), clamped to the screen.
// JOYSOUND's template keeps its rows in the lower 60% of the screen (the
// video shows above), so a surface with no video to show can crop to this and
// spend its pixels on text.
export function getTelopLyricsBounds(layout: TelopLayout): TelopRect {
  const placement = placeTelopRows(layout, 0);

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const block of layout.blocks) {
    // A block the timeline never shows can't widen the crop. That includes
    // one it faded in but never out: its fadeoutTime stays -1, and the draw
    // condition (fadeinTime <= t < fadeoutTime) can then never hold.
    if (block.fadeoutTime <= block.fadeinTime) {
      continue;
    }

    const rect = getPlacedLyricsBlockRect(block, layout.annotations, placement);
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  }

  if (!isFinite(left)) {
    return { left: 0, top: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
  }

  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(SCREEN_WIDTH, right);
  bottom = Math.min(SCREEN_HEIGHT, bottom);

  return { left, top, width: right - left, height: bottom - top };
}

// Where the wipe has reached in a block at telop time `refreshTime`, in telop
// x. Left of it is sung (post colors), right of it isn't (pre colors).
export function getScrollXPos(
  lyricsBlock: TelopBlock,
  refreshTime: number,
): number {
  let xOff = 0;

  // XXX: This is a hack to handle edge cases where romaji text is off frame.
  if (
    lyricsBlock.scrollEvents[0] &&
    refreshTime < lyricsBlock.scrollEvents[0].time
  ) {
    return 0;
  }

  for (let i = 0; i < lyricsBlock.scrollEvents.length; i++) {
    const currScrollEvent = lyricsBlock.scrollEvents[i];

    if (refreshTime < currScrollEvent.time) {
      break;
    }

    let nextScrollEvent = null;

    if (i < lyricsBlock.scrollEvents.length - 1) {
      nextScrollEvent = lyricsBlock.scrollEvents[i + 1];
    }

    if (!nextScrollEvent || refreshTime < nextScrollEvent.time) {
      xOff +=
        (currScrollEvent.speed * (refreshTime - currScrollEvent.time)) / 1000;
    } else {
      xOff +=
        (currScrollEvent.speed *
          (nextScrollEvent.time - currScrollEvent.time)) /
        1000;
    }
  }

  return lyricsBlock.xPos + xOff;
}

// Which break's notice is on screen at telop time `refreshTime`, if any.
export function getActiveBreakNoticeIndex(
  breaks: TelopBreak[],
  refreshTime: number,
): number {
  const activeBreakIndex = breaks.findIndex(
    (b) => refreshTime >= b.startTime * 1000 && refreshTime < b.endTime * 1000,
  );

  if (activeBreakIndex < 0) {
    return -1;
  }

  const noticeStart =
    breaks[activeBreakIndex].startTime * 1000 + BREAK_TEXT_DELAY_MS;

  return refreshTime >= noticeStart &&
    refreshTime < noticeStart + BREAK_TEXT_DURATION_MS
    ? activeBreakIndex
    : -1;
}

function setupTextCanvas(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  lyricsBlock: TelopBlock,
  annotations: TelopAnnotations,
  fillColor: number[],
  strokeColor: number[],
): void {
  textCtx.canvas.width = getLyricsBlockWidth(lyricsBlock) * raster.x;
  textCtx.canvas.height = getLyricsBlockHeight(annotations) * raster.y;
  textCtx.clearRect(0, 0, textCtx.canvas.width, textCtx.canvas.height);

  textCtx.textBaseline = "top";
  textCtx.lineJoin = "round";
  textCtx.fillStyle = `rgb(${fillColor.join(", ")})`;
  textCtx.strokeStyle = `rgb(${strokeColor.join(", ")})`;
}

function setupTitleCanvas(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  height: number = SCREEN_HEIGHT,
): void {
  textCtx.canvas.width = SCREEN_WIDTH * raster.x;
  textCtx.canvas.height = height * raster.y;
  textCtx.clearRect(0, 0, textCtx.canvas.width, textCtx.canvas.height);

  textCtx.textBaseline = "top";
  textCtx.lineJoin = "round";
  textCtx.fillStyle = `rgb(255, 255, 255)`;
  textCtx.strokeStyle = `rgb(8, 8, 8)`;
}

interface TelopTitleRow {
  text: string;
  width: number;
}

function createTitleRows(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  fontStroke: number,
  title: string,
): TelopTitleRow[] {
  const titleRows = [];

  let currTitleText = "";
  let currTitleWidth = 0;

  for (const nextChar of title) {
    const nextTitleWidth = textCtx.measureText(currTitleText + nextChar).width;

    if (
      nextTitleWidth >=
      (SCREEN_WIDTH - (TEXT_PADDING + fontStroke + 16) * 2) * raster.x
    ) {
      titleRows.push({ text: currTitleText, width: currTitleWidth });

      currTitleText = nextChar;
      currTitleWidth = textCtx.measureText(nextChar).width;
    } else {
      currTitleText += nextChar;
      currTitleWidth = nextTitleWidth;
    }
  }

  titleRows.push({ text: currTitleText, width: currTitleWidth });

  return titleRows;
}

function drawTitleRowsToCanvas(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  titleRows: TelopTitleRow[],
  fontSize: number,
  fontStroke: number,
  yPos: number,
) {
  for (const titleRow of titleRows) {
    const titleRowPaddedWidth =
      titleRow.width + (TEXT_PADDING + fontStroke) * raster.x * 2;

    const xPos = Math.max(
      0,
      (SCREEN_WIDTH * raster.x - titleRowPaddedWidth) / 2 / raster.x,
    );

    drawTextToCanvas(
      textCtx,
      raster,
      fontSize,
      fontStroke,
      xPos,
      yPos,
      titleRow.text,
    );

    yPos += fontSize + fontStroke * 2;
  }
}

// Draws the song's opening title card (title, artist, lyricist, composer)
// into textCtx's canvas, resizing it to the whole telop screen.
export function drawTitleCard(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  title: TelopTitle,
  annotations: TelopAnnotations,
): void {
  setupTitleCanvas(textCtx, raster);

  const latinLabels = telopUsesLatinLabels(annotations);

  const titleFontSize =
    title.musicName.length < 48 ? TITLE_FONT_SIZE : ARTIST_FONT_SIZE;
  const titleFontStroke =
    title.musicName.length < 48 ? TITLE_FONT_STROKE : ARTIST_FONT_STROKE;
  textCtx.font = `${titleFontSize * raster.rate}px ${raster.jpFont}`;

  const titleRows = createTitleRows(
    textCtx,
    raster,
    titleFontStroke,
    title.musicName,
  );
  const titleHeight =
    (titleFontSize + TITLE_FONT_STROKE * 2) * titleRows.length * raster.y;

  const artistFontSize =
    title.artistName.length < 64 ? ARTIST_FONT_SIZE : METADATA_FONT_SIZE;
  const artistFontStroke =
    title.artistName.length < 64 ? ARTIST_FONT_STROKE : METADATA_FONT_STROKE;

  textCtx.font = `${artistFontSize * raster.rate}px ${raster.jpFont}`;

  const artistRows = createTitleRows(
    textCtx,
    raster,
    artistFontStroke,
    "♪ " + title.artistName,
  );
  const artistHeight =
    (artistFontSize + ARTIST_FONT_STROKE * 2) * artistRows.length * raster.y;

  textCtx.font = `${METADATA_FONT_SIZE * raster.rate}px ${raster.jpFont}`;

  const lyricistText =
    (latinLabels ? "Lyrics: " : "作詞 ") + title.lyricistName;
  const lyricistMeasure = textCtx.measureText(lyricistText);
  const lyricistHeight =
    lyricistMeasure.actualBoundingBoxAscent +
    lyricistMeasure.actualBoundingBoxDescent;

  const composerText =
    (latinLabels ? "Composer: " : "作曲 ") + title.composerName;
  const composerMeasure = textCtx.measureText(composerText);
  const composerHeight =
    composerMeasure.actualBoundingBoxAscent +
    composerMeasure.actualBoundingBoxDescent;

  const totalHeight =
    titleHeight +
    artistHeight +
    lyricistHeight +
    composerHeight +
    144 * raster.y;

  const titleYPos =
    (SCREEN_HEIGHT * raster.y - totalHeight) / 2 / raster.y - TEXT_PADDING;
  const artistYPos = titleYPos + titleHeight / raster.y + 64;
  const lyricistYPos = artistYPos + artistHeight / raster.y + 64;
  const composerYPos = lyricistYPos + lyricistHeight / raster.y + 16;

  drawTitleRowsToCanvas(
    textCtx,
    raster,
    titleRows,
    titleFontSize,
    TITLE_FONT_STROKE,
    titleYPos,
  );
  drawTitleRowsToCanvas(
    textCtx,
    raster,
    artistRows,
    artistFontSize,
    ARTIST_FONT_STROKE,
    artistYPos,
  );

  drawTextToCanvas(
    textCtx,
    raster,
    METADATA_FONT_SIZE,
    METADATA_FONT_STROKE,
    48 - TEXT_PADDING,
    lyricistYPos,
    lyricistText,
  );

  drawTextToCanvas(
    textCtx,
    raster,
    METADATA_FONT_SIZE,
    METADATA_FONT_STROKE,
    48 - TEXT_PADDING,
    composerYPos,
    composerText,
  );
}

// How much of the telop screen's height the break notice's text occupies,
// from the top of the canvas drawBreakNotice bakes it into.
export const BREAK_NOTICE_HEIGHT =
  BREAK_FONT_SIZE + (BREAK_FONT_STROKE + TEXT_PADDING) * 2;

// Draws the "（間奏　約N秒）" notice into textCtx's canvas, resizing it to the
// whole telop screen. Baked at yPos 0 and horizontally centered; the caller
// shifts it down to wherever the notice belongs on its surface.
export function drawBreakNotice(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  approxDurationSecs: number,
): void {
  setupTitleCanvas(textCtx, raster);
  drawBreakNoticeText(textCtx, raster, approxDurationSecs);
}

// The same notice in a canvas only BREAK_NOTICE_HEIGHT tall. A full-screen
// canvas for one line of text is cheap as a GPU texture on the TV, but a
// fullscreen phone at 3x would pay ~20MB of canvas for it.
export function drawBreakNoticeStrip(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  approxDurationSecs: number,
): void {
  setupTitleCanvas(textCtx, raster, BREAK_NOTICE_HEIGHT);
  drawBreakNoticeText(textCtx, raster, approxDurationSecs);
}

function drawBreakNoticeText(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  approxDurationSecs: number,
): void {
  const text = `（間奏　約${approxDurationSecs}秒）`;
  textCtx.font = `${BREAK_FONT_SIZE * raster.rate}px ${raster.jpFont}`;
  const measure = textCtx.measureText(text);

  const xPos =
    Math.max(0, SCREEN_WIDTH * raster.x - measure.width) / 2 / raster.x -
    BREAK_FONT_STROKE -
    TEXT_PADDING;

  drawTextToCanvas(
    textCtx,
    raster,
    BREAK_FONT_SIZE,
    BREAK_FONT_STROKE,
    xPos,
    0,
    text,
  );
}

// Draws one lyrics block in one color scheme (its pre or its post colors)
// into textCtx's canvas, resizing it to the block's rect (getLyricsBlockRect).
// The wipe is two of these, one clipped either side of getScrollXPos.
export function drawLyricsBlockImage(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  lyricsBlock: TelopBlock,
  fillColor: number[],
  strokeColor: number[],
  annotations: TelopAnnotations,
): void {
  setupTextCanvas(
    textCtx,
    raster,
    lyricsBlock,
    annotations,
    fillColor,
    strokeColor,
  );

  const mainRowTop = getTopGuideHeight(annotations);

  drawMainTextToCanvas(textCtx, raster, lyricsBlock, mainRowTop);
  drawGuideRowToCanvas(textCtx, raster, lyricsBlock, annotations.top, 0);
  drawGuideRowToCanvas(
    textCtx,
    raster,
    lyricsBlock,
    annotations.bottom,
    mainRowTop + MAIN_ROW_HEIGHT + BOTTOM_GUIDE_GAP,
  );
}

// One guide row, whichever kind, with its stroke box's top at `rowTop` (in
// block-canvas telop units, padding excluded). The same furigana or romaji
// positions serve above and below: JOYSOUND's ruby x positions and the
// romaji's source spans are horizontal facts about the main text.
function drawGuideRowToCanvas(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  lyricsBlock: TelopBlock,
  kind: TelopAnnotation,
  rowTop: number,
): void {
  switch (kind) {
    case "FURIGANA":
      drawFuriganaTextToCanvas(textCtx, raster, lyricsBlock, rowTop);
      break;
    case "ROMAJI":
      drawRomajiTextToCanvas(textCtx, raster, lyricsBlock, rowTop);
      break;
    case "NONE":
      break;
  }
}

function getTextOffset(
  textCtx: CanvasRenderingContext2D,
  text: string,
  charWidth: number,
): number {
  const measure = textCtx.measureText(text);

  if (charWidth >= measure.width) {
    return 0;
  }

  if (
    measure.actualBoundingBoxLeft === 0 ||
    measure.actualBoundingBoxRight === 0
  ) {
    return (charWidth - measure.width) / 2;
  }

  const boundingBoxWidth =
    measure.actualBoundingBoxLeft + measure.actualBoundingBoxRight;
  const widthDiff = measure.width - charWidth;
  const halfDiff = widthDiff / 2;

  let leftOverflow = -1 * measure.actualBoundingBoxLeft;
  let rightOverflow = measure.width - measure.actualBoundingBoxRight;

  let isLeftOverflow = false;

  if (leftOverflow >= halfDiff) {
    leftOverflow -= halfDiff;
    isLeftOverflow = true;
  }

  let isRightOverflow = false;

  if (rightOverflow >= halfDiff) {
    rightOverflow -= halfDiff;
    isRightOverflow = true;
  }

  if (isLeftOverflow) {
    if (isRightOverflow) {
      return leftOverflow + measure.actualBoundingBoxLeft;
    } else if (leftOverflow >= halfDiff - rightOverflow) {
      return (
        leftOverflow -
        (halfDiff - rightOverflow) +
        measure.actualBoundingBoxLeft
      );
    }
  } else if (isRightOverflow && rightOverflow >= widthDiff - leftOverflow) {
    return measure.actualBoundingBoxLeft;
  }

  return (charWidth - boundingBoxWidth) / 2 + measure.actualBoundingBoxLeft;
}

function getRomajiTextOffset(
  textCtx: CanvasRenderingContext2D,
  text: string,
  sourceWidth: number,
): number {
  const measure = textCtx.measureText(text);

  return (sourceWidth - measure.width) / 2;
}

function drawTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  fontSize: number,
  fontStroke: number,
  xPos: number,
  yPos: number,
  text: string,
  fontCode: number = 0,
): void {
  textCtx.font = `${fontSize * raster.rate}px ${getFontFace(raster, fontCode)}`;
  textCtx.lineWidth = fontStroke * 2 * raster.rate;

  textCtx.strokeText(
    text,
    (xPos + fontStroke + TEXT_PADDING) * raster.x,
    (yPos + fontStroke + TEXT_PADDING) * raster.y,
  );

  textCtx.fillText(
    text,
    (xPos + fontStroke + TEXT_PADDING) * raster.x,
    (yPos + fontStroke + TEXT_PADDING) * raster.y,
  );
}

function drawMainTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  lyricsBlock: TelopBlock,
  rowTop: number,
): void {
  let currX = 0;

  for (const glyph of lyricsBlock.glyphs) {
    // Measured at the unscaled size, so the centering offset comes out in
    // telop units whatever the raster.
    textCtx.font = `${MAIN_FONT_SIZE}px ${getFontFace(raster, glyph.font)}`;
    textCtx.lineWidth = MAIN_FONT_STROKE * 2;

    const xPos = currX + getTextOffset(textCtx, glyph.text, glyph.width);

    drawTextToCanvas(
      textCtx,
      raster,
      MAIN_FONT_SIZE,
      MAIN_FONT_STROKE,
      xPos,
      rowTop,
      glyph.text,
      glyph.font,
    );

    currX += glyph.width;
  }
}

function drawFuriganaTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  lyricsBlock: TelopBlock,
  rowTop: number,
): void {
  for (const furiganaBlock of lyricsBlock.furigana) {
    let currX = furiganaBlock.xPos;

    for (const unicodeChar of furiganaBlock.chars) {
      drawTextToCanvas(
        textCtx,
        raster,
        RUBY_FONT_SIZE,
        RUBY_FONT_STROKE,
        currX,
        rowTop,
        unicodeChar,
      );

      currX += RUBY_FONT_SIZE + RUBY_FONT_STROKE;
    }
  }
}

function drawRomajiTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  raster: TelopRaster,
  lyricsBlock: TelopBlock,
  rowTop: number,
): void {
  for (const romajiBlock of lyricsBlock.romaji) {
    textCtx.font = `${ROMAJI_FONT_SIZE}px ${getFontFace(raster, 0)}`;
    textCtx.lineWidth = ROMAJI_FONT_STROKE * 2;

    const xPos = romajiBlock.xPos;
    const xOff = getRomajiTextOffset(
      textCtx,
      romajiBlock.phrase,
      romajiBlock.sourceWidth,
    );

    drawTextToCanvas(
      textCtx,
      raster,
      ROMAJI_FONT_SIZE,
      ROMAJI_FONT_STROKE,
      xPos + xOff,
      rowTop,
      romajiBlock.phrase,
    );
  }
}

// Which song a telop layout or a playback clock belongs to: one queue entry,
// not one song, so the same song queued twice in a row can't pick up the
// previous play's lyrics or clock.
export function queueItemKey(item: {
  songId: string;
  timestamp: string;
}): string {
  return `${item.songId}:${item.timestamp}`;
}
