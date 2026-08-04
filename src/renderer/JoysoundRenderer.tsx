import M from "materialize-css";
import React, { useEffect, useRef } from "react";
import invariant from "ts-invariant";

import "./JoysoundRenderer.css";

import parseJoysoundData, {
  decodeJoysoundText,
  JoysoundLyricsBlock,
  JoysoundMetadata,
  JoysoundTelopData,
  KuroshiroSingleton,
} from "../common/joysoundParser";

import {
  PIANO_ROLL_LOOKAHEAD_SECS,
  PIANO_ROLL_TOP_FRACTION,
  RUBY_FONT_SIZE,
  RUBY_FONT_STROKE,
} from "../common/constants";
import useJoysoundRomajiWordSegmentation from "../common/hooks/useJoysoundRomajiWordSegmentation";
import usePianoRollSize from "../common/hooks/usePianoRollSize";
import { InstrumentalBreak } from "../common/scoringData";

// XXX: These should be in their own file

const vsSource = `#version 300 es
  in vec2 a_position;
  in vec2 a_texCoord;
  in float a_scroll;
  in float a_scrollType;

  uniform vec2 u_resolution;

  out vec2 v_texCoord;
  out vec2 v_position;
  out float v_scroll;
  out float v_scrollType;

  void main() {
    vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);

    v_texCoord = a_texCoord;
    v_position = a_position;
    v_scroll = a_scroll;
    v_scrollType = a_scrollType;
  }
`;

const fsSource = `#version 300 es
  precision highp float;

  uniform sampler2D u_image;

  in vec2 v_texCoord;
  in vec2 v_position;
  in float v_scroll;
  in float v_scrollType;

  out vec4 outColor;

  void main() {
    vec4 textureColor = texture(u_image, v_texCoord);

    if (
      (v_scrollType == 0.0 && v_position.x <= v_scroll) ||
      (v_scrollType == 1.0 && v_position.x > v_scroll)
    ) {
      outColor = vec4(0.0, 0.0, 0.0, 0.0);
    } else {
      outColor = vec4(textureColor.r, textureColor.g, textureColor.b, textureColor.a);
    }
  }
`;

// XXX: Move these to some setting somewhere?
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

const BREAK_FONT_SIZE = 32;
const BREAK_FONT_STROKE = 3;
// Where the "（間奏　約N秒）" notice goes when the piano roll is hidden:
// JOYSOUND's own bottom-of-screen subtitle position. With the roll visible
// the notice is instead centered in the (ducked) roll's band, the one region
// remapLyricsYPos guarantees lyrics never occupy — backing vocals can keep
// singing through a guide-melody gap, and the bottom position collided with
// their telop.
const BREAK_Y_FRACTION = 0.82;
// The notice pops in a beat after the break starts and doesn't need to
// stay up for the whole break; the piano roll stays ducked regardless.
const BREAK_TEXT_DELAY_MS = 500;
const BREAK_TEXT_DURATION_MS = 5000;

const SCREEN_WIDTH = 720;
const SCREEN_HEIGHT = 480;
const TEXT_PADDING = 16;

let EXPAND_RATE = 1.0;
let EXPAND_RATE_X = 1.0;
let EXPAND_RATE_Y = 1.0;

const TIMING_OFFSET = -200;

const JP_FONT_FACE = "notoSerifJP";
const KR_FONT_FACE = "notoSerifKR";

interface LyricsBlockTextures {
  preTexture: WebGLTexture;
  postTexture: WebGLTexture;
}

interface JoysoundTitleRow {
  text: string;
  width: number;
}

interface JoysoundDisplayBuffers {
  position: WebGLBuffer;
  texCoord: WebGLBuffer;
  scroll: WebGLBuffer;
  scrollType: WebGLBuffer;
}

function getFontFace(fontCode: number): string {
  switch (fontCode) {
    case 0:
      return JP_FONT_FACE;
      break;
    case 1:
      return KR_FONT_FACE;
      break;
    default:
      return JP_FONT_FACE;
  }
}

function createShader(
  gl: WebGL2RenderingContext,
  type:
    | WebGLRenderingContextBase["VERTEX_SHADER"]
    | WebGLRenderingContextBase["FRAGMENT_SHADER"],
  source: string,
) {
  const shader = gl.createShader(type);
  invariant(shader);

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader,
) {
  const program = gl.createProgram();
  invariant(program);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  return program;
}

