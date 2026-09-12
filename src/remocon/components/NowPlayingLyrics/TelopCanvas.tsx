import React, { useEffect, useRef } from "react";

import { TelopLayout } from "../../../common/telopLayout";
import { loadTelopFont } from "../../telopFonts";
import TelopPainter from "./TelopPainter";

// A canvas that draws `layout` at lyricTime() every animation frame, sized to
// whatever box CSS gives it. lyricTime returns the telop time (the TV's media
// clock plus TELOP_TIMING_OFFSET_MS) or null while it isn't known yet.
const TelopCanvas = (props: {
  layout: TelopLayout;
  lyricTime: () => number | null;
  className?: string;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read by the frame loop, which lives in a once-per-layout effect.
  const lyricTimeRef = useRef(props.lyricTime);
  lyricTimeRef.current = props.lyricTime;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let frame = 0;
    const painter = new TelopPainter(canvas, props.layout);

    const fitToElement = () => {
      const { width, height } = canvas.getBoundingClientRect();
      painter.resize(width, height, window.devicePixelRatio || 1);
    };
    const observer = new ResizeObserver(fitToElement);
    observer.observe(canvas);
    fitToElement();

    // Until the TV's own face arrives the fallback draws; swap it in when it
    // does. Korean only when the song has a Korean glyph (font 1) in it.
    const needsKorean = props.layout.blocks.some((block) =>
      block.glyphs.some((glyph) => glyph.font === 1),
    );
    Promise.all([
      loadTelopFont("jp"),
      needsKorean ? loadTelopFont("kr") : Promise.resolve(),
    ]).then(() => {
      if (!disposed) painter.invalidate();
    });

    const tick = () => {
      const refreshTime = lyricTimeRef.current();
      painter.paint(refreshTime);
      // The telop time just drawn, left on the element for anyone debugging
      // sync from a devtools console (and the sync harness). A plain property
      // rather than an attribute, so it costs no DOM mutation per frame.
      (canvas as HTMLCanvasElement & { telopTime?: number | null }).telopTime =
        refreshTime;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      painter.dispose();
    };
  }, [props.layout]);

  return <canvas ref={canvasRef} className={props.className} />;
};

export default TelopCanvas;
