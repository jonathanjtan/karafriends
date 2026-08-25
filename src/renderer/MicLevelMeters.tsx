import convert from "color-convert";
import React, { useEffect, useRef } from "react";

import { linearToDbfs } from "../common/constants";
import "./MicLevelMeters.css";

// The meter's visible span. -60 dBFS sits comfortably under a quiet room's
// noise floor and 0 is full scale, so the FX-return bleed and a real singer
// both land somewhere readable instead of pinned at either end.
const METER_MIN_DBFS = -60;
const METER_MAX_DBFS = 0;

// Fast attack, slow release. Raw RMS at 40Hz flickers far too much to read a
// level off, but smoothing the attack as well would hide the transients being
// judged. The meter has to jump the instant someone sings.
const RELEASE_PER_FRAME = 0.88;

function dbfsToFraction(dbfs: number): number {
  const span = METER_MAX_DBFS - METER_MIN_DBFS;
  return Math.min(Math.max((dbfs - METER_MIN_DBFS) / span, 0), 1);
}

// Match PianoRoll's per-mic trace colors exactly, so a bar reads as "this is
// the one drawing blue" without the user having to map indices themselves.
export function micColor(micIndex: number, micCount: number): string {
  const [r, g, b] = convert.hsv.rgb([(360 / micCount) * micIndex, 30, 100] as [
    number,
    number,
    number,
  ]);
  return `rgb(${r}, ${g}, ${b})`;
}

// Live per-mic input levels with the gate threshold marked, so the threshold
// can be set by looking at the gap between bleed and voice rather than by
// guessing and watching the piano roll.
//
// Levels are published by PianoRoll (see its micLevelsRef prop) rather than
// polled here: getPitch() pops the native ring buffer, so a second poller
// would steal samples and degrade pitch detection for everyone. That means
// the meters are only live while a scored song is playing. Between songs
// nothing polls the mics and the bars sit at zero.
// `micCount` rather than the mics themselves: the popped-out settings window
// renders these meters too, and it only ever sees a count plus levels relayed
// over the bus, since the InputDevices live in the big screen's process.
export default function MicLevelMeters(props: {
  micCount: number;
  micLevelsRef: React.MutableRefObject<number[]>;
  threshold: number;
}) {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const displayedRef = useRef<number[]>([]);

  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      for (let i = 0; i < props.micCount; i++) {
        const level = props.micLevelsRef.current[i] ?? 0;
        const previous = displayedRef.current[i] ?? 0;
        const displayed =
          level > previous ? level : previous * RELEASE_PER_FRAME;
        displayedRef.current[i] = displayed;

        const bar = barRefs.current[i];
        if (bar) {
          // log10(0) is -Infinity; silence is the bottom of the scale.
          const dbfs = displayed > 0 ? linearToDbfs(displayed) : METER_MIN_DBFS;
          bar.style.width = `${dbfsToFraction(dbfs) * 100}%`;
        }
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.micCount, props.micLevelsRef]);

  if (props.micCount === 0) return null;

  const thresholdPercent = dbfsToFraction(linearToDbfs(props.threshold)) * 100;

  return (
    <div className="micLevelMeters">
      {[...Array(props.micCount)].map((_, i) => (
        <div className="micLevelMeterRow" key={i}>
          <span className="micLevelMeterLabel">{i}</span>
          <div className="micLevelMeterTrack">
            <div
              className="micLevelMeterBar"
              ref={(el) => {
                barRefs.current[i] = el;
              }}
              style={{ backgroundColor: micColor(i, props.micCount) }}
            />
            <div
              className="micLevelMeterThreshold"
              style={{ left: `${thresholdPercent}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
