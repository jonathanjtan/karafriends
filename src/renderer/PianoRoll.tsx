import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_MIC_RMS_GATE_THRESHOLD,
  PIANO_ROLL_CURSOR_FRACTION as CURSOR_FRACTION,
  PIANO_ROLL_LOOKAHEAD_SECS,
  PIANO_ROLL_TIME_WIDTH_SECS as TIME_WIDTH_SECS,
  PIANO_ROLL_TOP_FRACTION,
} from "../common/constants";
import useMicRmsGateEnabled from "../common/hooks/useMicRmsGateEnabled";
import useMicRmsGateThreshold from "../common/hooks/useMicRmsGateThreshold";
import usePianoRollOpacity from "../common/hooks/usePianoRollOpacity";
import usePianoRollSize from "../common/hooks/usePianoRollSize";
import { MicGate } from "../common/micGate";
import { DEFAULT_SPAN_SEMIS, octaveRails } from "../common/pianoRoll/geometry";
import { buildPianoRollLayout } from "../common/pianoRoll/layout";
import "../common/pianoRoll/pianoRoll.css";
import { PianoRollScene } from "../common/pianoRoll/scene";
import { ScoreAccumulator } from "../common/scoring";
import { RangeAccumulator } from "../common/vocalRange";
import MediaClock from "./mediaClock";
import { InputDevice } from "./nativeAudio";
import { PitchTracePublisher, publishSongPianoRoll } from "./pianoRollMirror";

// The visible window is TIME_WIDTH_SECS wide, with "now" pinned at
// CURSOR_FRACTION from the left edge; notes scroll right-to-left past it.
// 0.3 * 7s leaves ~4.9s of upcoming notes visible (matching the old
// page-at-a-time view) plus ~2.1s of trailing pitch-detection history. How all
// of that is drawn lives in common/pianoRoll/, because the remocon's lyrics
// panel draws the same roll from the same code.
//
// How much to dim the roll during an announced instrumental break.
const PIANO_ROLL_DUCK_FACTOR = 0.15;

interface RollStyleVars extends React.CSSProperties {
  "--piano-roll-span": number;
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
  // The warm-up's counterpart to scoreAccumulatorRef, owned by Player for the
  // same reason. Only one of the two is ever non-null: a warm-up measures a
  // range and is not scored, a song is scored and measures no range.
  rangeAccumulatorRef?: React.MutableRefObject<RangeAccumulator | null>;
  // Latest RMS per mic, indexed like `mics`, for the settings-panel level
  // meters. This has to be published from here rather than polled separately:
  // getPitch() *pops* the native ring buffer, so a second poller would steal
  // samples from this one and degrade pitch detection for everyone. A ref
  // rather than state, since it updates at 40Hz per mic and must not re-render
  // the big screen.
  micLevelsRef?: React.MutableRefObject<number[]>;
  // The queue entry the <video> is playing (queueItemKey), so the roll this
  // component draws can be published to main under the right song for the
  // remocon's lyrics panel to mirror. A ref because Player sets it before the
  // source swap, ahead of the render that brings the new song's data here.
  songKeyRef?: React.MutableRefObject<string | null>;
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
  // Same reasoning, and doubly so here: the threshold is meant to be dialled
  // in mid-song against a live room, so it has to take effect without waiting
  // for the next song to rebuild the pipeline.
  const { micRmsGateThreshold } = useMicRmsGateThreshold();
  const micRmsGateThresholdRef = useRef(DEFAULT_MIC_RMS_GATE_THRESHOLD);
  micRmsGateThresholdRef.current = micRmsGateThreshold;

  // Everything about this song's roll that isn't per-frame: the notes with the
  // key shift folded in, the bands, and the vertical window. Derived once and
  // shared by the rail overlay, the fade gate and the GL scene, so all three
  // are guaranteed to agree, and it is exactly what gets mirrored to the
  // phones. Null when the song has no guide melody to draw.
  const layout = useMemo(
    () => buildPianoRollLayout(props.scoringData, props.pitchShiftSemis),
    [props.scoringData, props.pitchShiftSemis],
  );

