// One song's piano roll on one canvas: the note quads, the free-time bands,
// the "now" cursor, and a sung-pitch trail per mic.
//
// Both surfaces drive this. The big screen feeds it raw pitch estimates from
// the mics it owns (pushPitch); the remocon's lyrics panel feeds it the values
// the big screen already plotted, mirrored over GraphQL (pushPitchValue). The
// drawing itself happens in exactly one place so the phone can't drift from
// the TV.

import convert from "color-convert";

import {
  midiNumberToYCoord,
  PitchDetectionBuffer,
  quadToTriangles,
} from "./geometry";
import { PianoRollLayout } from "./layout";
import {
  FreeTimeProgram,
  NoteProgram,
  PitchProgram,
  SeekProgram,
} from "./programs";

export class PianoRollScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly layout: PianoRollLayout;
  private readonly noteProgram: NoteProgram;
  private readonly seekProgram: SeekProgram;
  private readonly freeTimeProgram: FreeTimeProgram;
  private readonly hasNotes: boolean;
  private readonly hasFreeTime: boolean;
  private readonly pitchTrails: {
    buffer: PitchDetectionBuffer;
    program: PitchProgram;
  }[];
  // Where in the guide melody the most recent pitch estimate landed. Shared by
  // every mic (they are all singing the same song) and rewound whenever the
  // trails are cleared.
  private currentNoteIndex = 0;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    layout: PianoRollLayout,
    micCount: number,
  ) {
    this.canvas = canvas;
    this.layout = layout;
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      premultipliedAlpha: false,
    })!;
    this.gl = gl;

    const { medianMidiNumber, spanSemis } = layout;

    const notePositions = layout.notes
      .map((note) =>
        quadToTriangles(
          note.startTime,
          midiNumberToYCoord(note.midiNumber + 1, medianMidiNumber, spanSemis),
          note.endTime,
          midiNumberToYCoord(note.midiNumber - 1, medianMidiNumber, spanSemis),
        ),
      )
      .flat();

    const freeTimePositions = layout.freeTimeIntervals
      .map(({ startTime, endTime }) =>
        quadToTriangles(startTime, 1.0, endTime, 0.0),
      )
      .flat();

    this.hasNotes = notePositions.length > 0;
    this.hasFreeTime = freeTimePositions.length > 0;

    this.noteProgram = new NoteProgram(gl, notePositions);
    this.seekProgram = new SeekProgram(gl);
    this.freeTimeProgram = new FreeTimeProgram(gl, freeTimePositions);

    this.pitchTrails = Array.from({ length: micCount }, (_, i) => ({
      buffer: new PitchDetectionBuffer(spanSemis),
      program: new PitchProgram(
        gl,
        convert.hsv
          .rgb([(360 / micCount) * i, 30, 100])
          .map((channel) => channel / 255) as [number, number, number],
      ),
    }));

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    this.resize();
  }

  // A raw detected pitch from a mic this process owns. Folds it onto the
  // octave of the note being sung, and returns the value it plotted so the big
  // screen can mirror exactly that to the phones.
  pushPitch(micIndex: number, pitchMidiNumber: number, time: number): number {
    const trail = this.pitchTrails[micIndex];
    const { notes, medianMidiNumber } = this.layout;
    if (!trail || notes.length === 0) return pitchMidiNumber;

    while (
      notes[this.currentNoteIndex].endTime < time &&
      this.currentNoteIndex < notes.length - 2
    ) {
      this.currentNoteIndex++;
    }

    return trail.buffer.push(
      pitchMidiNumber,
      medianMidiNumber,
      notes[this.currentNoteIndex].midiNumber,
      time,
    );
  }

  // A value another process already folded and plotted.
  pushPitchValue(micIndex: number, value: number, time: number) {
    const trail = this.pitchTrails[micIndex];
    if (!trail) return;
    trail.buffer.pushValue(value, this.layout.medianMidiNumber, time);
  }

  clearPitch() {
    this.currentNoteIndex = 0;
    this.pitchTrails.forEach(({ buffer }) => buffer.clear());
  }

  // Matches the backing store to the element's CSS box. Cheap enough to call
  // from a ResizeObserver on every change.
  resize() {
    if (this.disposed) return;
    this.canvas.width = this.canvas.clientWidth * window.devicePixelRatio;
    this.canvas.height = this.canvas.clientHeight * window.devicePixelRatio;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // Draws the roll at media time `time`. Returns whether that time is inside
  // (or a second ahead of) a "pog" window, which the big screen turns into a
  // glow; the phone ignores it.
  draw(time: number): boolean {
    if (this.disposed) return false;
    const canvasWidth = this.canvas.width;

    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    if (this.hasFreeTime) this.freeTimeProgram.draw(time, canvasWidth);
    if (this.hasNotes) this.noteProgram.draw(time, canvasWidth);

    this.pitchTrails.forEach(({ buffer, program }) => {
      if (buffer.positions.length > 0) {
        program.draw(time, canvasWidth, buffer.positions);
      }
    });

    this.seekProgram.draw();

    return this.layout.pogIntervals.some(
      ({ startTime, endTime }) => time >= startTime - 1 && time <= endTime,
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pitchTrails.forEach(({ program }) => program.dispose());
    this.noteProgram.dispose();
    this.seekProgram.dispose();
    this.freeTimeProgram.dispose();
  }
}
