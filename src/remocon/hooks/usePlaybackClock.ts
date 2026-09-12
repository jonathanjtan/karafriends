import { useEffect, useRef } from "react";
import { fetchQuery, graphql, requestSubscription } from "react-relay";

import environment, {
  WS_RECONNECTED_EVENT,
} from "../../common/graphqlEnvironment";
import fetchQueryWithRetry from "../../common/hooks/fetchQueryWithRetry";
import { usePlaybackClockQuery } from "./__generated__/usePlaybackClockQuery.graphql";
import { usePlaybackClockSubscription } from "./__generated__/usePlaybackClockSubscription.graphql";

const playbackClockQuery = graphql`
  query usePlaybackClockQuery {
    playbackClock {
      songKey
      positionMs
      capturedAt
      playing
      rate
    }
  }
`;

const playbackClockSubscription = graphql`
  subscription usePlaybackClockSubscription {
    playbackClockChanged {
      songKey
      positionMs
      capturedAt
      playing
      rate
    }
  }
`;

export interface PlaybackClock {
  songKey: string;
  positionMs: number;
  // Epoch ms on main's clock.
  capturedAt: number;
  playing: boolean;
  rate: number;
}

// Where the TV's player is in the current song, per its latest report. Lives
// in a ref, not state: it's read every animation frame by the lyrics canvas,
// and re-rendering React on every heartbeat would buy nothing.
//
// Where the position is *now* is the report extrapolated to main's clock now,
// so it needs useServerClockOffset to mean anything on this device.
export default function usePlaybackClock(): React.MutableRefObject<PlaybackClock | null> {
  const clockRef = useRef<PlaybackClock | null>(null);

  useEffect(() => {
    // A query answer can overtake a subscription event that was sent after
    // it, so an older report for the same song never replaces a newer one.
    // A null (nothing playing) only comes from a live event, or fills a gap.
    const accept = (next: PlaybackClock | null | undefined, live: boolean) => {
      const current = clockRef.current;
      if (!next) {
        if (live || current === null) clockRef.current = null;
        return;
      }
      if (
        current !== null &&
        current.songKey === next.songKey &&
        next.capturedAt < current.capturedAt
      ) {
        return;
      }
      clockRef.current = {
        songKey: next.songKey,
        positionMs: next.positionMs,
        capturedAt: next.capturedAt,
        playing: next.playing,
        rate: next.rate,
      };
    };

    const refetch = () => {
      fetchQuery<usePlaybackClockQuery>(
        environment,
        playbackClockQuery,
        {},
      ).subscribe({
        next: (response) => accept(response.playbackClock, false),
        error: (err: Error) =>
          console.warn("playbackClock refetch failed", err),
      });
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) refetch();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, refetch);

    const initialQuery = fetchQueryWithRetry<usePlaybackClockQuery>(
      environment,
      playbackClockQuery,
      {},
      (response) => accept(response.playbackClock, false),
    );

    const subscription = requestSubscription<usePlaybackClockSubscription>(
      environment,
      {
        subscription: playbackClockSubscription,
        variables: {},
        onNext: (response) => {
          if (response) accept(response.playbackClockChanged, true);
        },
      },
    );

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(WS_RECONNECTED_EVENT, refetch);
      initialQuery.unsubscribe();
      subscription.dispose();
    };
  }, []);

  return clockRef;
}