  // Which octaves are on screen, and where. Plain DOM over the canvas, so it
  // must not depend on the GL pipeline being rebuilt.
  const { rails, spanSemis } = useMemo(() => {
    if (layout === null) return { rails: [], spanSemis: DEFAULT_SPAN_SEMIS };
    return {
      rails: octaveRails(layout.medianMidiNumber, layout.spanSemis),
      spanSemis: layout.spanSemis,
    };
  }, [layout]);

  // Hand the phones the roll this screen is about to draw. Republished on
  // every key change, since the shift is baked into the layout.
  useEffect(() => {
    const songKey = props.songKeyRef?.current;
    if (!songKey) return;
    publishSongPianoRoll(songKey, layout, props.mics.length);
    // props.mics.length, not props.mics: all this reads is how many trails the
    // phone has to colour, and a fresh array on an unrelated Player render
    // would otherwise republish kilobytes of notes for nothing.
  }, [layout, props.mics.length, props.songKeyRef]);

  useEffect(() => {
    const video = props.videoRef.current;
    if (!video || layout === null) return;
    const { notes } = layout;

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
    // fresh literal each time. See the effect below, where that was
    // silently wiping the sung-pitch trail mid-song.
  }, [layout, props.videoRef]);

  useEffect(() => {
    if (!canvasRef.current || !props.videoRef.current || layout === null) {
      return;
    }

    // Read once, not per sample: the pitch-probe capture is a calibration aid,
    // and the poll loop is hot. Toggle with config.yaml's pitchProbeEnabled.
    // The renderer is the big-screen window, so a config flag is far easier to
    // reach than its devtools localStorage, and it lives beside the
    // micLatencyCalibrationMs the capture is used to set.
    const pitchProbeEnabled =
      window.karafriends.karafriendsConfig().pitchProbeEnabled === true;
    // The gate capture is the same idea one layer earlier: every frame the
    // detector produced, with the level it was judged on and the verdict, so a
    // candidate gate can be replayed offline against a real night instead of
    // being argued about. Separate flag rather than riding on pitchProbeEnabled
    // because it logs every frame from every mic rather than the accepted ones,
    // which is several times the volume, and the two captures are wanted at
    // different times.
    const micGateProbeEnabled =
      window.karafriends.karafriendsConfig().micGateProbeEnabled === true;
    // Captured here (not read per sample): this effect rebuilds per song, in
    // lockstep with scoringData, so props.songId is constant for its lifetime.
    const probeSongId = props.songId;
    // Samples are batched here and flushed via main to the per-day probe log
    // in the app's data dir (probe-logs/, beside config.yaml), rather than
    // console.logged: that way calibration data collects from the packaged app
    // just by enabling the flag, with no terminal or stdout capture, which a
    // Finder-launched .app has no way to provide.
    const probeBuffer: string[] = [];
    let probeFlushInterval: ReturnType<typeof setInterval> | null = null;
    const flushProbeBuffer = () => {
      if (probeBuffer.length > 0) {
        window.karafriends.appendProbeLog(probeBuffer.splice(0));
      }
    };
    if (pitchProbeEnabled || micGateProbeEnabled) {
      // Startup breadcrumb so anyone calibrating can confirm the flag took
      // effect before singing a whole song for nothing. One line per capture,
      // each naming the record type it writes: they are enabled separately,
      // and docs/scoring-tuning-handoff.md tells the reader to look for the
      // PROBE_PITCH one by name.
      if (pitchProbeEnabled) {
        console.log(
          `PROBE_PITCH capture enabled (config.pitchProbeEnabled), song ${probeSongId}`,
        );
      }
      if (micGateProbeEnabled) {
        console.log(
          `PROBE_FRAME capture enabled (config.micGateProbeEnabled), song ${probeSongId}`,
        );
      }
      probeFlushInterval = setInterval(flushProbeBuffer, 2000);
    }

    // Every note quad, band and trail this song draws, on this canvas. The
    // remocon's lyrics panel builds the same scene from the layout published
    // above, so anything about how the roll looks belongs in common/pianoRoll/
    // rather than here.
    const scene = new PianoRollScene(
      canvasRef.current,
      layout,
      props.mics.length,
    );

    // The samples the scene plots, on their way to any phone showing the roll.
    // Null when this song isn't mirrorable (nothing is playing under a key).
    const songKey = props.songKeyRef?.current ?? null;
    const tracePublisher =
      songKey === null ? null : new PitchTracePublisher(songKey);

    // One gate per mic, since each channel has its own level and its own
    // reason to be open. Held here rather than in a ref because the state is
    // only meaningful for a continuous run of audio, and this effect's
    // lifetime is exactly one song.
    const micGates = props.mics.map(() => new MicGate());

    function pollPitch(mic: InputDevice | null, micIndex: number) {
      if (!mic || !props.videoRef.current) return;
      // A batch, oldest first: the detector slides its window every 10ms while
      // this poll runs every 25ms and late besides, so one call collects
      // several readings. Each carries how far back it sits, which is what
      // keeps them at the times they were sung instead of collapsing onto the
      // instant they were collected.
      const estimates = mic.getPitches();
      if (estimates.length === 0) return;

      // Publish the newest level before the gate can discard anything. The
      // whole point of the meter is to show what the gate is rejecting.
      const newest = estimates[estimates.length - 1];
      if (props.micLevelsRef && typeof newest.rms === "number") {
        props.micLevelsRef.current[micIndex] = newest.rms;
      }

      const videoTime = props.videoRef.current.currentTime;
      if (props.videoRef.current.paused) return;

      for (const { ageMs, midiNumber, confidence, rms } of estimates) {
        // Where this reading actually happened, not where the poll landed.
        // Read before the gate rather than after it, because the gate's hold
        // is measured in audio time and the probe below records rejections,
        // which have no other timestamp.
        const sampleTime = videoTime - ageMs / 1000;

        // Confidence can't catch quiet-but-periodic bleed (YIN normalizes
        // amplitude away), so the gate is a level test instead, with
        // hysteresis and a hold so that a dip inside a phrase doesn't punch a
        // hole through the middle of a note (see MicGate). rms is undefined
        // when the native addon predates the rms field (Parcel can reuse a
        // cached index.node); the gate is then inert rather than gating
        // everything.
        let gateOpen: boolean;
        if (!micRmsGateEnabledRef.current || typeof rms !== "number") {
          // Reset rather than merely skip, so that switching the gate off and
          // back on mid-song doesn't resume from a stale "open".
          micGates[micIndex].reset();
          gateOpen = true;
        } else {
          gateOpen = micGates[micIndex].accepts(
            rms,
            sampleTime,
            micRmsGateThresholdRef.current,
          );
        }

        // Every frame the detector produced, gated or not, with what the gate
        // judged it on. Off unless config.micGateProbeEnabled is set; see
        // pitchProbeEnabled's note for why this goes to the probe log rather
        // than the console. One line per frame per mic:
        //   PROBE_FRAME <songId> <mic> <time> <midi> <confidence> <rms> <0|1>
        // rms is linear full-scale, or "nan" from an addon predating the
        // field; the trailing flag is the *level gate's* verdict alone, so
        // that the confidence and midi filters below stay reconstructible
        // offline rather than being baked into the capture.
        if (micGateProbeEnabled) {
          probeBuffer.push(
            `PROBE_FRAME ${probeSongId} ${micIndex} ${sampleTime.toFixed(4)} ${midiNumber.toFixed(3)} ${confidence.toFixed(3)} ${typeof rms === "number" ? rms.toFixed(6) : "nan"} ${gateOpen ? 1 : 0}`,
          );
        }

        if (!gateOpen) continue;
        if (confidence < 0.8 || midiNumber === 0) continue;

        // The scene folds the reading onto the octave of the note being sung
        // and hands back the value it plotted, which is exactly what the
        // phones mirror: they append it as-is rather than re-deriving an
        // octave offset of their own from a partial trail.
        const plotted = scene.pushPitch(micIndex, midiNumber, sampleTime);
        tracePublisher?.add(micIndex, sampleTime, plotted);
        // Latency-calibration capture, off unless config.pitchProbeEnabled is
        // set (checked once when this effect ran, see pitchProbeEnabled). Each
        // accepted sample is buffered as
        //   PROBE_PITCH <songId> <videoTime> <midi> <shift>
        // and flushed to probe-logs/probe-<date>.log; the songId tag lets that
        // log be split by song. Feed it to scripts/replayScoring.mjs.
        if (pitchProbeEnabled) {
          probeBuffer.push(
            `PROBE_PITCH ${probeSongId} ${sampleTime.toFixed(4)} ${midiNumber.toFixed(3)} ${props.pitchShiftSemis}`,
          );
        }
        // Every open mic feeds one accumulator, so whoever is singing counts.
        // Duplicate samples from mic bleed are deduplicated by frame slot
        // inside placeSamples, so extra mics can't inflate coverage. rms rides
        // along on the trace (nothing scores it yet); it is undefined on an
        // addon that predates the field, which addSample records as null
        // rather than as a level of zero.
        props.scoreAccumulatorRef?.current?.addSample(
          sampleTime,
          midiNumber,
          props.pitchShiftSemis,
          rms,
        );
        // The warm-up's measurement. Fed from the same accepted samples so the
        // range is measured on exactly what the roll drew. Note that the
        // estimator applies its own, unfolded acceptance test against the known
        // target, which is the whole reason a guided exercise can measure a
        // range where a song take cannot.
        props.rangeAccumulatorRef?.current?.addSample(
          sampleTime,
          midiNumber,
          props.pitchShiftSemis,
          rms,
        );
      }
    }

    const pitchPollers = props.mics.map((mic, i) =>
      setInterval(() => pollPitch(mic, i), 25),
    );

    // Driven from the draw loop below and nowhere else: the filter is paced by
    // how often it is asked, so the 25ms pitch poll keeps reading the raw clock
    // rather than sharing this.
    const mediaClock = new MediaClock();

    // The loop now reschedules unconditionally (see below), so it needs an
    // explicit stop rather than relying on a missing ref to brake it: a frame
    // that slipped past cancelAnimationFrame would otherwise run forever
    // against a pipeline the cleanup has already disposed.
    let cancelled = false;

    const draw = () => {
      if (cancelled) return;

      const canvas = canvasRef.current;
      const video = props.videoRef.current;

      // A frame where either ref is momentarily missing is skipped, not fatal.
      // Returning early *without* rescheduling (which is what this used to do)
      // would freeze the roll for the rest of the song with nothing left to
      // restart it; tearing the loop down is the cleanup's job, not a
      // transient null's.
      if (canvas && video) {
        // Smoothed, not `video.currentTime` raw: see mediaClock.ts for what the
        // raw clock's jitter does to a continuous scroll.
        canvas.classList.toggle(
          "pianoRollPog",
          scene.draw(mediaClock.now(video)),
        );
      }

      animationFrameRequestRef.current = window.requestAnimationFrame(draw);
    };

    animationFrameRequestRef.current = window.requestAnimationFrame(draw);

    // Watches the element, not just the window: the synced pianoRollSize
    // setting changes the canvas height without a window resize.
    const resizeObserver = new ResizeObserver(() => scene.resize());
    resizeObserver.observe(canvasRef.current);

    function clearPitchDetectionBuffers() {
      scene.clearPitch();
      // The phones are drawing the same trail off the same samples, so they
      // have to be told to drop it too.
      tracePublisher?.clear();
      // Re-anchor rather than waiting for the smoothing filter to notice the
      // jump on its own.
      mediaClock.reset();
      // The audio after a seek isn't continuous with the audio before it, so a
      // gate left open across the jump would pass whatever it lands on.
      micGates.forEach((gate) => gate.reset());
      // A seek invalidates the accumulator's forward-only note cursor, and a
      // performance that skipped part of the song can't be scored honestly
      // against the whole melody anyway, so start the tally over.
      props.scoreAccumulatorRef?.current?.reset();
      props.rangeAccumulatorRef?.current?.reset();
    }

    props.videoRef.current.addEventListener(
      "seeked",
      clearPitchDetectionBuffers,
    );

    return () => {
      pitchPollers.forEach((interval) => clearInterval(interval));
      // Nothing polls the mics between songs, so leaving the last values in
      // place would freeze the meters at whatever the final note read.
      props.micLevelsRef?.current.fill(0);
      cancelled = true;
      cancelAnimationFrame(animationFrameRequestRef.current);
      // The canvas (and so the GL context) outlives this effect whenever one
      // scored song follows another, since PianoRoll stays mounted across the
      // transition. Without this, every song leaves a full set of programs,
      // shaders, buffers and VAOs behind on that context.
      scene.dispose();
      tracePublisher?.dispose();
      resizeObserver.disconnect();
      if (props.videoRef.current) {
        props.videoRef.current.removeEventListener(
          "seeked",
          clearPitchDetectionBuffers,
        );
      }
      // This effect tears down at each song's end (deps change), so flush the
      // song's last samples before they're lost.
      if (probeFlushInterval !== null) clearInterval(probeFlushInterval);
      flushProbeBuffer();
    };
    // Only what the effect actually reads, NOT `props` wholesale. The props
    // object is a fresh literal on every Player render, so depending on it
    // tore down and rebuilt this whole effect (new PitchDetectionBuffers, so
    // an empty `positions`) whenever any unrelated Player state changed.
    // `ducked` flips on every instrumental break via onBreakActiveChange, so
    // in practice the sung-pitch trail was erased several times a song, at
    // section boundaries, while the singer was mid-phrase.
  }, [
    layout,
    props.songId,
    props.videoRef,
    props.mics,
    props.pitchShiftSemis,
    props.songKeyRef,
    props.scoreAccumulatorRef,
    props.rangeAccumulatorRef,
  ]);

