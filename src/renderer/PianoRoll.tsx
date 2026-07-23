/* tslint:disable:max-classes-per-file */

import convert from "color-convert";
import Spline from "cubic-spline";
import vec from "gl-vec2";
import getNormals from "polyline-normals";
import React, { useEffect, useRef, useState } from "react";

import {
  MIC_RMS_GATE_THRESHOLD,
  PIANO_ROLL_CURSOR_FRACTION as CURSOR_FRACTION,
  PIANO_ROLL_LOOKAHEAD_SECS,
  PIANO_ROLL_TIME_WIDTH_SECS as TIME_WIDTH_SECS,
  PIANO_ROLL_TOP_FRACTION,
} from "../common/constants";
import useMicRmsGateEnabled from "../common/hooks/useMicRmsGateEnabled";
import usePianoRollOpacity from "../common/hooks/usePianoRollOpacity";
import usePianoRollSize from "../common/hooks/usePianoRollSize";
import { ScoreAccumulator } from "../common/scoring";
import { parseScoringData } from "../common/scoringData";
import { InputDevice } from "./nativeAudio";
import "./PianoRoll.css";
import midiVertShaderRaw from "./shaders/PianoRollMidi.vert.glsl";
import noteFragShaderRaw from "./shaders/PianoRollNote.frag.glsl";
import seekVertShaderRaw from "./shaders/PianoRollSeek.vert.glsl";
import singleColorFragShaderRaw from "./shaders/PianoRollSingleColor.frag.glsl";

// The visible window is TIME_WIDTH_SECS wide, with "now" pinned at
// CURSOR_FRACTION from the left edge; notes scroll right-to-left past it.
// 0.3 * 7s leaves ~4.9s of upcoming notes visible (matching the old
// page-at-a-time view) plus ~2.1s of trailing pitch-detection history.
const PITCH_RESOLUTION = 8;
const STROKE_WIDTH = 0.03;
// How much to dim the roll during an announced instrumental break.
const PIANO_ROLL_DUCK_FACTOR = 0.15;

function loadShader(
  gl: WebGLRenderingContext,
  type:
    | WebGLRenderingContextBase["VERTEX_SHADER"]
    | WebGLRenderingContextBase["FRAGMENT_SHADER"],
  source: string,
) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(`Error compiling shader: ${gl.getShaderInfoLog(shader)}`);
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function edgesToTriangles(top: number[][], bottom: number[][]) {
  const triangles = [];

  for (let i = 0; i < top.length - 1; i++) {
    const x0 = top[i][0];
    const y0 = top[i][1];

    const x1 = bottom[i][0];
    const y1 = bottom[i][1];

    const x2 = top[i + 1][0];
    const y2 = top[i + 1][1];

    const x3 = bottom[i + 1][0];
    const y3 = bottom[i + 1][1];

    triangles.push(...[x0, y0, x1, y1, x2, y2, x1, y1, x2, y2, x3, y3]);
  }

  return triangles;
}

function quadToTriangles(x0: number, y0: number, x1: number, y1: number) {
  /*
    (x0, y0) - (x1, y0)
       |     \    |
    (x0, y1) - (x1, y1)

    GL makes us list triangles in counter-clockwise order
  */
  return [x0, y0, x0, y1, x1, y1, x0, y0, x1, y1, x1, y0];
}

function median(nums: number[]) {
  const numsSorted = [...nums];
  numsSorted.sort();
  const middleIndex = Math.floor(nums.length / 2);
  if (nums.length % 2 === 0) {
    return (numsSorted[middleIndex - 1] + numsSorted[middleIndex]) / 2;
  } else {
    return numsSorted[middleIndex];
  }
}

abstract class ShaderProgram<T extends unknown[]> {
  readonly gl: WebGLRenderingContext;
  readonly program: WebGLProgram;
  readonly attributeLocations: { [name: string]: number };
  readonly uniformLocations: { [name: string]: WebGLUniformLocation };
  readonly buffers: { [name: string]: WebGLBuffer };

