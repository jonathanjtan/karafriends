import React, { useEffect, useRef } from "react";

/* tslint:disable:no-submodule-imports no-implicit-dependencies */
import { ScoreResult } from "../common/scoring";
import { InstrumentalBreak } from "../common/scoringData";
/* tslint:enable:no-submodule-imports no-implicit-dependencies */

// The performance replayed as a note chart: one mark per reference note, pitch
// on the vertical, time across, coloured by how well it landed. The point is
// that it's the same shape the singer just spent four minutes watching scroll
// past on the piano roll, so it reads without a legend -- where the good
// singing was is visible before any number is.
//
// Canvas rather than SVG: a song is 200-900 notes, and this is generative
// drawing rather than markup worth putting in the DOM.

// Credit at or above this is a hit, above the next is close, below is missed.
// Matches nothing in scoring.ts on purpose -- these are display buckets for a
// continuous value, not thresholds the score depends on.
const HIT_CREDIT = 0.75;
const CLOSE_CREDIT = 0.45;

// From PianoRollNote.frag.glsl's note green, softened so it can hold area, and
// ScoreCard.css's band gold. Green reads as "on the note" everywhere else in
// this app, so it means that here too.
const COLOR_HIT = "#5dff9b";
const COLOR_CLOSE = "#ffd34d";
const COLOR_MISS = "#ff6b81";
const COLOR_UNSUNG = "rgba(127, 168, 217, 0.22)";
const COLOR_WINDOW_LINE = "rgba(185, 214, 255, 0.85)";
const COLOR_RAIL = "rgba(127, 168, 217, 0.16)";
const COLOR_BREAK = "rgba(127, 168, 217, 0.07)";
const COLOR_LABEL = "rgba(123, 129, 163, 0.9)";

// Vertical split: notes in the upper region, the 24-window average in a band
// below it, so the two readings don't overlap.
const PAD_TOP_FRACTION = 0.05;
const PAD_BOTTOM_FRACTION = 0.24;
// A semitone of reference range costs this much of the note region's height;
// the rest is padding so the top and bottom notes aren't clipped.
const PITCH_PADDING_SEMIS = 2;

export function creditColor(credit: number): string {
  if (credit >= HIT_CREDIT) return COLOR_HIT;
  if (credit >= CLOSE_CREDIT) return COLOR_CLOSE;
  return COLOR_MISS;
}

// Counts for the legend. Exported so the card can label the legend with the
// same buckets the drawing uses rather than recomputing them differently.
export function ribbonCounts(result: ScoreResult) {
  let hit = 0;
  let close = 0;
  let missed = 0;
  let unsung = 0;
  let run = 0;
  let bestRun = 0;
  for (const note of result.notes) {
    if (note.credit === null) {
      unsung++;
      run = 0;
    } else if (note.credit >= HIT_CREDIT) {
      hit++;
      run++;
      bestRun = Math.max(bestRun, run);
    } else if (note.credit >= CLOSE_CREDIT) {
      close++;
      run = 0;
    } else {
      missed++;
      run = 0;
    }
  }
  return { hit, close, missed, unsung, bestRun };
}

