// What the remocon's lyrics panel needs from the big screen, sent to main:
// the current song's telop layout (exactly what JoysoundRenderer draws) and
// where the player is in the song. The phone draws the same layout against
// this clock, which is how its lyrics stay on the TV's.

import React, { useEffect } from "react";
import { commitMutation, graphql } from "react-relay";

import environment from "../common/graphqlEnvironment";
import { TelopLayout } from "../common/telopLayout";
import { lyricsMirrorPublishSongTelopMutation } from "./__generated__/lyricsMirrorPublishSongTelopMutation.graphql";
import { lyricsMirrorReportPlaybackClockMutation } from "./__generated__/lyricsMirrorReportPlaybackClockMutation.graphql";

const publishSongTelopMutation = graphql`
  mutation lyricsMirrorPublishSongTelopMutation($input: SongTelopInput!) {
    publishSongTelop(input: $input)
  }
`;

const reportPlaybackClockMutation = graphql`
  mutation lyricsMirrorReportPlaybackClockMutation(
    $input: PlaybackClockInput!
  ) {
    reportPlaybackClock(input: $input)
  }
`;

// Between events, a playing song re-reports this often. Nothing drifts
// meaningfully in between (the phone extrapolates at the same rate), so this is
// only a backstop for a stall no media event announced, and it hands a phone
// that just subscribed a fresh anchor without waiting for someone to pause.
const HEARTBEAT_MS = 2000;

// HTMLMediaElement.readyState: below this the element can't advance, so a
// "playing" element down here is stalled, whatever `paused` says.
const HAVE_FUTURE_DATA = 3;

// Every media event that can start, stop, or move the clock.
const CLOCK_EVENTS = [
  "play",
  "playing",
  "pause",
  "seeking",
  "seeked",
  "waiting",
  "stalled",
  "ratechange",
  "ended",
  "loadedmetadata",
  "emptied",
];

export function publishSongTelop(songKey: string, layout: TelopLayout | null) {
  commitMutation<lyricsMirrorPublishSongTelopMutation>(environment, {
    mutation: publishSongTelopMutation,
    variables: {
      input: {
        songKey,
        layout: layout === null ? null : JSON.stringify(layout),
      },
    },
    // A phone that misses the lyrics is a phone without lyrics, not a
    // broken song.
    onError: (err) => console.error("Publishing the telop layout failed", err),
  });
}

// Reports the <video>'s position to main whenever it could have changed how
// it moves, and on a heartbeat while it plays. songKeyRef names the queue
// entry the video is currently playing (null between songs), and must be
// updated before the new source is assigned, so the new song's first events
// are reported under its own key.
export function usePlaybackClockReporter(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  songKeyRef: React.MutableRefObject<string | null>,
) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const isAdvancing = () =>
      !video.paused &&
      !video.seeking &&
      !video.ended &&
      video.readyState >= HAVE_FUTURE_DATA;

    const report = () => {
      const songKey = songKeyRef.current;
      if (songKey === null) return;

      // Read together, so the pair names one instant: the position, and when
      // (on the clock main and the renderer share) it was that.
      const positionMs = video.currentTime * 1000;
      const capturedAt = Date.now();

      if (!Number.isFinite(positionMs)) return;

      commitMutation<lyricsMirrorReportPlaybackClockMutation>(environment, {
        mutation: reportPlaybackClockMutation,
        variables: {
          input: {
            songKey,
            positionMs,
            capturedAt,
            playing: isAdvancing(),
            rate: video.playbackRate,
          },
        },
        onError: (err) =>
          console.error("Reporting the playback clock failed", err),
      });
    };

    CLOCK_EVENTS.forEach((event) => video.addEventListener(event, report));

    const heartbeat = setInterval(() => {
      if (isAdvancing()) report();
    }, HEARTBEAT_MS);

    return () => {
      CLOCK_EVENTS.forEach((event) => video.removeEventListener(event, report));
      clearInterval(heartbeat);
    };
  }, []);
}
