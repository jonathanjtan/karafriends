// JOYSOUND telop lyrics as the big screen lays them out, and the canvas code
// that draws them. Shared by the TV (JoysoundRenderer, which uploads what this
// draws as WebGL textures) and the remocon's lyrics panel (which draws the
// same thing into a 2D canvas), so the phone mirrors the TV glyph for glyph:
// same furigana or romaji, same word segmentation, same colors, same wipe.
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
export const TELOP_LAYOUT_VERSION = 1;

// The virtual screen JOYSOUND authors every telop position in.
export const TELOP_SCREEN_WIDTH = 720;
export const TELOP_SCREEN_HEIGHT = 480;
export const TELOP_TEXT_PADDING = 16;

// Lyrics are drawn this far behind the media clock. Both surfaces must apply
// it, or the phone's wipe runs 200ms ahead of the TV's.
export const TELOP_TIMING_OFFSET_MS = -200;

// XXX: RUBY_FONT_SIZE and RUBY_FONT_STROKE live in src/common/constants.ts for *reasons*

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
// region remapLyricsYPos guarantees lyrics never occupy. Backing vocals can
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
  // Whether the annotation row is romaji rather than furigana. Per queued
  // song, chosen on the remocon when it was queued.
  isRomaji: boolean;
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

export function getLyricsBlockHeight(_lyricsBlock?: TelopBlock): number {
  return (
    MAIN_FONT_SIZE +
    MAIN_FONT_STROKE * 2 +
    RUBY_FONT_SIZE +
    RUBY_FONT_STROKE * 2 +
    TEXT_PADDING * 2
  );
}

// A lyrics block's quad extends above its yPos by the furigana row and below
// it by the main text row; see getLyricsBlockRect and getLyricsBlockHeight.
export const LYRICS_BLOCK_ASCENT =
  RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2 + 8 + TEXT_PADDING;
export const LYRICS_BLOCK_DESCENT =
  MAIN_FONT_SIZE +
  MAIN_FONT_STROKE * 2 +
  RUBY_FONT_SIZE +
  RUBY_FONT_STROKE * 2 +
  TEXT_PADDING * 2 -
  LYRICS_BLOCK_ASCENT;

export interface TelopRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Where a block's rasterized image goes, in telop units, with the block drawn
// at `yPos` (its own, unless the TV has remapped it clear of the piano roll).
// Its texture covers exactly this rect.
export function getLyricsBlockRect(
  lyricsBlock: TelopBlock,
  yPos: number = lyricsBlock.yPos,
): TelopRect {
  return {
    left: lyricsBlock.xPos - TEXT_PADDING,
    top: yPos - (RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2) - 8 - TEXT_PADDING,
    width: getLyricsBlockWidth(lyricsBlock),
    height: getLyricsBlockHeight(lyricsBlock),
  };
}

// The part of the telop screen a song's lyrics ever occupy, clamped to the
// screen. JOYSOUND's template keeps its rows in the lower 60% of the screen
// (the video shows above), so a surface with no video to show can crop to
// this and spend its pixels on text.
export function getTelopLyricsBounds(layout: TelopLayout): TelopRect {
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

    const rect = getLyricsBlockRect(block);
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
  fillColor: number[],
  strokeColor: number[],
): void {
  textCtx.canvas.width = getLyricsBlockWidth(lyricsBlock) * raster.x;
  textCtx.canvas.height = getLyricsBlockHeight(lyricsBlock) * raster.y;
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
  isRomaji: boolean,
): void {
  setupTitleCanvas(textCtx, raster);

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

  const lyricistText = (isRomaji ? "Lyrics: " : "作詞 ") + title.lyricistName;
  const lyricistMeasure = textCtx.measureText(lyricistText);
  const lyricistHeight =
    lyricistMeasure.actualBoundingBoxAscent +
    lyricistMeasure.actualBoundingBoxDescent;

  const composerText = (isRomaji ? "Composer: " : "作曲 ") + title.composerName;
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
  isRomaji: boolean,
): void {
  setupTextCanvas(textCtx, raster, lyricsBlock, fillColor, strokeColor);

  drawMainTextToCanvas(textCtx, raster, lyricsBlock);

  if (isRomaji) {
    drawRomajiTextToCanvas(textCtx, raster, lyricsBlock);
  } else {
    drawFuriganaTextToCanvas(textCtx, raster, lyricsBlock);
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
      RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2,
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
        0,
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
      0,
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