  constructor(
    gl: WebGLRenderingContext,
    shaders: WebGLShader[],
    attributeNames: string[],
    uniformNames: string[],
    bufferNames: string[],
  ) {
    this.gl = gl;
    this.program = gl.createProgram()!;
    shaders.forEach((shader) => gl.attachShader(this.program, shader));
    gl.linkProgram(this.program);
    this.attributeLocations = Object.fromEntries(
      attributeNames.map((name) => [
        name,
        gl.getAttribLocation(this.program, name),
      ]),
    );
    this.uniformLocations = Object.fromEntries(
      uniformNames.map((name) => [
        name,
        gl.getUniformLocation(this.program, name)!,
      ]),
    );
    this.buffers = Object.fromEntries(
      bufferNames.map((name) => [name, gl.createBuffer()!]),
    );
  }

  abstract draw(...args: T): void;
}

class NoteProgram extends ShaderProgram<[number, number]> {
  readonly triangleCount: number;

  constructor(gl: WebGLRenderingContext, positions: number[]) {
    super(
      gl,
      [
        loadShader(gl, gl.VERTEX_SHADER, midiVertShaderRaw)!,
        loadShader(gl, gl.FRAGMENT_SHADER, noteFragShaderRaw)!,
      ],
      ["position"],
      ["time", "timeWidth", "canvasWidth", "cursorFraction"],
      ["positions"],
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.positions);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    this.triangleCount = positions.length / 2;
  }

  draw(time: number, canvasWidth: number) {
    if (this.gl.CURRENT_PROGRAM !== this.program) {
      this.gl.useProgram(this.program);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.positions);
      this.gl.vertexAttribPointer(
        this.attributeLocations.position,
        2,
        this.gl.FLOAT,
        false,
        0,
        0,
      );
      this.gl.enableVertexAttribArray(this.attributeLocations.position);
      this.gl.uniform1f(this.uniformLocations.timeWidth, TIME_WIDTH_SECS);
      this.gl.uniform1f(this.uniformLocations.cursorFraction, CURSOR_FRACTION);
    }

    this.gl.uniform1f(this.uniformLocations.time, time);
    this.gl.uniform1f(this.uniformLocations.canvasWidth, canvasWidth);

    this.gl.drawArrays(this.gl.TRIANGLES, 0, this.triangleCount);
  }
}

class SeekProgram extends ShaderProgram<[]> {
  readonly triangleCount: number;

  constructor(gl: WebGLRenderingContext) {
    super(
      gl,
      [
        loadShader(gl, gl.VERTEX_SHADER, seekVertShaderRaw)!,
        loadShader(gl, gl.FRAGMENT_SHADER, singleColorFragShaderRaw)!,
      ],
      ["position"],
      ["cursorFraction", "color"],
      ["positions"],
    );
    const positions = quadToTriangles(-1.005, 1.0, -0.995, -1.0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.positions);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    this.triangleCount = positions.length / 2;
  }

  draw() {
    if (this.gl.CURRENT_PROGRAM !== this.program) {
      this.gl.useProgram(this.program);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.positions);
      this.gl.vertexAttribPointer(
        this.attributeLocations.position,
        2,
        this.gl.FLOAT,
        false,
        0,
        0,
      );
      this.gl.enableVertexAttribArray(this.attributeLocations.position);
      this.gl.uniform1f(this.uniformLocations.cursorFraction, CURSOR_FRACTION);
      this.gl.uniform4fv(this.uniformLocations.color, [0.9, 0.9, 0.9, 1.0]);
    }

    this.gl.drawArrays(this.gl.TRIANGLES, 0, this.triangleCount);
  }
}

class PitchProgram extends ShaderProgram<[number, number, number[]]> {
  readonly color: [number, number, number];

