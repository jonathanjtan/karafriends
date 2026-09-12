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
import useJoysoundRomajiWordSegmentation from "../common/hooks/useJoysoundRomajiWordSegmentation";
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
  getLyricsBlockRect,
  getScrollXPos,
  LYRICS_BLOCK_ASCENT,
  LYRICS_BLOCK_DESCENT,
  TelopBlock,
  TelopLayout,
  TelopRaster,
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

function createTitleTexture(
  gl: WebGL2RenderingContext,
  layout: TelopLayout,
): WebGLTexture {
  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  drawTitleCard(textCtx, raster, layout.title, layout.isRomaji);

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

  // Baked at yPos 0; the draw call shifts the quad to the live vertical
  // position (the piano roll band's center, which tracks the synced
  // pianoRollSize mid-song, or the bottom fallback).
  drawBreakNotice(textCtx, raster, approxDurationSecs);

  const result = createTextureFromImage(gl, textCtx.canvas);

  textCtx.canvas.remove();

  return result;
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
      layout.isRomaji,
    );
    const preTexture = createTextureFromImage(gl, textCtx.canvas);

    drawLyricsBlockImage(
      textCtx,
      raster,
      lyricsBlock,
      lyricsBlock.postFill,
      lyricsBlock.postBorder,
      layout.isRomaji,
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
  const scrollArray = new Float32Array(Array(6).fill(0));

  const positions = quadToTriangles(
    0,
    yOffset,
    SCREEN_WIDTH * raster.x,
    SCREEN_HEIGHT * raster.y + yOffset,
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

// Keeps lyrics rows from hiding behind the piano roll: while the roll is on
// screen, the whole set of rows is centered vertically in the space between
// the roll's bottom edge and the bottom of the screen (so lyrics don't hug
// the bottom of the screen as the roll grows). When that space can't fit the
// original layout, the returned scale shrinks the row spacing AND the drawn
// block size by the same factor. Compressing spacing alone let a squeezed
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
  lyricsBlock: TelopBlock,
  lyricsBlockTextures: LyricsBlockTextures[],
  index: number,
  refreshTime: number,
  yPos: number,
  scale: number,
) {
  const scrollXPos = Math.floor(getScrollXPos(lyricsBlock, refreshTime));

  const currX = lyricsBlock.xPos;
  const rect = getLyricsBlockRect(lyricsBlock, yPos);
  const rectWidth = rect.width;

  // Shrink the block around its own center-x / yPos when remapLyricsYPos
  // compressed the rows, keeping the wipe boundary (scroll) in the same
  // transformed space as the quad so highlight timing stays glyph-accurate.
  const anchorX = currX + rectWidth / 2 - TEXT_PADDING;
  const toScreenX = (x: number) => (anchorX + (x - anchorX) * scale) * raster.x;
  const toScreenY = (y: number) => (yPos + (y - yPos) * scale) * raster.y;

  const scrollArray = new Float32Array(Array(6).fill(toScreenX(scrollXPos)));

  const positions = quadToTriangles(
    toScreenX(rect.left),
    toScreenY(rect.top),
    toScreenX(rect.left + rect.width),
    toScreenY(rect.top + rect.height),
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
  // The queue entry this telop belongs to (queueItemKey), handed back with
  // the layout so a caller can't pair one song's lyrics with the next song.
  songKey: string;
  // Called with exactly what this canvas draws, once per parse (a new song, a
  // romaji mode, or a word-segmentation toggle), or with null when no parse
  // succeeded and the canvas shows no lyrics at all. It's what the remocon's
  // lyrics panel mirrors.
  onLayout?: (songKey: string, layout: TelopLayout | null) => void;
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

    const refresh = async () => {
      updateSize();
      window.addEventListener("resize", updateSize);

      // Yeah we parse the data on each re-render, ffuck it
      //
      // A parse failure here must not throw out of refresh(): by the time
      // this effect runs, the previous effect instance's draw loop is already
      // cancelled, so bailing would freeze the canvas on its last-drawn frame,
      // typically the PREVIOUS song's title card, for the entire song (the
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
        props.onLayout?.(props.songKey, null);
        return;
      }

      const layout = toTelopLayout(joysoundData, props.isRomaji, props.breaks);
      const lyricsData = layout.blocks;

      props.onLayout?.(props.songKey, layout);

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
    props.isRomaji,
    props.songKey,
    joysoundRomajiWordSegmentation,
  ]);

  return <canvas ref={canvasRef} className="joysoundDisplay"></canvas>;
}
