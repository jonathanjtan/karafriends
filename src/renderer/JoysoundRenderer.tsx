import M from "materialize-css";
import React, { useEffect, useRef } from "react";
import invariant from "ts-invariant";

import "./JoysoundRenderer.css";

import parseJoysoundData, {
  JoysoundTelopData,
  KuroshiroSingleton,
  toTelopLayout,
} from "../common/joysoundParser";

import {
  PIANO_ROLL_LOOKAHEAD_SECS,
  PIANO_ROLL_TOP_FRACTION,
} from "../common/constants";
import useJoysoundBottomAnnotation from "../common/hooks/useJoysoundBottomAnnotation";
import useJoysoundRomajiWordSegmentation from "../common/hooks/useJoysoundRomajiWordSegmentation";
import useJoysoundTopAnnotation from "../common/hooks/useJoysoundTopAnnotation";
import usePianoRollSize from "../common/hooks/usePianoRollSize";
import { InstrumentalBreak } from "../common/scoringData";
import {
  BREAK_FONT_SIZE,
  BREAK_FONT_STROKE,
  BREAK_Y_FRACTION,
  drawBreakNotice,
  drawLyricsBlockImage,
  drawTitleCard,
  getActiveBreakNoticeIndex,
  getLyricsBlockWidth,
  getPlacedLyricsBlockRect,
  getScrollXPos,
  placeLyricsBlockX,
  placeTelopRows,
  TelopAnnotations,
  TelopBlock,
  TelopLayout,
  TelopRaster,
  TelopRowPlacement,
  TELOP_SCREEN_HEIGHT,
  TELOP_SCREEN_WIDTH,
  TELOP_TEXT_PADDING,
  TELOP_TIMING_OFFSET_MS,
} from "../common/telopLayout";
import MediaClock from "./mediaClock";

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

const SCREEN_WIDTH = TELOP_SCREEN_WIDTH;
const SCREEN_HEIGHT = TELOP_SCREEN_HEIGHT;
const TEXT_PADDING = TELOP_TEXT_PADDING;

// XXX: A global, but it works. Resized with the canvas in updateSize. The
// textures a song's effect already built keep the raster they were drawn at,
// and a resize only rescales the quads they're drawn onto.
const raster: TelopRaster = {
  rate: 1.0,
  x: 1.0,
  y: 1.0,
  jpFont: "notoSerifJP",
  krFont: "notoSerifKR",
};

interface LyricsBlockTextures {
  preTexture: WebGLTexture;
  postTexture: WebGLTexture;
}

interface JoysoundDisplayBuffers {
  position: WebGLBuffer;
  texCoord: WebGLBuffer;
  scroll: WebGLBuffer;
  scrollType: WebGLBuffer;
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

// Constant per-vertex attribute arrays reused across draw calls instead of
// reallocated every frame: the title card, every break notice, and the
// non-wiped half of every visible lyrics block all upload the same values.
const ZERO_SCROLL_OFFSETS = new Float32Array(6);
const PRE_SCROLL_TYPE = new Float32Array(6);
const POST_SCROLL_TYPE = new Float32Array(6).fill(1.0);
const FULL_TEX_COORDS = new Float32Array(quadToTriangles(0.0, 0.0, 1.0, 1.0));

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

// Rasterizes one drawXToCanvas call into its own scratch canvas and uploads
// the result as a GL texture, freeing the scratch canvas afterward.
function createTextTexture(
  gl: WebGL2RenderingContext,
  draw: (textCtx: CanvasRenderingContext2D) => void,
): WebGLTexture {
  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  draw(textCtx);

  const result = createTextureFromImage(gl, textCtx.canvas);

  textCtx.canvas.remove();

  return result;
}

function createTitleTexture(
  gl: WebGL2RenderingContext,
  layout: TelopLayout,
): WebGLTexture {
  return createTextTexture(gl, (textCtx) =>
    drawTitleCard(textCtx, raster, layout.title, layout.annotations),
  );
}

function createBreakTexture(
  gl: WebGL2RenderingContext,
  approxDurationSecs: number,
): WebGLTexture {
  // Baked at yPos 0; the draw call shifts the quad to the live vertical
  // position (the piano roll band's center, which tracks the synced
  // pianoRollSize mid-song, or the bottom fallback).
  return createTextTexture(gl, (textCtx) =>
    drawBreakNotice(textCtx, raster, approxDurationSecs),
  );
}

function createLyricsBlockTextures(
  gl: WebGL2RenderingContext,
  layout: TelopLayout,
): LyricsBlockTextures[] {
  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  const lyricsBlockTextures = [];

  for (const lyricsBlock of layout.blocks) {
    drawLyricsBlockImage(
      textCtx,
      raster,
      lyricsBlock,
      lyricsBlock.preFill,
      lyricsBlock.preBorder,
      layout.annotations,
    );
    const preTexture = createTextureFromImage(gl, textCtx.canvas);

    drawLyricsBlockImage(
      textCtx,
      raster,
      lyricsBlock,
      lyricsBlock.postFill,
      lyricsBlock.postBorder,
      layout.annotations,
    );
    const postTexture = createTextureFromImage(gl, textCtx.canvas);

    lyricsBlockTextures.push({ preTexture, postTexture });
  }

  textCtx.canvas.remove();

  return lyricsBlockTextures;
}

// yOffset (in canvas pixels) shifts the whole texture down, letting content
// baked at yPos 0 be positioned at draw time (see createBreakTexture).
function drawTitle(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  titleTexture: WebGLTexture,
  yOffset: number = 0,
): void {
  const positions = quadToTriangles(
    0,
    yOffset,
    SCREEN_WIDTH * raster.x,
    SCREEN_HEIGHT * raster.y + yOffset,
  );

  drawLyricsTexture(
    gl,
    glBuffers,
    titleTexture,
    positions,
    ZERO_SCROLL_OFFSETS,
    false,
  );
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

  const scrollTypeArray = isPostTexture ? POST_SCROLL_TYPE : PRE_SCROLL_TYPE;

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.scrollType);
  gl.bufferData(gl.ARRAY_BUFFER, scrollTypeArray, gl.STATIC_DRAW);

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.texCoord);
  gl.bufferData(gl.ARRAY_BUFFER, FULL_TEX_COORDS, gl.STATIC_DRAW);

  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  gl.drawArrays(gl.TRIANGLES, 0, positions.length / 2);
}