  constructor(gl: WebGLRenderingContext, color: [number, number, number]) {
    super(
      gl,
      [
        loadShader(gl, gl.VERTEX_SHADER, midiVertShaderRaw)!,
        loadShader(gl, gl.FRAGMENT_SHADER, singleColorFragShaderRaw)!,
      ],
      ["position"],
      ["time", "timeWidth", "color", "cursorFraction"],
      ["positions"],
    );
    this.color = color;
  }

  draw(time: number, canvasWidth: number, positions: number[]) {
    if (this.gl.CURRENT_PROGRAM !== this.program) {
      this.gl.useProgram(this.program);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.positions);
      this.gl.vertexAttribPointer(
        this.attributeLocations.position,
        2,
        this.gl.FLOAT,
        false,
        0,
        0,
      );
      this.gl.enableVertexAttribArray(this.attributeLocations.position);
      this.gl.uniform1f(this.uniformLocations.timeWidth, TIME_WIDTH_SECS);
      this.gl.uniform1f(this.uniformLocations.cursorFraction, CURSOR_FRACTION);
      this.gl.uniform4f(this.uniformLocations.color, ...this.color, 1.0);
    }

    this.gl.uniform1f(this.uniformLocations.time, time);
    this.gl.uniform1f(this.uniformLocations.canvasWidth, canvasWidth);

    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array(positions),
      this.gl.DYNAMIC_DRAW,
    );
    this.gl.drawArrays(this.gl.TRIANGLES, 0, positions.length / 2);
  }
}

class FreeTimeProgram extends ShaderProgram<[number, number]> {
  readonly triangleCount: number;

  constructor(gl: WebGLRenderingContext, positions: number[]) {
    super(
      gl,
      [
        loadShader(gl, gl.VERTEX_SHADER, midiVertShaderRaw)!,
        loadShader(gl, gl.FRAGMENT_SHADER, singleColorFragShaderRaw)!,
      ],
      ["position"],
      ["time", "timeWidth", "canvasWidth", "color", "cursorFraction"],
      ["positions"],
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.positions);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    this.triangleCount = positions.length / 2;
  }

  draw(time: number, canvasWidth: number) {
    if (this.gl.CURRENT_PROGRAM !== this.program) {
      this.gl.useProgram(this.program);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.positions);
      this.gl.vertexAttribPointer(
        this.attributeLocations.position,
        2,
        this.gl.FLOAT,
        false,
        0,
        0,
      );
      this.gl.enableVertexAttribArray(this.attributeLocations.position);
      this.gl.uniform1f(this.uniformLocations.timeWidth, TIME_WIDTH_SECS);
      this.gl.uniform1f(this.uniformLocations.cursorFraction, CURSOR_FRACTION);
      this.gl.uniform4fv(this.uniformLocations.color, [0, 0, 0, 0.5]);
    }

    this.gl.uniform1f(this.uniformLocations.time, time);
    this.gl.uniform1f(this.uniformLocations.canvasWidth, canvasWidth);

    this.gl.drawArrays(this.gl.TRIANGLES, 0, this.triangleCount);
  }
}

class PitchDetectionBuffer {
  buffer: { time: number; value: number }[] = [];
  positions: number[] = [];
  pitchOffset: number = 0;

