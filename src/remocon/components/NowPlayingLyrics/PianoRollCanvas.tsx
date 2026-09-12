import React, { useEffect, useMemo, useRef } from "react";

import { octaveRails } from "../../../common/pianoRoll/geometry";
import { PianoRollLayout } from "../../../common/pianoRoll/layout";
import "../../../common/pianoRoll/pianoRoll.css";
import { PianoRollScene } from "../../../common/pianoRoll/scene";
import usePitchTrace from "../../hooks/usePitchTrace";
import * as styles from "./NowPlayingLyrics.module.scss";

interface RollStyleVars extends React.CSSProperties {
  "--piano-roll-span": number;
}

// The big screen's piano roll, on the phone: the same scene, built from the
// layout the TV published and fed the sung-pitch values the TV plotted, drawn
// against the same clock the lyrics above it use.
//
// Nothing here decides what the roll looks like. That is all in
// common/pianoRoll/, which the big screen draws from too.
const PianoRollCanvas = (props: {
  songKey: string;
  layout: PianoRollLayout;
  micCount: number;
  // The TV's media position in seconds, or null while it isn't known yet.
  rollTime: () => number | null;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PianoRollScene | null>(null);
  // Which run of the trail the scene holds. The TV bumps this whenever it
  // clears its own (a seek), so a phone that kept appending would stitch the
  // new position onto the old trail.
  const generationRef = useRef<number | null>(null);
  // Read by the frame loop, which lives in a once-per-layout effect.
  const rollTimeRef = useRef(props.rollTime);
  rollTimeRef.current = props.rollTime;

  const rails = useMemo(
    () => octaveRails(props.layout.medianMidiNumber, props.layout.spanSemis),
    [props.layout],
  );

  usePitchTrace(props.songKey, (batch) => {
    const scene = sceneRef.current;
    if (scene === null) return;
    if (generationRef.current !== batch.generation) {
      generationRef.current = batch.generation;
      scene.clearPitch();
    }
    batch.mics.forEach(({ index, samples }) => {
      for (let i = 0; i + 1 < samples.length; i += 2) {
        scene.pushPitchValue(index, samples[i + 1], samples[i]);
      }
    });
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = new PianoRollScene(canvas, props.layout, props.micCount);
    sceneRef.current = scene;
    generationRef.current = null;

    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);

    let frame = 0;
    const tick = () => {
      const time = rollTimeRef.current();
      // Nothing to draw against until the TV's clock has landed. Holding the
      // last frame beats scrolling the roll off a guess.
      if (time !== null) scene.draw(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [props.layout, props.micCount]);

  const rollStyleVars: RollStyleVars = {
    "--piano-roll-span": props.layout.spanSemis,
  };

  return (
    <div className={styles.rollStage}>
      <canvas
        className="pianoRollRoll"
        style={{ ...rollStyleVars, top: 0, height: "100%" }}
        ref={canvasRef}
      />
      {rails.length > 0 ? (
        <div className="pianoRollRails" style={{ top: 0, height: "100%" }}>
          {rails.map(({ midi, topPercent }) => (
            <div
              key={midi}
              className="pianoRollRail"
              style={{ top: `${topPercent}%` }}
            >
              <span className="pianoRollRailLabel">{`C${midi / 12 - 1}`}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default PianoRollCanvas;
