// The piano roll's geometry: where a note sits, how wide the vertical window
// is, and how a run of pitch estimates becomes a stroked trail.
//
// Shared because the roll is drawn twice: on the big screen (renderer's
// PianoRoll.tsx, from live mic pitch) and on the phone inside the remocon's
// lyrics panel (from the TV's mirrored trace). Same reasoning as
// common/telopLayout.ts: change how the roll is laid out only in here, or the
// phone stops matching the TV.

import Spline from "cubic-spline";
import vec from "gl-vec2";
import getNormals from "polyline-normals";

// How many spline samples a three-estimate segment of the sung-pitch trail is
// drawn with.
export const PITCH_RESOLUTION = 8;
export const STROKE_WIDTH = 0.03;

// The roll's default vertical window: 18 rows behind the canvas, and notes can
// align in-between rows, so 36 positions, +/-18 semitones around the median.
// Every real song fits inside this, and it stays the exact historical geometry.
export const DEFAULT_SPAN_SEMIS = 36;

export function edgesToTriangles(top: number[][], bottom: number[][]) {
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

export function quadToTriangles(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  /*
    (x0, y0) - (x1, y0)
       |     \    |
    (x0, y1) - (x1, y1)

    GL requires triangles listed in counter-clockwise order
  */
  return [x0, y0, x0, y1, x1, y1, x0, y0, x1, y1, x1, y0];
}

export function median(nums: number[]) {
  const numsSorted = [...nums];
  // Numeric, not the default lexicographic sort: MIDI numbers happen to all be
  // two digits for real songs, which is the only reason the bare sort() this
  // replaces gave the right answer. A single value at 100 or above (or below
  // 10) would have silently mis-centred the whole roll.
  numsSorted.sort((a, b) => a - b);
  const middleIndex = Math.floor(nums.length / 2);
  if (nums.length % 2 === 0) {
    return (numsSorted[middleIndex - 1] + numsSorted[middleIndex]) / 2;
  } else {
    return numsSorted[middleIndex];
  }
}

// How tall a window this note set needs, in semitones. Never narrower than the
// default, so songs are laid out exactly as they always were; wider only when
// something genuinely does not fit.
//
// The guided range exercise is what needs this: it walks the whole plausible
// vocal range (E2..C6, 44 semitones) so that nobody's measurement is cut short
// by a preset they chose before knowing their range. At a fixed 36 its
// extremes, the entire point of the test, were clipped off the top and bottom
// of the canvas by PianoRollMidi.vert.glsl, which discards anything outside
// y 0..1.
export function spanSemisFor(
  midiNumbers: number[],
  medianMidiNumber: number,
): number {
  if (midiNumbers.length === 0) return DEFAULT_SPAN_SEMIS;
  const furthest = Math.max(
    ...midiNumbers.map((midi) => Math.abs(midi - medianMidiNumber)),
  );
  // +1 for the semitone of note thickness either side, +1 of breathing room.
  return Math.max(DEFAULT_SPAN_SEMIS, Math.ceil(2 * (furthest + 2)));
}

export function midiNumberToYCoord(
  midiNumber: number,
  medianMidiNumber: number,
  spanSemis: number = DEFAULT_SPAN_SEMIS,
) {
  // Positions correspond to the center of a bar or in-between two bars. The
  // median MIDI number sits dead-center.
  return 0.5 + (midiNumber - medianMidiNumber) / spanSemis;
}

// Octave rails: which C's are visible, and where.
//
// The roll's vertical axis floats. It is relative to the song's median note,
// with no clef and no absolute reference, so without these there is nothing
// on screen that says which octave anything is in. They are informational only:
// the sung-pitch trace is still octave-folded onto the guide (that is what
// keeps it readable), and scoring is still octave-blind on purpose, because
// singing in your own comfortable octave is normal and must not cost points.
//
// PianoRollMidi.vert.glsl maps y through `y * 2 - 1`, so the visible window is
// exactly y 0..1, which is +/-spanSemis/2 around the median.
export function octaveRails(medianMidiNumber: number, spanSemis: number) {
  const rails: { midi: number; topPercent: number }[] = [];
  const lowest = Math.ceil(medianMidiNumber - spanSemis / 2);
  const highest = Math.floor(medianMidiNumber + spanSemis / 2);
  for (let midi = lowest; midi <= highest; midi++) {
    if (midi % 12 !== 0) continue; // C's only, one label per octave
    const y = midiNumberToYCoord(midi, medianMidiNumber, spanSemis);
    if (y < 0.02 || y > 0.98) continue; // would be clipped at the edge
    // y is bottom-up in GL, top-down in CSS.
    rails.push({ midi, topPercent: (1 - y) * 100 });
  }
  return rails;
}

// One mic's sung-pitch trail: the estimates it has contributed lately, and the
// triangle strip they were turned into.
export class PitchDetectionBuffer {
  buffer: { time: number; value: number }[] = [];
  positions: number[] = [];
  pitchOffset: number = 0;
  // The roll's vertical window for this song, in semitones. Constant for the
  // buffer's life (it is rebuilt per song), so it is held here rather than
  // threaded through every push.
  readonly spanSemis: number;

  constructor(spanSemis: number) {
    this.spanSemis = spanSemis;
  }

  // A raw detected pitch, folded onto the octave of the note being sung and
  // appended. `currentMidiNumber` is the guide note at `time`.
  // Returns the folded value it plotted, which is what the big screen mirrors
  // to the phones.
  push(
    pitchMidiNumber: number,
    medianMidiNumber: number,
    currentMidiNumber: number,
    time: number,
  ): number {
    this.pitchOffset +=
      Math.round(
        (currentMidiNumber - (pitchMidiNumber + this.pitchOffset)) / 12,
      ) * 12;

    const value = pitchMidiNumber + this.pitchOffset;
    this.pushValue(value, medianMidiNumber, time);
    return value;
  }

  // An already-folded value, appended as-is. This is the half the phone uses:
  // the TV mirrors the value it plotted rather than the raw estimate, so a
  // phone joining mid-song doesn't have to re-converge an octave offset of its
  // own and draw a trail an octave off the TV's for the first few notes.
  pushValue(
    pitchMidiNumberOffset: number,
    medianMidiNumber: number,
    time: number,
  ) {
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

      // Without 3 points to spline, or too large a time/pitch gap between
      // points, draw the current point as is.
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
          midiNumberToYCoord(obj.value, medianMidiNumber, this.spanSemis),
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