  push(
    pitchMidiNumber: number,
    medianMidiNumber: number,
    currentMidiNumber: number,
    time: number,
  ) {
    this.pitchOffset +=
      Math.round(
        (currentMidiNumber - (pitchMidiNumber + this.pitchOffset)) / 12,
      ) * 12;

    const pitchMidiNumberOffset = pitchMidiNumber + this.pitchOffset;

    if (
      this.buffer.length === 0 ||
      time > this.buffer[this.buffer.length - 1].time
    ) {
      this.buffer.push({
        time,
        value: pitchMidiNumberOffset,
      });
    } else {
      this.buffer[this.buffer.length - 1] = {
        time,
        value: pitchMidiNumberOffset,
      };
    }

    if (this.buffer.length > 200) {
      this.buffer.shift();
      this.positions.splice(0, 12 * (PITCH_RESOLUTION - 1));
    }

    if (this.buffer.length >= 1) {
      const lastIndex = this.buffer.length - 1;

      let timeGap = null;
      let pitchGap = null;

      if (this.buffer.length >= 3) {
        timeGap = this.buffer[lastIndex].time - this.buffer[lastIndex - 2].time;

        pitchGap = Math.max(
          Math.abs(
            this.buffer[lastIndex].value - this.buffer[lastIndex - 1].value,
          ),
          Math.abs(
            this.buffer[lastIndex - 1].value - this.buffer[lastIndex - 2].value,
          ),
          Math.abs(
            this.buffer[lastIndex].value - this.buffer[lastIndex - 2].value,
          ),
        );
      }

      // If we don't have 3 points to create a spline with, or the time/pitch gap
      // between points is too large, just draw the current point as is.
      if (!timeGap || !pitchGap || timeGap > 0.06 || pitchGap > 7) {
        const pitchPoint = quadToTriangles(
          this.buffer[lastIndex].time - 0.025,
          this.buffer[lastIndex].value - STROKE_WIDTH / 2,
          this.buffer[lastIndex].time,
          this.buffer[lastIndex].value + STROKE_WIDTH / 2,
        );

        for (let i = 0; i < PITCH_RESOLUTION - 1; i++) {
          this.positions.push(...pitchPoint);
        }

        return;
      }

      const path = [];

      const bufferSlice = this.buffer.slice(lastIndex - 2, lastIndex + 1);
      const spline = new Spline(
        bufferSlice.map((obj) => obj.time),
        bufferSlice.map((obj) =>
          midiNumberToYCoord(obj.value, medianMidiNumber),
        ),
      );

      for (let i = 0; i < PITCH_RESOLUTION; i++) {
        const currX =
          this.buffer[lastIndex - 2].time + i * (timeGap / PITCH_RESOLUTION);

        path.push([currX, spline.at(currX)]);
      }

      const edges: number[][][] = this.createEdges(path);
      const newLineSegment = edgesToTriangles(edges[0], edges[1]);

      // Only add the newest line segment to positions
      this.positions.push(...newLineSegment);
    }
  }

  clear() {
    this.buffer = [];
    this.positions = [];
  }

  createEdges(path: number[][]) {
    const top: number[][] = [];
    const bottom: number[][] = [];

    const normals: any = getNormals(path, false);
    const tmp = [0, 0];

    path.forEach((point, i) => {
      const normal: number[] = normals[i][0];
      const join: number = normals[i][1];

      vec.scaleAndAdd(tmp, point, normal, (join * STROKE_WIDTH) / 2);
      top.push(tmp.slice());

      vec.scaleAndAdd(tmp, point, normal, (-join * STROKE_WIDTH) / 2);
      bottom.push(tmp.slice());
    });

    return [top, bottom];
  }
}

function midiNumberToYCoord(midiNumber: number, medianMidiNumber: number) {
  // We draw 18 rows behind the canvas, and we also want to be able to align
  // notes in-between rows, so we have 36 positions. We want to return
  // positions that correspond to the center of a bar or in-between two bars.
  // If we're at the median MIDI number, we should be dead-center.
  return 0.5 + (midiNumber - medianMidiNumber) / 36;
}