export default function NoteRibbon(props: {
  result: ScoreResult;
  breaks: readonly InstrumentalBreak[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      // The card animates in from a transform; on the first frame the element
      // can still be laid out at zero.
      if (width === 0 || height === 0) return;

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const { result, breaks } = props;
      const padTop = height * PAD_TOP_FRACTION;
      const padBottom = height * PAD_BOTTOM_FRACTION;
      const plotHeight = height - padTop - padBottom;
      const lo = result.pitchLo - PITCH_PADDING_SEMIS;
      const hi = result.pitchHi + PITCH_PADDING_SEMIS;
      const span = Math.max(1, hi - lo);
      const yFor = (midi: number) =>
        padTop + plotHeight * (1 - (midi - lo) / span);

      // Octave rails, echoing the piano roll's striped background so the two
      // read as the same instrument.
      for (let midi = Math.ceil(lo); midi <= hi; midi++) {
        if (midi % 12 !== 0) continue;
        ctx.fillStyle = COLOR_RAIL;
        ctx.fillRect(0, yFor(midi), width, 1);
      }

      // Instrumental breaks, shaded and labelled. Positioned from absolute
      // seconds against the same window the notes were positioned in.
      const windowSpan = result.windowEndSecs - result.windowStartSecs;
      if (windowSpan > 0) {
        for (const gap of breaks) {
          const x0 =
            ((gap.startTime - result.windowStartSecs) / windowSpan) * width;
          const x1 =
            ((gap.endTime - result.windowStartSecs) / windowSpan) * width;
          if (x1 <= 0 || x0 >= width) continue;
          const left = Math.max(0, x0);
          const right = Math.min(width, x1);
          ctx.fillStyle = COLOR_BREAK;
          ctx.fillRect(left, padTop, right - left, plotHeight);
          if (right - left > width * 0.06) {
            ctx.fillStyle = COLOR_LABEL;
            ctx.font = `${Math.max(8, height * 0.075)}px ui-monospace, Menlo, monospace`;
            ctx.textAlign = "center";
            ctx.fillText(
              `間奏 ${gap.approxDurationSecs}s`,
              (left + right) / 2,
              padTop + plotHeight * 0.5,
            );
          }
        }
      }

      // The notes.
      const minWidth = Math.max(1.5, width * 0.0016);
      const noteHeight = Math.max(2.5, (plotHeight / span) * 0.85);
      for (const note of result.notes) {
        const x = note.x * width;
        const w = Math.max(minWidth, note.width * width);
        const y = yFor(note.midiNumber);
        if (note.credit === null) {
          // A thin ghost rather than nothing: the melody's shape should still
          // be readable through a phrase nobody sang.
          ctx.fillStyle = COLOR_UNSUNG;
          ctx.fillRect(x, y - noteHeight / 2, w, Math.max(1, noteHeight * 0.4));
          continue;
        }
        ctx.fillStyle = creditColor(note.credit);
        // Brightness carries the credit within a bucket, so the colour bands
        // don't flatten a continuous value into three steps.
        ctx.globalAlpha = 0.45 + 0.55 * note.credit;
        ctx.fillRect(x, y - noteHeight / 2, w, noteHeight);
        ctx.globalAlpha = 1;
      }

      // The 24-window average along the bottom, so the old graph's reading
      // survives the redesign.
      const baseline = height - padBottom * 0.18;
      const windowY = (value: number) => baseline - value * (padBottom * 0.72);
      ctx.beginPath();
      let started = false;
      result.buckets.forEach((value, i) => {
        if (value === null) {
          started = false;
          return;
        }
        const x = ((i + 0.5) / result.buckets.length) * width;
        const y = windowY(value);
        if (started) {
          ctx.lineTo(x, y);
        } else {
          ctx.moveTo(x, y);
          started = true;
        }
      });
      ctx.strokeStyle = COLOR_WINDOW_LINE;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();
      result.buckets.forEach((value, i) => {
        if (value === null) return;
        ctx.beginPath();
        ctx.arc(
          ((i + 0.5) / result.buckets.length) * width,
          windowY(value),
          Math.max(2, height * 0.022),
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = "#b9d6ff";
        ctx.fill();
      });

      ctx.fillStyle = COLOR_RAIL;
      ctx.fillRect(0, baseline, width, 1);
      ctx.fillStyle = COLOR_LABEL;
      ctx.font = `${Math.max(8, height * 0.055)}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "left";
      ctx.fillText("24 WINDOWS", 0, height - 1);
      ctx.textAlign = "right";
      ctx.fillText("PITCH OVER TIME", width, height - 1);
    };

    draw();
    // The card is sized in vh and fades in under a transform, so its width
    // settles after mount and changes with the window.
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [props]);

  return <canvas className="scoreCardRibbon" ref={canvasRef} />;
}