  const rollOpacity =
    !props.visible || !melodyActive
      ? 0
      : props.ducked
        ? pianoRollOpacity * PIANO_ROLL_DUCK_FACTOR
        : pianoRollOpacity;
  const rollGeometry = {
    top: `${PIANO_ROLL_TOP_FRACTION * 100}%`,
    height: `${pianoRollSize * 100}%`,
  };
  // Drives the background stripe period so the stripes track the same vertical
  // window the notes are drawn in. Declared through an interface rather than
  // asserted: a custom property isn't in React's CSSProperties, and tslint
  // (no-object-literal-type-assertion) wants the annotation, not a cast.
  const rollStyleVars: RollStyleVars = {
    "--piano-roll-span": spanSemis,
  };

  return (
    <>
      {/* Size 0 ("Off") hides the canvas with CSS rather than unmounting it:
          the GL pipeline and mic pitch capture live in a one-shot effect that
          expects the canvas to exist for the whole song. */}
      <canvas
        className="pianoRollRoll"
        style={{
          ...rollGeometry,
          ...rollStyleVars,
          opacity: rollOpacity,
          display: pianoRollSize <= 0 ? "none" : undefined,
        }}
        ref={canvasRef}
      ></canvas>
      {/* Which octave you're looking at. Plain DOM over the canvas rather than
          more GL: it never animates, and keeping it out of the shader pipeline
          means it cannot affect what the roll draws. */}
      {pianoRollSize > 0 && rails.length > 0 ? (
        <div
          className="pianoRollRails"
          style={{ ...rollGeometry, opacity: rollOpacity }}
        >
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
    </>
  );
}