export default function PianoRoll(props: {
  scoringData: readonly number[];
  // Only consumed by the latency-probe capture, to tag each sample so a
  // multi-song probe log can be split by song (see pitchProbeEnabled).
  songId: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mics: InputDevice[];
  pitchShiftSemis: number;
  // EXPERIMENTAL scoring. Owned by Player (which knows the song boundaries)
  // and merely fed from here, because the GL effect below rebuilds on every
  // parent render and would otherwise discard the accumulated performance.
  // Null when the experimental flag is off or the song has no usable
  // reference melody.
  scoreAccumulatorRef?: React.MutableRefObject<ScoreAccumulator | null>;
  // Gates the fade-in so the roll doesn't cover a JOYSOUND title card.
  visible: boolean;
  // Dims the roll during an announced instrumental break so it doesn't
  // cover the break notice.
  ducked: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRequestRef = useRef<number>(0);

  // Keeps the roll hidden through a long instrumental intro (so the MV plays
  // unobstructed), fading it in as the first note scrolls into the visible
  // window, and fades it back out once the guide melody is over (the outro).
  // Seeking un-fades/re-fades to match the new position.
  const [melodyActive, setMelodyActive] = useState(false);

  // Applied as plain CSS below; changes re-render the canvas element but
  // don't re-run the GL effect (its deps only cover props identity).
  const { pianoRollOpacity } = usePianoRollOpacity();
  const { pianoRollSize } = usePianoRollSize();

  // Read through a ref inside pollPitch: the GL effect's deps only cover
  // props identity, so its closures would otherwise capture a stale value
  // (and adding it to the deps would rebuild the whole GL pipeline mid-song
  // on every toggle).
  const { micRmsGateEnabled } = useMicRmsGateEnabled();
  const micRmsGateEnabledRef = useRef(false);
  micRmsGateEnabledRef.current = micRmsGateEnabled;

  useEffect(() => {
    const video = props.videoRef.current;
    if (!video) return;

    const { notes } = parseScoringData(props.scoringData);
    if (notes.length === 0) return;

    // Fade in once the first note starts entering the visible window from
    // the right edge, PIANO_ROLL_LOOKAHEAD_SECS before its startTime crosses
    // the "now" cursor.
    const fadeInTime = notes[0].startTime - PIANO_ROLL_LOOKAHEAD_SECS;
    // Fade out once the final note has scrolled fully past the left edge:
    // a note exits the visible window CURSOR_FRACTION * TIME_WIDTH_SECS
    // after its endTime crosses the "now" cursor.
    const fadeOutTime =
      notes[notes.length - 1].endTime + CURSOR_FRACTION * TIME_WIDTH_SECS;

    const onTimeUpdate = () =>
      setMelodyActive(
        video.currentTime >= fadeInTime && video.currentTime < fadeOutTime,
      );
    onTimeUpdate();
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
    // Only what the effect actually reads. Depending on `props` wholesale
    // would re-run this on every Player render, since the props object is a
    // fresh literal each time -- see the effect below, where that was
    // silently wiping the sung-pitch trail mid-song.
  }, [props.scoringData, props.videoRef]);

  useEffect(() => {
    if (!canvasRef.current || !props.videoRef.current) return;

    // Read once, not per sample: the pitch-probe capture is a calibration aid,
    // and the poll loop is hot. Toggle with config.yaml's pitchProbeEnabled --
    // the renderer is the big-screen window, so a config flag is far easier to
    // reach than its devtools localStorage, and it lives beside the
    // micLatencyCalibrationMs the capture is used to set.
    const pitchProbeEnabled =
      window.karafriends.karafriendsConfig().pitchProbeEnabled === true;
    // Captured here (not read per sample): this effect rebuilds per song, in
    // lockstep with scoringData, so props.songId is constant for its lifetime.
    const probeSongId = props.songId;
    // Samples are batched here and flushed via main to the per-day probe log
    // in the app's data dir (probe-logs/, beside config.yaml), rather than
    // console.logged: that way calibration data collects from the packaged app
    // just by enabling the flag -- no terminal or stdout capture, which a
    // Finder-launched .app has no way to provide.
    const probeBuffer: string[] = [];
    let probeFlushInterval: ReturnType<typeof setInterval> | null = null;
    const flushProbeBuffer = () => {
      if (probeBuffer.length > 0) {
        window.karafriends.appendProbeLog(probeBuffer.splice(0));
      }
    };
    if (pitchProbeEnabled) {
      // Startup breadcrumb so anyone calibrating can confirm the flag took
      // effect before singing a whole song for nothing.
      console.log(
        `PROBE_PITCH capture enabled (config.pitchProbeEnabled), song ${probeSongId}`,
      );
      probeFlushInterval = setInterval(flushProbeBuffer, 2000);
    }

    const {
      notes: rawNotes,
      freeTimeIntervals,
      pogIntervals,
    } = parseScoringData(props.scoringData);

    const notes = rawNotes.map((note) => ({
      ...note,
      midiNumber: note.midiNumber + props.pitchShiftSemis,
    }));

    const medianMidiNumber = median(notes.map((note) => note.midiNumber));

    const positions = notes
      .map((note) =>
        quadToTriangles(
          note.startTime,
          midiNumberToYCoord(note.midiNumber + 1, medianMidiNumber),
          note.endTime,
          midiNumberToYCoord(note.midiNumber - 1, medianMidiNumber),
        ),
      )
      .flat();

    let currentNoteIndex = 0;

    const freeTimePositions = freeTimeIntervals
      .map(({ startTime, endTime }) =>
        quadToTriangles(startTime, 1.0, endTime, 0.0),
      )
      .flat();

    function pollPitch(mic: InputDevice | null, buffer: PitchDetectionBuffer) {
      if (!mic || !props.videoRef.current) return;
      const { midiNumber, confidence, rms } = mic.getPitch();
      // Confidence can't catch quiet-but-periodic bleed (YIN normalizes
      // amplitude away), so the gate is an absolute level floor instead.
      // rms is undefined when the addon behind us predates it (Parcel can
      // reuse a cached index.node); the gate is then inert rather than
      // gating everything.
      if (
        micRmsGateEnabledRef.current &&
        typeof rms === "number" &&
        rms < MIC_RMS_GATE_THRESHOLD
      ) {
        return;
      }
      if (
        confidence >= 0.8 &&
        midiNumber !== 0 &&
        !props.videoRef.current.paused
      ) {
        while (
          notes[currentNoteIndex].endTime <
            props.videoRef.current.currentTime &&
          currentNoteIndex < notes.length - 2
        ) {
          currentNoteIndex++;
        }
        const currentMidiNumber = notes[currentNoteIndex].midiNumber;
        buffer.push(
          midiNumber,
          medianMidiNumber,
          currentMidiNumber,
          props.videoRef.current.currentTime,
        );
        // Latency-calibration capture, off unless config.pitchProbeEnabled is
        // set (checked once when this effect ran, see pitchProbeEnabled). Each
        // accepted sample is buffered as
        //   PROBE_PITCH <songId> <videoTime> <midi> <shift>
        // and flushed to probe-logs/probe-<date>.log; the songId tag lets that
        // log be split by song. Feed it to scripts/measureMicLatency.mjs.
        if (pitchProbeEnabled) {
          probeBuffer.push(
            `PROBE_PITCH ${probeSongId} ${props.videoRef.current.currentTime.toFixed(4)} ${midiNumber.toFixed(3)} ${props.pitchShiftSemis}`,
          );
        }
        // Every open mic feeds one accumulator -- whoever is singing counts.
        // Duplicate samples from mic bleed are deduplicated by frame slot
        // inside addSample, so extra mics can't inflate coverage.
        props.scoreAccumulatorRef?.current?.addSample(
          props.videoRef.current.currentTime,
          midiNumber,
          props.pitchShiftSemis,
        );
      }
    }

    const gl = canvasRef.current.getContext("webgl2", {
      antialias: true,
      premultipliedAlpha: false,
    })!;

    const pitchPollers: [PitchDetectionBuffer, PitchProgram, NodeJS.Timeout][] =
      props.mics.map((mic, i) => {
        const buffer = new PitchDetectionBuffer();
        return [
          buffer,
          new PitchProgram(
            gl,
            convert.hsv
              .rgb([(360 / props.mics.length) * i, 30, 100])
              .map((channel) => channel / 255) as [number, number, number],
          ),
          setInterval(() => pollPitch(mic, buffer), 25),
        ];
      });

    const noteProgram = new NoteProgram(gl, positions);
    const seekProgram = new SeekProgram(gl);
    const freeTimeProgram = new FreeTimeProgram(gl, freeTimePositions);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);

    const draw = () => {
      if (!canvasRef.current || !props.videoRef.current) return;

      const time = props.videoRef.current.currentTime;
      const canvasWidth = canvasRef.current.width;

      gl.clear(gl.COLOR_BUFFER_BIT);

      if (freeTimePositions.length > 0) {
        freeTimeProgram.draw(time, canvasWidth);
      }

      if (positions.length > 0) {
        noteProgram.draw(time, canvasWidth);
      }

      pitchPollers.forEach(([buffer, shader, _]) => {
        if (buffer.positions.length > 0) {
          shader.draw(time, canvasWidth, buffer.positions);
        }
      });

      seekProgram.draw();

      canvasRef.current.classList.toggle(
        "pianoRollPog",
        pogIntervals.some(
          ({ startTime, endTime }) => time >= startTime - 1 && time <= endTime,
        ),
      );

      animationFrameRequestRef.current = window.requestAnimationFrame(draw);
    };

    animationFrameRequestRef.current = window.requestAnimationFrame(draw);

    function updateSize() {
      if (!canvasRef.current) return;
      canvasRef.current.width =
        canvasRef.current.clientWidth * window.devicePixelRatio;
      canvasRef.current.height =
        canvasRef.current.clientHeight * window.devicePixelRatio;
      gl.viewport(0, 0, canvasRef.current.width, canvasRef.current.height);
    }

    updateSize();
    // Watches the element, not just the window: the synced pianoRollSize
    // setting changes the canvas height without a window resize.
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(canvasRef.current);

    function clearPitchDetectionBuffers() {
      currentNoteIndex = 0;
      pitchPollers.forEach(([buffer, _1, _2]) => buffer.clear());
      // A seek invalidates the accumulator's forward-only note cursor, and a
      // performance that skipped part of the song can't be scored honestly
      // against the whole melody anyway, so start the tally over.
      props.scoreAccumulatorRef?.current?.reset();
    }

    props.videoRef.current.addEventListener(
      "seeked",
      clearPitchDetectionBuffers,
    );

    return () => {
      pitchPollers.forEach(([_1, _2, interval]) => clearInterval(interval));
      cancelAnimationFrame(animationFrameRequestRef.current);
      resizeObserver.disconnect();
      if (props.videoRef.current) {
        props.videoRef.current.removeEventListener(
          "seeked",
          clearPitchDetectionBuffers,
        );
      }
      // This effect tears down at each song's end (deps change) -- flush the
      // song's last samples before they're lost.
      if (probeFlushInterval !== null) clearInterval(probeFlushInterval);
      flushProbeBuffer();
    };
    // Only what the effect actually reads -- NOT `props` wholesale. The props
    // object is a fresh literal on every Player render, so depending on it
    // tore down and rebuilt this whole effect (new PitchDetectionBuffers, so
    // an empty `positions`) whenever any unrelated Player state changed.
    // `ducked` flips on every instrumental break via onBreakActiveChange, so
    // in practice the sung-pitch trail was erased several times a song, at
    // section boundaries, while the singer was mid-phrase.
  }, [
    props.scoringData,
    props.songId,
    props.videoRef,
    props.mics,
    props.pitchShiftSemis,
    props.scoreAccumulatorRef,
  ]);

  return (
    // Size 0 ("Off") hides the canvas with CSS rather than unmounting it:
    // the GL pipeline and mic pitch capture live in a one-shot effect that
    // expects the canvas to exist for the whole song.
    <canvas
      className="pianoRollRoll"
      style={{
        top: `${PIANO_ROLL_TOP_FRACTION * 100}%`,
        height: `${pianoRollSize * 100}%`,
        opacity:
          !props.visible || !melodyActive
            ? 0
            : props.ducked
              ? pianoRollOpacity * PIANO_ROLL_DUCK_FACTOR
              : pianoRollOpacity,
        display: pianoRollSize <= 0 ? "none" : undefined,
      }}
      ref={canvasRef}
    ></canvas>
  );
}
