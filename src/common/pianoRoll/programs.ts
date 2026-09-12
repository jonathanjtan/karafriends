/* tslint:disable:max-classes-per-file */

// The piano roll's WebGL2 programs. Shared by the big screen and the phone's
// mirror of it, so both draw exactly the same notes, bands, cursor and trails.
// See geometry.ts for why this lives in common/.

import {
  PIANO_ROLL_CURSOR_FRACTION as CURSOR_FRACTION,
  PIANO_ROLL_TIME_WIDTH_SECS as TIME_WIDTH_SECS,
} from "../constants";
import { quadToTriangles } from "./geometry";
import midiVertShaderRaw from "./shaders/PianoRollMidi.vert.glsl";
import noteFragShaderRaw from "./shaders/PianoRollNote.frag.glsl";
import seekVertShaderRaw from "./shaders/PianoRollSeek.vert.glsl";
import singleColorFragShaderRaw from "./shaders/PianoRollSingleColor.frag.glsl";

export function loadShader(
  gl: WebGL2RenderingContext,
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

export abstract class ShaderProgram<T extends unknown[]> {
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly attributeLocations: { [name: string]: number };
  readonly uniformLocations: { [name: string]: WebGLUniformLocation };
  readonly buffers: { [name: string]: WebGLBuffer };
  // Vertex attribute state is global in GL, not per-program. All four programs
  // here bind their vec2 stream to attribute index 0, so whichever drew last
  // leaves that attribute pointing at its own buffer, and every draw has to
  // re-point it. A VAO records the wiring once and restores it in a single
  // bind.
  //
  // This is what the `if (gl.CURRENT_PROGRAM !== this.program)` guard that used
  // to wrap every draw was reaching for, and it never worked:
  // `gl.CURRENT_PROGRAM` is the enum constant 0x8B8D, never a WebGLProgram, so
  // the condition was always true and the setup ran every frame regardless.
  // Worth knowing before "fixing" it somewhere else: reading it properly (via
  // getParameter) would have made it *wrong* rather than merely redundant,
  // because of the global attribute state above.
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly shaders: WebGLShader[];

  constructor(
    gl: WebGL2RenderingContext,
    shaders: WebGLShader[],
    attributeNames: string[],
    uniformNames: string[],
    bufferNames: string[],
  ) {
    this.gl = gl;
    this.shaders = shaders;
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

    // Every program here draws one vec2 stream ("position") out of one buffer
    // ("positions"), so the wiring is identical for all of them.
    this.vertexArray = gl.createVertexArray()!;
    gl.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.positions);
    gl.vertexAttribPointer(
      this.attributeLocations.position,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
    gl.enableVertexAttribArray(this.attributeLocations.position);
    gl.bindVertexArray(null);
  }

  // Select this program and its attribute wiring. Uniforms that never change
  // are set once in each subclass's constructor instead of here: uniform state
  // belongs to the program object, so it survives from one draw to the next.
  protected use() {
    this.gl.useProgram(this.program);
    this.gl.bindVertexArray(this.vertexArray);
  }

  // The effect that owns these rebuilds per song, and again on every
  // pitch-shift change, on a canvas (and so a GL context) that outlives it.
  // Chromium does eventually collect unreferenced GL objects, but on its own
  // schedule; releasing them here makes it deterministic instead of leaving a
  // song's whole pipeline resident into the next one.
  dispose() {
    this.gl.deleteVertexArray(this.vertexArray);
    this.gl.deleteProgram(this.program);
    this.shaders.forEach((shader) => this.gl.deleteShader(shader));
    Object.values(this.buffers).forEach((buffer) =>
      this.gl.deleteBuffer(buffer),
    );
  }

  abstract draw(...args: T): void;
}

export class NoteProgram extends ShaderProgram<[number, number]> {
  readonly triangleCount: number;

  constructor(gl: WebGL2RenderingContext, positions: number[]) {
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

    gl.useProgram(this.program);
    gl.uniform1f(this.uniformLocations.timeWidth, TIME_WIDTH_SECS);
    gl.uniform1f(this.uniformLocations.cursorFraction, CURSOR_FRACTION);
  }

  draw(time: number, canvasWidth: number) {
    this.use();

    this.gl.uniform1f(this.uniformLocations.time, time);
    this.gl.uniform1f(this.uniformLocations.canvasWidth, canvasWidth);

    this.gl.drawArrays(this.gl.TRIANGLES, 0, this.triangleCount);
  }
}

export class SeekProgram extends ShaderProgram<[]> {
  readonly triangleCount: number;

  constructor(gl: WebGL2RenderingContext) {
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

    gl.useProgram(this.program);
    gl.uniform1f(this.uniformLocations.cursorFraction, CURSOR_FRACTION);
    gl.uniform4fv(this.uniformLocations.color, [0.9, 0.9, 0.9, 1.0]);
  }

  draw() {
    this.use();

    this.gl.drawArrays(this.gl.TRIANGLES, 0, this.triangleCount);
  }
}

export class PitchProgram extends ShaderProgram<[number, number, number[]]> {
  readonly color: [number, number, number];
  // The sung-pitch trace is the one stream that changes every frame, so it is
  // the one worth not re-allocating. `new Float32Array(positions)` on a plain
  // number array converts element by element and throws away ~67KB per mic per
  // frame; the trace tops out at a fixed length (PitchDetectionBuffer caps at
  // 200 samples), so a scratch array that grows a handful of times at the start
  // of a take and never again does the same job with no per-frame garbage.
  private scratch = new Float32Array(0);

  constructor(gl: WebGL2RenderingContext, color: [number, number, number]) {
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

    gl.useProgram(this.program);
    gl.uniform1f(this.uniformLocations.timeWidth, TIME_WIDTH_SECS);
    gl.uniform1f(this.uniformLocations.cursorFraction, CURSOR_FRACTION);
    gl.uniform4f(this.uniformLocations.color, ...this.color, 1.0);
  }

  draw(time: number, canvasWidth: number, positions: number[]) {
    this.use();

    this.gl.uniform1f(this.uniformLocations.time, time);

    // The ARRAY_BUFFER binding is global state, not part of the VAO: the VAO
    // records which buffer the attribute *reads*, but an upload still has to
    // name its target. Binding here rather than relying on some earlier call
    // having left the right buffer bound is what keeps each mic's trace out of
    // its neighbour's buffer.
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.positions);
    if (this.scratch.length < positions.length) {
      this.scratch = new Float32Array(Math.max(positions.length * 2, 4096));
      this.gl.bufferData(
        this.gl.ARRAY_BUFFER,
        this.scratch.byteLength,
        this.gl.DYNAMIC_DRAW,
      );
    }
    this.scratch.set(positions);
    this.gl.bufferSubData(
      this.gl.ARRAY_BUFFER,
      0,
      this.scratch,
      0,
      positions.length,
    );
    this.gl.drawArrays(this.gl.TRIANGLES, 0, positions.length / 2);
  }
}

export class FreeTimeProgram extends ShaderProgram<[number, number]> {
  readonly triangleCount: number;

  constructor(gl: WebGL2RenderingContext, positions: number[]) {
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

    gl.useProgram(this.program);
    gl.uniform1f(this.uniformLocations.timeWidth, TIME_WIDTH_SECS);
    gl.uniform1f(this.uniformLocations.cursorFraction, CURSOR_FRACTION);
    gl.uniform4fv(this.uniformLocations.color, [0, 0, 0, 0.5]);
  }

  draw(time: number, canvasWidth: number) {
    this.use();

    this.gl.uniform1f(this.uniformLocations.time, time);
    this.gl.uniform1f(this.uniformLocations.canvasWidth, canvasWidth);

    this.gl.drawArrays(this.gl.TRIANGLES, 0, this.triangleCount);
  }
}