function quadToTriangles(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  return [x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1];
}

function createTextureFromImage(
  gl: WebGL2RenderingContext,
  bitmap: HTMLCanvasElement,
): WebGLTexture {
  const texture = gl.createTexture();
  invariant(texture);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // LINEAR, not NEAREST: lyrics quads are drawn below 1:1 scale when the
  // piano roll compresses the rows, and NEAREST minification aliases the
  // glyph outlines into crunchy stairsteps.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

  return texture;
}

function getLyricsBlockWidth(lyricsBlock: JoysoundLyricsBlock): number {
  const mainBlockWidth = lyricsBlock.chars.reduce(
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

function getLyricsBlockHeight(lyricsBlock: JoysoundLyricsBlock): number {
  return (
    MAIN_FONT_SIZE +
    MAIN_FONT_STROKE * 2 +
    RUBY_FONT_SIZE +
    RUBY_FONT_STROKE * 2 +
    TEXT_PADDING * 2
  );
}

function setupTextCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
  fillColor: number[],
  strokeColor: number[],
): void {
  textCtx.canvas.width = getLyricsBlockWidth(lyricsBlock) * EXPAND_RATE_X;
  textCtx.canvas.height = getLyricsBlockHeight(lyricsBlock) * EXPAND_RATE_Y;
  textCtx.clearRect(0, 0, textCtx.canvas.width, textCtx.canvas.height);

  textCtx.textBaseline = "top";
  textCtx.lineJoin = "round";
  textCtx.fillStyle = `rgb(${fillColor.join(", ")})`;
  textCtx.strokeStyle = `rgb(${strokeColor.join(", ")})`;
}

function setupTitleCanvas(textCtx: CanvasRenderingContext2D): void {
  textCtx.canvas.width = SCREEN_WIDTH * EXPAND_RATE_X;
  textCtx.canvas.height = SCREEN_HEIGHT * EXPAND_RATE_Y;
  textCtx.clearRect(0, 0, textCtx.canvas.width, textCtx.canvas.height);

  textCtx.textBaseline = "top";
  textCtx.lineJoin = "round";
  textCtx.fillStyle = `rgb(255, 255, 255)`;
  textCtx.strokeStyle = `rgb(8, 8, 8)`;
}

function createTitleRows(
  textCtx: CanvasRenderingContext2D,
  fontStroke: number,
  title: string,
): JoysoundTitleRow[] {
  const titleRows = [];

  let currTitleText = "";
  let currTitleWidth = 0;

  for (const nextChar of title) {
    const nextTitleWidth = textCtx.measureText(currTitleText + nextChar).width;

    if (
      nextTitleWidth >=
      (SCREEN_WIDTH - (TEXT_PADDING + fontStroke + 16) * 2) * EXPAND_RATE_X
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
  titleRows: JoysoundTitleRow[],
  fontSize: number,
  fontStroke: number,
  yPos: number,
) {
  for (const titleRow of titleRows) {
    const titleRowPaddedWidth =
      titleRow.width + (TEXT_PADDING + fontStroke) * EXPAND_RATE_X * 2;

    const xPos = Math.max(
      0,
      (SCREEN_WIDTH * EXPAND_RATE_X - titleRowPaddedWidth) / 2 / EXPAND_RATE_X,
    );

    drawTextToCanvas(textCtx, fontSize, fontStroke, xPos, yPos, titleRow.text);

    yPos += fontSize + fontStroke * 2;
  }
}

function createTitleTexture(
  gl: WebGL2RenderingContext,
  metadata: JoysoundMetadata,
  isRomaji: boolean,
): WebGLTexture {
  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  setupTitleCanvas(textCtx);

  const titleFontSize =
    metadata.musicName.length < 48 ? TITLE_FONT_SIZE : ARTIST_FONT_SIZE;
  const titleFontStroke =
    metadata.musicName.length < 48 ? TITLE_FONT_STROKE : ARTIST_FONT_STROKE;
  textCtx.font = `${titleFontSize * EXPAND_RATE}px ${JP_FONT_FACE}`;

  const titleRows = createTitleRows(
    textCtx,
    titleFontStroke,
    metadata.musicName,
  );
  const titleHeight =
    (titleFontSize + TITLE_FONT_STROKE * 2) * titleRows.length * EXPAND_RATE_Y;

  const artistFontSize =
    metadata.artistName.length < 64 ? ARTIST_FONT_SIZE : METADATA_FONT_SIZE;
  const artistFontStroke =
    metadata.artistName.length < 64 ? ARTIST_FONT_STROKE : METADATA_FONT_STROKE;

  textCtx.font = `${artistFontSize * EXPAND_RATE}px ${JP_FONT_FACE}`;

  const artistRows = createTitleRows(
    textCtx,
    artistFontStroke,
    "♪ " + metadata.artistName,
  );
  const artistHeight =
    (artistFontSize + ARTIST_FONT_STROKE * 2) *
    artistRows.length *
    EXPAND_RATE_Y;

  textCtx.font = `${METADATA_FONT_SIZE * EXPAND_RATE}px ${JP_FONT_FACE}`;

  const lyricistText =
    (isRomaji ? "Lyrics: " : "作詞 ") + metadata.lyricistName;
  const lyricistMeasure = textCtx.measureText(lyricistText);
  const lyricistHeight =
    lyricistMeasure.actualBoundingBoxAscent +
    lyricistMeasure.actualBoundingBoxDescent;

  const composerText =
    (isRomaji ? "Composer: " : "作曲 ") + metadata.composerName;
  const composerMeasure = textCtx.measureText(composerText);
  const composerHeight =
    composerMeasure.actualBoundingBoxAscent +
    composerMeasure.actualBoundingBoxDescent;

  const totalHeight =
    titleHeight +
    artistHeight +
    lyricistHeight +
    composerHeight +
    144 * EXPAND_RATE_Y;

  const titleYPos =
    (SCREEN_HEIGHT * EXPAND_RATE_Y - totalHeight) / 2 / EXPAND_RATE_Y -
    TEXT_PADDING;
  const artistYPos = titleYPos + titleHeight / EXPAND_RATE_Y + 64;
  const lyricistYPos = artistYPos + artistHeight / EXPAND_RATE_Y + 64;
  const composerYPos = lyricistYPos + lyricistHeight / EXPAND_RATE_Y + 16;

  drawTitleRowsToCanvas(
    textCtx,
    titleRows,
    titleFontSize,
    TITLE_FONT_STROKE,
    titleYPos,
  );
  drawTitleRowsToCanvas(
    textCtx,
    artistRows,
    artistFontSize,
    ARTIST_FONT_STROKE,
    artistYPos,
  );

  drawTextToCanvas(
    textCtx,
    METADATA_FONT_SIZE,
    METADATA_FONT_STROKE,
    48 - TEXT_PADDING,
    lyricistYPos,
    lyricistText,
  );

  drawTextToCanvas(
    textCtx,
    METADATA_FONT_SIZE,
    METADATA_FONT_STROKE,
    48 - TEXT_PADDING,
    composerYPos,
    composerText,
  );

  const result = createTextureFromImage(gl, textCtx.canvas);

  textCtx.canvas.remove();

  return result;
}

function createBreakTexture(
  gl: WebGL2RenderingContext,
  approxDurationSecs: number,
): WebGLTexture {
  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  setupTitleCanvas(textCtx);

  const text = `（間奏　約${approxDurationSecs}秒）`;
  textCtx.font = `${BREAK_FONT_SIZE * EXPAND_RATE}px ${JP_FONT_FACE}`;
  const measure = textCtx.measureText(text);

  const xPos =
    Math.max(0, SCREEN_WIDTH * EXPAND_RATE_X - measure.width) /
      2 /
      EXPAND_RATE_X -
    BREAK_FONT_STROKE -
    TEXT_PADDING;

  // Baked at yPos 0; the draw call shifts the quad to the live vertical
  // position (the piano roll band's center, which tracks the synced
  // pianoRollSize mid-song, or the bottom fallback).
  drawTextToCanvas(textCtx, BREAK_FONT_SIZE, BREAK_FONT_STROKE, xPos, 0, text);

  const result = createTextureFromImage(gl, textCtx.canvas);

  textCtx.canvas.remove();

  return result;
}

function createLyricsBlockTexture(
  gl: WebGL2RenderingContext,
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
  fillColor: number[],
  strokeColor: number[],
  isRomaji: boolean,
): WebGLTexture {
  setupTextCanvas(textCtx, lyricsBlock, fillColor, strokeColor);

  drawMainTextToCanvas(textCtx, lyricsBlock);

  if (isRomaji) {
    drawRomajiTextToCanvas(textCtx, lyricsBlock);
  } else {
    drawFuriganaTextToCanvas(textCtx, lyricsBlock);
  }

  return createTextureFromImage(gl, textCtx.canvas);
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
  fontSize: number,
  fontStroke: number,
  xPos: number,
  yPos: number,
  text: string,
  fontCode: number = 0,
): void {
  textCtx.font = `${fontSize * EXPAND_RATE}px ${getFontFace(fontCode)}`;
  textCtx.lineWidth = fontStroke * 2 * EXPAND_RATE;

  textCtx.strokeText(
    text,
    (xPos + fontStroke + TEXT_PADDING) * EXPAND_RATE_X,
    (yPos + fontStroke + TEXT_PADDING) * EXPAND_RATE_Y,
  );

  textCtx.fillText(
    text,
    (xPos + fontStroke + TEXT_PADDING) * EXPAND_RATE_X,
    (yPos + fontStroke + TEXT_PADDING) * EXPAND_RATE_Y,
  );
}

function drawMainTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
): void {
  let currX = 0;

  for (const glyphChar of lyricsBlock.chars) {
    const text = decodeJoysoundText(
      glyphChar.charCode,
      glyphChar.font,
      lyricsBlock.flags,
    );

    textCtx.font = `${MAIN_FONT_SIZE}px ${getFontFace(glyphChar.font)}`;
    textCtx.lineWidth = MAIN_FONT_STROKE * 2;

    const xPos = currX + getTextOffset(textCtx, text, glyphChar.width);

    drawTextToCanvas(
      textCtx,
      MAIN_FONT_SIZE,
      MAIN_FONT_STROKE,
      xPos,
      RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2,
      text,
      glyphChar.font,
    );

    currX += glyphChar.width;
  }
}

function drawFuriganaTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: JoysoundLyricsBlock,
): void {
  for (const furiganaBlock of lyricsBlock.furigana) {
    let currX = furiganaBlock.xPos;

    for (const charCode of furiganaBlock.chars) {
      const unicodeChar = decodeJoysoundText(charCode);

      drawTextToCanvas(
        textCtx,
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
  lyricsBlock: JoysoundLyricsBlock,
): void {
  const sortedRomaji = lyricsBlock.romaji.sort((a, b) => a.xPos - b.xPos);

  for (const romajiBlock of sortedRomaji) {
    textCtx.font = `${ROMAJI_FONT_SIZE}px ${getFontFace(0)}`;
    textCtx.lineWidth = ROMAJI_FONT_STROKE * 2;

    const xPos = romajiBlock.xPos;
    const xOff = getRomajiTextOffset(
      textCtx,
      romajiBlock.phrase,
      romajiBlock.sourceWidth,
    );

    drawTextToCanvas(
      textCtx,
      ROMAJI_FONT_SIZE,
      ROMAJI_FONT_STROKE,
      xPos + xOff,
      0,
      romajiBlock.phrase,
    );
  }
}

function createLyricsBlockTextures(
  gl: WebGL2RenderingContext,
  lyricsData: JoysoundLyricsBlock[],
  isRomaji: boolean,
): LyricsBlockTextures[] {
  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  const lyricsBlockTextures = [];

  for (const lyricsBlock of lyricsData) {
    const preTexture = createLyricsBlockTexture(
      gl,
      textCtx,
      lyricsBlock,
      lyricsBlock.preFill.rgb,
      lyricsBlock.preBorder.rgb,
      isRomaji,
    );

    const postTexture = createLyricsBlockTexture(
      gl,
      textCtx,
      lyricsBlock,
      lyricsBlock.postFill.rgb,
      lyricsBlock.postBorder.rgb,
      isRomaji,
    );

    lyricsBlockTextures.push({ preTexture, postTexture });
  }

  textCtx.canvas.remove();

  return lyricsBlockTextures;
}

function getScrollXPos(
  lyricsBlock: JoysoundLyricsBlock,
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

// yOffset (in canvas pixels) shifts the whole texture down, letting content
// baked at yPos 0 be positioned at draw time (see createBreakTexture).
function drawTitle(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  titleTexture: WebGLTexture,
  yOffset: number = 0,
): void {
  const scrollArray = new Float32Array(Array(6).fill(0));

  const positions = quadToTriangles(
    0,
    yOffset,
    SCREEN_WIDTH * EXPAND_RATE_X,
    SCREEN_HEIGHT * EXPAND_RATE_Y + yOffset,
  );

  drawLyricsTexture(gl, glBuffers, titleTexture, positions, scrollArray, false);
}

function drawLyricsTexture(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  texture: WebGLTexture,
  positions: number[],
  scrollArray: Float32Array,
  isPostTexture: boolean,
) {
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.scroll);
  gl.bufferData(gl.ARRAY_BUFFER, scrollArray, gl.STATIC_DRAW);

  const scrollTypeArray = new Float32Array(
    Array(6).fill(isPostTexture ? 1.0 : 0.0),
  );

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.scrollType);
  gl.bufferData(gl.ARRAY_BUFFER, scrollTypeArray, gl.STATIC_DRAW);

  const texCoordArray = new Float32Array(quadToTriangles(0.0, 0.0, 1.0, 1.0));

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.texCoord);
  gl.bufferData(gl.ARRAY_BUFFER, texCoordArray, gl.STATIC_DRAW);

  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  gl.drawArrays(gl.TRIANGLES, 0, positions.length / 2);
}

// A lyrics block's quad extends above its yPos by the furigana row and below
// it by the main text row; see drawLyricsBlock and getLyricsBlockHeight.
const LYRICS_BLOCK_ASCENT =
  RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2 + 8 + TEXT_PADDING;
const LYRICS_BLOCK_DESCENT =
  MAIN_FONT_SIZE +
  MAIN_FONT_STROKE * 2 +
  RUBY_FONT_SIZE +
  RUBY_FONT_STROKE * 2 +
  TEXT_PADDING * 2 -
  LYRICS_BLOCK_ASCENT;

// Keeps lyrics rows from hiding behind the piano roll: while the roll is on
// screen, the whole set of rows is centered vertically in the space between
// the roll's bottom edge and the bottom of the screen (so lyrics don't hug
// the bottom of the screen as the roll grows). When that space can't fit the
// original layout, the returned scale shrinks the row spacing AND the drawn
// block size by the same factor — compressing spacing alone let a squeezed
// row's furigana overlap the main text of the row above it at piano roll
// sizes M/L. With no piano roll on screen (clearance 0) this is an exact
// no-op.
function remapLyricsYPos(
  yPos: number,
  minYPos: number,
  maxYPos: number,
  pianoRollClearance: number,
): { yPos: number; scale: number } {
  if (pianoRollClearance <= 0) {
    return { yPos, scale: 1 };
  }

  // scale satisfies: scaled span + scaled ascent + scaled descent fits in
  // the space below the roll, so blocks shrink in lockstep with spacing.
  const scale = Math.max(
    0,
    Math.min(
      1,
      (SCREEN_HEIGHT - pianoRollClearance) /
        (maxYPos - minYPos + LYRICS_BLOCK_ASCENT + LYRICS_BLOCK_DESCENT),
    ),
  );
  const minAllowedYPos = pianoRollClearance + LYRICS_BLOCK_ASCENT * scale;
  const maxAllowedYPos = SCREEN_HEIGHT - LYRICS_BLOCK_DESCENT * scale;
  const spanHeight = (maxYPos - minYPos) * scale;
  const centeredMinYPos =
    minAllowedYPos +
    Math.max(0, (maxAllowedYPos - minAllowedYPos - spanHeight) / 2);

  return { yPos: centeredMinYPos + (yPos - minYPos) * scale, scale };
}

function drawLyricsBlock(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  lyricsBlock: JoysoundLyricsBlock,
  lyricsBlockTextures: LyricsBlockTextures[],
  index: number,
  refreshTime: number,
  yPos: number,
  scale: number,
) {
  const scrollXPos = Math.floor(getScrollXPos(lyricsBlock, refreshTime));

  const currX = lyricsBlock.xPos;
  const currY = yPos - (RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2) - 8;

  const rectWidth = getLyricsBlockWidth(lyricsBlock);
  const rectHeight = getLyricsBlockHeight(lyricsBlock);

  // Shrink the block around its own center-x / yPos when remapLyricsYPos
  // compressed the rows, keeping the wipe boundary (scroll) in the same
  // transformed space as the quad so highlight timing stays glyph-accurate.
  const anchorX = currX + rectWidth / 2 - TEXT_PADDING;
  const toScreenX = (x: number) =>
    (anchorX + (x - anchorX) * scale) * EXPAND_RATE_X;
  const toScreenY = (y: number) => (yPos + (y - yPos) * scale) * EXPAND_RATE_Y;

  const scrollArray = new Float32Array(Array(6).fill(toScreenX(scrollXPos)));

  const positions = quadToTriangles(
    toScreenX(currX - TEXT_PADDING),
    toScreenY(currY - TEXT_PADDING),
    toScreenX(currX + rectWidth - TEXT_PADDING),
    toScreenY(currY + rectHeight - TEXT_PADDING),
  );

  if (scrollXPos <= currX + rectWidth) {
    drawLyricsTexture(
      gl,
      glBuffers,
      lyricsBlockTextures[index].preTexture,
      positions,
      scrollArray,
      false,
    );
  }

  if (scrollXPos >= currX) {
    drawLyricsTexture(
      gl,
      glBuffers,
      lyricsBlockTextures[index].postTexture,
      positions,
      scrollArray,
      true,
    );
  }
}

export default function JoysoundRenderer(props: {
  telop: ArrayBuffer;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  kuroshiro: KuroshiroSingleton;
  isRomaji: boolean;
  pianoRollVisible: boolean;
  onTitleFadeout?: () => void;
  breaks: InstrumentalBreak[];
  onBreakActiveChange?: (active: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // In telop coordinates, the y below which lyrics rows must stay so they
  // don't hide behind the piano roll. Held in a ref so the draw loop (which
  // lives inside a one-shot effect) always sees the live synced size.
  const { pianoRollSize } = usePianoRollSize();
  const { joysoundRomajiWordSegmentation } =
    useJoysoundRomajiWordSegmentation();
  const pianoRollClearanceRef = useRef(0);
  pianoRollClearanceRef.current =
    props.pianoRollVisible && pianoRollSize > 0
      ? (PIANO_ROLL_TOP_FRACTION + pianoRollSize) * SCREEN_HEIGHT + 8
      : 0;

  // Vertical position (telop coordinates, drawTextToCanvas semantics) for
  // the break notice: centered in the ducked piano roll's band — the region
  // lyrics are remapped to clear, so the notice can't overlap them — or the
  // classic bottom-of-screen spot when there's no roll on screen.
  const breakNoticeYPosRef = useRef(SCREEN_HEIGHT * BREAK_Y_FRACTION);
  breakNoticeYPosRef.current =
    props.pianoRollVisible && pianoRollSize > 0
      ? (PIANO_ROLL_TOP_FRACTION + pianoRollSize / 2) * SCREEN_HEIGHT -
        BREAK_FONT_SIZE / 2 -
        BREAK_FONT_STROKE -
        TEXT_PADDING
      : SCREEN_HEIGHT * BREAK_Y_FRACTION;

  const updateSize = () => {
    const canvasElement = canvasRef.current;
    invariant(canvasElement);

    canvasElement.width = canvasElement.clientWidth * window.devicePixelRatio;
    canvasElement.height = canvasElement.clientHeight * window.devicePixelRatio;

    // XXX: Global variables but it works
    EXPAND_RATE = Math.min(
      canvasElement.width / SCREEN_WIDTH,
      canvasElement.height / SCREEN_HEIGHT,
    );

    EXPAND_RATE_X = canvasElement.width / SCREEN_WIDTH;
    EXPAND_RATE_Y = canvasElement.height / SCREEN_HEIGHT;

    const gl = canvasElement.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: false,
    });

    invariant(gl);
    gl.viewport(0, 0, canvasElement.width, canvasElement.height);
  };

  useEffect(() => {
    // Guards the draw loop against outliving this effect instance. The
    // cleanup's cancelAnimationFrame alone isn't enough: refresh() is async,
    // so a teardown that fires while parseJoysoundData is still pending
    // (StrictMode's double-mount does this on every mount) has no frame to
    // cancel yet, and the loop it would later start became an uncancellable
    // zombie — still firing onBreakActiveChange with a stale song's breaks.
    let cancelled = false;
    let animationFrameRequest = 0;

    const refresh = async () => {
      updateSize();
      window.addEventListener("resize", updateSize);

      // Yeah we parse the data on each re-render, ffuck it
      //
      // A parse failure here must not throw out of refresh(): by the time
      // this effect runs, the previous effect instance's draw loop is already
      // cancelled, so bailing would freeze the canvas on its last-drawn frame
      // — typically the PREVIOUS song's title card — for the entire song (the
      // EZ Romaji 6969-sentinel crash did exactly this). Degrade stepwise
      // instead: retry without word segmentation, then without romaji at all;
      // only if even the plain parse fails do we give up, and then we clear
      // the canvas so the room sees the bare MV rather than stale telop.
      const parseAttempts = [
        {
          wordSegmentation: joysoundRomajiWordSegmentation,
          skipRomaji: false,
        },
        ...(joysoundRomajiWordSegmentation
          ? [{ wordSegmentation: false, skipRomaji: false }]
          : []),
        { wordSegmentation: false, skipRomaji: true },
      ];

      let joysoundData: JoysoundTelopData | null = null;
      let parseError: unknown = null;

      for (const { wordSegmentation, skipRomaji } of parseAttempts) {
        try {
          joysoundData = await parseJoysoundData(
            props.telop,
            props.kuroshiro,
            wordSegmentation,
            skipRomaji,
          );
        } catch (e) {
          parseError = e;
          console.error(
            `parseJoysoundData failed (wordSegmentation=${wordSegmentation}, skipRomaji=${skipRomaji})`,
            e,
          );
        }
        if (cancelled) {
          return;
        }
        if (joysoundData !== null) {
          break;
        }
      }

      if (joysoundData === null) {
        console.error("All parseJoysoundData attempts failed", parseError);
        M.toast({
          html: "<span>⚠️ Lyrics failed to render for this song</span>",
        });

        // Wipe the previous song's last frame off the canvas, and release
        // the piano roll (it waits on the title card fading out, which will
        // never happen now).
        const staleGl = canvasRef.current?.getContext("webgl2", {
          antialias: false,
          premultipliedAlpha: false,
        });
        if (staleGl) {
          staleGl.clearColor(0, 0, 0, 0);
          staleGl.clear(staleGl.COLOR_BUFFER_BIT);
        }
        props.onTitleFadeout?.();
        return;
      }

      const metadata = joysoundData.metadata;
      const lyricsData = joysoundData.lyrics;
      const timeline = joysoundData.timeline;

      const lyricYPositions = lyricsData.map((block) => block.yPos);
      const minLyricYPos = Math.min(...lyricYPositions);
      const maxLyricYPos = Math.max(...lyricYPositions);

      invariant(canvasRef.current);
      const gl = canvasRef.current.getContext("webgl2", {
        antialias: false,
        premultipliedAlpha: false,
      });
      invariant(gl);

      // Reported once the title card stops drawing, so callers (e.g. the
      // piano roll) can fade in without covering it.
      let titleFadedOutReported = false;
      // Edge-triggered: only fires onBreakActiveChange when crossing into
      // or out of a duck window, not every frame. Starts null so the first
      // frame always reports, re-syncing the parent if a previous effect
      // instance left it ducked.
      let isPianoRollDucked: boolean | null = null;

      const titleTexture = createTitleTexture(gl, metadata, props.isRomaji);
      const lyricsBlockTextures = createLyricsBlockTextures(
        gl,
        lyricsData,
        props.isRomaji,
      );
      const breakTextures = props.breaks.map((b) =>
        createBreakTexture(gl, b.approxDurationSecs),
      );

      const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
      const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);

      const program = createProgram(gl, vertexShader, fragmentShader);

      const positionAttributeLocation = gl.getAttribLocation(
        program,
        "a_position",
      );
      const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");
      const scrollLocation = gl.getAttribLocation(program, "a_scroll");
      const scrollTypeLocation = gl.getAttribLocation(program, "a_scrollType");
      const resolutionUniformLocation = gl.getUniformLocation(
        program,
        "u_resolution",
      );

      const positionBuffer = gl.createBuffer();
      const texCoordBuffer = gl.createBuffer();
      const scrollBuffer = gl.createBuffer();
      const scrollTypeBuffer = gl.createBuffer();

      invariant(positionBuffer);
      invariant(texCoordBuffer);
      invariant(scrollBuffer);
      invariant(scrollTypeBuffer);

      const glBuffers: JoysoundDisplayBuffers = {
        position: positionBuffer,
        texCoord: texCoordBuffer,
        scroll: scrollBuffer,
        scrollType: scrollTypeBuffer,
      };

      function draw(now: number) {
        if (cancelled) {
          return;
        }
        invariant(gl);
        invariant(props.videoRef.current);

        const refreshTime =
          props.videoRef.current.currentTime * 1000 + TIMING_OFFSET;
        invariant(refreshTime);

        gl.clearColor(0.0, 0.0, 0.0, 0.2);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
          gl.SRC_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA,
        );

        gl.useProgram(program);

        gl.enableVertexAttribArray(positionAttributeLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.vertexAttribPointer(
          positionAttributeLocation,
          2,
          gl.FLOAT,
          false,
          0,
          0,
        );

        gl.enableVertexAttribArray(texCoordLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

        gl.enableVertexAttribArray(scrollLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, scrollBuffer);
        gl.vertexAttribPointer(scrollLocation, 1, gl.FLOAT, false, 0, 0);

        gl.enableVertexAttribArray(scrollTypeLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, scrollTypeBuffer);
        gl.vertexAttribPointer(scrollTypeLocation, 1, gl.FLOAT, false, 0, 0);

        gl.uniform2f(
          resolutionUniformLocation,
          gl.canvas.width,
          gl.canvas.height,
        );

        if (refreshTime < metadata.fadeoutTime) {
          drawTitle(gl, glBuffers, titleTexture);
        } else if (!titleFadedOutReported) {
          titleFadedOutReported = true;
          props.onTitleFadeout?.();
        }

        for (let i = 0; i < lyricsData.length; i++) {
          const lyricsBlock = lyricsData[i];

          if (
            refreshTime >= lyricsBlock.fadeinTime &&
            refreshTime < lyricsBlock.fadeoutTime
          ) {
            const { yPos: remappedYPos, scale: lyricsScale } = remapLyricsYPos(
              lyricsBlock.yPos,
              minLyricYPos,
              maxLyricYPos,
              pianoRollClearanceRef.current,
            );

            drawLyricsBlock(
              gl,
              glBuffers,
              lyricsBlock,
              lyricsBlockTextures,
              i,
              refreshTime,
              remappedYPos,
              lyricsScale,
            );
          }
        }

        const activeBreakIndex = props.breaks.findIndex(
          (b) =>
            refreshTime >= b.startTime * 1000 && refreshTime < b.endTime * 1000,
        );

        if (activeBreakIndex >= 0) {
          const noticeStart =
            props.breaks[activeBreakIndex].startTime * 1000 +
            BREAK_TEXT_DELAY_MS;

          if (
            refreshTime >= noticeStart &&
            refreshTime < noticeStart + BREAK_TEXT_DURATION_MS
          ) {
            drawTitle(
              gl,
              glBuffers,
              breakTextures[activeBreakIndex],
              breakNoticeYPosRef.current * EXPAND_RATE_Y,
            );
          }
        }

        // Un-duck before the break's literal end: notes for the next phrase
        // start scrolling into the piano roll's visible window
        // PIANO_ROLL_LOOKAHEAD_SECS ahead of when they're actually due, so
        // the roll should already be back by then, not still fading in.
        const duckedBreakIndex = props.breaks.findIndex(
          (b) =>
            refreshTime >= b.startTime * 1000 &&
            refreshTime < b.endTime * 1000 - PIANO_ROLL_LOOKAHEAD_SECS * 1000,
        );

        if (duckedBreakIndex >= 0 !== isPianoRollDucked) {
          isPianoRollDucked = duckedBreakIndex >= 0;
          props.onBreakActiveChange?.(isPianoRollDucked);
        }

        animationFrameRequest = window.requestAnimationFrame(draw);
      }

      animationFrameRequest = window.requestAnimationFrame(draw);
    };

    refresh().catch(console.error);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", updateSize);
      window.cancelAnimationFrame(animationFrameRequest);
    };
  }, [props.telop, props.isRomaji, joysoundRomajiWordSegmentation]);

  return <canvas ref={canvasRef} className="joysoundDisplay"></canvas>;
}