// Draws one block at its placed rect (placeTelopRows decides where its row
// sits and how much the rows had to shrink to clear the piano roll or each
// other). The wipe boundary goes through the same transform as the quad, so
// highlight timing stays glyph-accurate however small the block is drawn.
function drawLyricsBlock(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  lyricsBlock: TelopBlock,
  annotations: TelopAnnotations,
  lyricsBlockTextures: LyricsBlockTextures[],
  index: number,
  refreshTime: number,
  placement: TelopRowPlacement,
) {
  const scrollXPos = Math.floor(getScrollXPos(lyricsBlock, refreshTime));

  const currX = lyricsBlock.xPos;
  const rectWidth = getLyricsBlockWidth(lyricsBlock);
  const rect = getPlacedLyricsBlockRect(lyricsBlock, annotations, placement);

  const scrollArray = new Float32Array(6).fill(
    placeLyricsBlockX(lyricsBlock, placement, scrollXPos) * raster.x,
  );

  const positions = quadToTriangles(
    rect.left * raster.x,
    rect.top * raster.y,
    (rect.left + rect.width) * raster.x,
    (rect.top + rect.height) * raster.y,
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

// Parses the telop, degrading stepwise on failure: retry without word
// segmentation, then without romaji at all; only when the plain parse also
// fails does this give up (null). A plain parse beats no lyrics (the EZ
// Romaji 6969-sentinel crash used to freeze the canvas on the previous
// song's title card for the whole song).
async function parseTelop(
  telop: ArrayBuffer,
  kuroshiro: KuroshiroSingleton,
  wordSegmentation: boolean,
): Promise<JoysoundTelopData | null> {
  const parseAttempts = [
    { wordSegmentation, skipRomaji: false },
    ...(wordSegmentation
      ? [{ wordSegmentation: false, skipRomaji: false }]
      : []),
    { wordSegmentation: false, skipRomaji: true },
  ];

  let parseError: unknown = null;

  for (const attempt of parseAttempts) {
    try {
      return await parseJoysoundData(
        telop,
        kuroshiro,
        attempt.wordSegmentation,
        attempt.skipRomaji,
      );
    } catch (e) {
      parseError = e;
      console.error(
        `parseJoysoundData failed (wordSegmentation=${attempt.wordSegmentation}, skipRomaji=${attempt.skipRomaji})`,
        e,
      );
    }
  }

  console.error("All parseJoysoundData attempts failed", parseError);
  return null;
}

interface ParseCacheEntry {
  telop: ArrayBuffer;
  wordSegmentation: boolean;
  result: Promise<JoysoundTelopData | null>;
}

export default function JoysoundRenderer(props: {
  telop: ArrayBuffer;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  kuroshiro: KuroshiroSingleton;
  pianoRollVisible: boolean;
  onTitleFadeout?: () => void;
  breaks: InstrumentalBreak[];
  onBreakActiveChange?: (active: boolean) => void;
  // The queue entry this telop belongs to (queueItemKey), handed back with
  // the layout so a caller can't pair one song's lyrics with the next song.
  songKey: string;
  // Called with exactly what this canvas draws, once per layout (a new song,
  // a reading-guide change, or a word-segmentation toggle), or with null when
  // no parse succeeded and the canvas shows no lyrics at all. It's what the
  // remocon's lyrics panel mirrors.
  onLayout?: (songKey: string, layout: TelopLayout | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // In telop coordinates, the y below which lyrics rows must stay so they
  // don't hide behind the piano roll. Held in a ref so the draw loop (which
  // lives inside a one-shot effect) always sees the live synced size.
  const { pianoRollSize } = usePianoRollSize();
  const { joysoundRomajiWordSegmentation } =
    useJoysoundRomajiWordSegmentation();
  // Which reading guides go above and below the lyrics: room settings, so
  // flipping one on a phone re-lays the song out here mid-play.
  const { joysoundTopAnnotation } = useJoysoundTopAnnotation();
  const { joysoundBottomAnnotation } = useJoysoundBottomAnnotation();
  const pianoRollClearanceRef = useRef(0);
  pianoRollClearanceRef.current =
    props.pianoRollVisible && pianoRollSize > 0
      ? (PIANO_ROLL_TOP_FRACTION + pianoRollSize) * SCREEN_HEIGHT + 8
      : 0;

  // Vertical position (telop coordinates, drawTextToCanvas semantics) for
  // the break notice. With a roll on screen it sits centered in the ducked
  // roll's band, the one region lyrics are remapped to clear, so the notice
  // can't overlap them. With no roll it takes the classic bottom-of-screen
  // spot.
  const breakNoticeYPosRef = useRef(SCREEN_HEIGHT * BREAK_Y_FRACTION);
  breakNoticeYPosRef.current =
    props.pianoRollVisible && pianoRollSize > 0
      ? (PIANO_ROLL_TOP_FRACTION + pianoRollSize / 2) * SCREEN_HEIGHT -
        BREAK_FONT_SIZE / 2 -
        BREAK_FONT_STROKE -
        TEXT_PADDING
      : SCREEN_HEIGHT * BREAK_Y_FRACTION;

  // The last parse, kept so a reading-guide change mid-song only
  // re-rasterizes the blocks rather than re-running kuromoji over the whole
  // telop (a second or more of blank lyrics on a long song). Keyed by the
  // telop buffer and the word-segmentation setting, the two things the parse
  // depends on; the guides only decide what gets drawn from it.
  const parseCacheRef = useRef<ParseCacheEntry | null>(null);

  const updateSize = () => {
    const canvasElement = canvasRef.current;
    invariant(canvasElement);

    canvasElement.width = canvasElement.clientWidth * window.devicePixelRatio;
    canvasElement.height = canvasElement.clientHeight * window.devicePixelRatio;

    raster.rate = Math.min(
      canvasElement.width / SCREEN_WIDTH,
      canvasElement.height / SCREEN_HEIGHT,
    );

    raster.x = canvasElement.width / SCREEN_WIDTH;
    raster.y = canvasElement.height / SCREEN_HEIGHT;

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
    // zombie, still firing onBreakActiveChange with a stale song's breaks.
    let cancelled = false;
    let animationFrameRequest = 0;
    // Set once refresh() has built this song's GL resources, so the cleanup can
    // release them. They are locals in there, and the canvas (and so the GL
    // context) outlives this effect whenever one JOYSOUND song follows another:
    // `shouldShowJoysound` stays true and `joysoundTelop` is never reset to
    // null across that transition, so the component is not remounted and only
    // the effect re-runs. A song's lyrics textures come to 100-125MB at 1080p
    // and 400-500MB at 4K, which is a lot to leave to whenever the collector
    // next feels like it.
    let releaseGlResources: (() => void) | null = null;

    const annotations: TelopAnnotations = {
      top: joysoundTopAnnotation,
      bottom: joysoundBottomAnnotation,
    };

    const refresh = async () => {
      updateSize();
      window.addEventListener("resize", updateSize);

      // A parse failure must not throw out of refresh(): by the time this
      // effect runs, the previous effect instance's draw loop is already
      // cancelled, so bailing would freeze the canvas on its last-drawn
      // frame, typically the PREVIOUS song's title card, for the entire
      // song. parseTelop degrades instead, and only when even the plain
      // parse fails does this clear the canvas so the room sees the bare MV
      // rather than stale telop.
      const cached = parseCacheRef.current;
      const parse =
        cached !== null &&
        cached.telop === props.telop &&
        cached.wordSegmentation === joysoundRomajiWordSegmentation
          ? cached.result
          : parseTelop(
              props.telop,
              props.kuroshiro,
              joysoundRomajiWordSegmentation,
            );
      parseCacheRef.current = {
        telop: props.telop,
        wordSegmentation: joysoundRomajiWordSegmentation,
        result: parse,
      };

      const joysoundData = await parse;

      if (cancelled) {
        return;
      }

      if (joysoundData === null) {
        // Not worth keeping: the toast below would repeat on every
        // reading-guide change for the rest of the song.
        if (parseCacheRef.current?.result === parse) {
          parseCacheRef.current = null;
        }

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
        props.onLayout?.(props.songKey, null);
        return;
      }

      const layout = toTelopLayout(joysoundData, annotations, props.breaks);
      const lyricsData = layout.blocks;

      props.onLayout?.(props.songKey, layout);

      // Where the rows sit for the current piano roll clearance. Recomputed
      // only when the clearance changes (a size preset mid-song), not per
      // frame.
      let placementClearance = pianoRollClearanceRef.current;
      let placement = placeTelopRows(layout, placementClearance);

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

      const titleTexture = createTitleTexture(gl, layout);
      const lyricsBlockTextures = createLyricsBlockTextures(gl, layout);
      const breakTextures = layout.breaks.map((b) =>
        createBreakTexture(gl, b.approxDurationSecs),
      );

      const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
      const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);

      const program = createProgram(gl, vertexShader, fragmentShader);

      // Driven from the draw loop below, once per frame. See mediaClock.ts.
      const mediaClock = new MediaClock();

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

      releaseGlResources = () => {
        gl.deleteTexture(titleTexture);
        lyricsBlockTextures.forEach(({ preTexture, postTexture }) => {
          gl.deleteTexture(preTexture);
          gl.deleteTexture(postTexture);
        });
        breakTextures.forEach((texture) => gl.deleteTexture(texture));
        gl.deleteProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        Object.values(glBuffers).forEach((buffer) => gl.deleteBuffer(buffer));
      };

      function draw(now: number) {
        if (cancelled) {
          return;
        }
        invariant(gl);
        invariant(props.videoRef.current);

        // Smoothed rather than raw: the lyric wipe scrolls off this clock the
        // same way the piano roll does, so it inherits the same judder from
        // sampling `currentTime` directly. See mediaClock.ts.
        const refreshTime =
          mediaClock.now(props.videoRef.current) * 1000 +
          TELOP_TIMING_OFFSET_MS;
        invariant(Number.isFinite(refreshTime));

        if (pianoRollClearanceRef.current !== placementClearance) {
          placementClearance = pianoRollClearanceRef.current;
          placement = placeTelopRows(layout, placementClearance);
        }

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

        if (refreshTime < layout.title.fadeoutTime) {
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
            drawLyricsBlock(
              gl,
              glBuffers,
              lyricsBlock,
              layout.annotations,
              lyricsBlockTextures,
              i,
              refreshTime,
              placement,
            );
          }
        }

        const breakNoticeIndex = getActiveBreakNoticeIndex(
          layout.breaks,
          refreshTime,
        );

        if (breakNoticeIndex >= 0) {
          drawTitle(
            gl,
            glBuffers,
            breakTextures[breakNoticeIndex],
            breakNoticeYPosRef.current * raster.y,
          );
        }

        // Un-duck before the break's literal end: notes for the next phrase
        // start scrolling into the piano roll's visible window
        // PIANO_ROLL_LOOKAHEAD_SECS ahead of when they're actually due, so
        // the roll should already be back by then, not still fading in.
        const duckedBreakIndex = layout.breaks.findIndex(
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
      releaseGlResources?.();
    };
  }, [
    props.telop,
    props.songKey,
    joysoundRomajiWordSegmentation,
    joysoundTopAnnotation,
    joysoundBottomAnnotation,
  ]);

  return <canvas ref={canvasRef} className="joysoundDisplay"></canvas>;
}
