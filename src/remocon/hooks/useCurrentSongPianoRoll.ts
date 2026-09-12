import { useEffect, useMemo, useState } from "react";
import { fetchQuery, graphql, requestSubscription } from "react-relay";

import environment, {
  WS_RECONNECTED_EVENT,
} from "../../common/graphqlEnvironment";
import {
  PianoRollLayout,
  PIANO_ROLL_LAYOUT_VERSION,
} from "../../common/pianoRoll/layout";
import { useCurrentSongPianoRollQuery } from "./__generated__/useCurrentSongPianoRollQuery.graphql";
import { useCurrentSongPianoRollSubscription } from "./__generated__/useCurrentSongPianoRollSubscription.graphql";

const currentSongPianoRollQuery = graphql`
  query useCurrentSongPianoRollQuery {
    currentSongPianoRoll {
      songKey
      layout
      micCount
    }
  }
`;

// Only the key, for the same reason as the telop's: the layout is kilobytes,
// and everyone showing the panel gets this event.
const currentSongPianoRollSubscription = graphql`
  subscription useCurrentSongPianoRollSubscription {
    currentSongPianoRollChanged {
      songKey
    }
  }
`;

export type CurrentSongPianoRoll =
  // The TV hasn't published this song's roll yet, or it's still on its way.
  | { status: "loading" }
  // The song has no guide melody, so the TV isn't drawing a roll either.
  | { status: "unavailable" }
  // Published by a newer TV than this page understands. A reload fixes it.
  | { status: "incompatible" }
  | { status: "ready"; layout: PianoRollLayout; micCount: number };

// The current song's piano roll as the TV laid it out, keyed by the song the
// caller is showing. Deliberately the same shape (and the same fetch /
// subscribe / refetch plumbing) as useCurrentSongTelop: both mirror one
// snapshot the TV publishes per song, and a layout for any other song reads as
// still loading, which covers the moment either side of a song change.
export default function useCurrentSongPianoRoll(
  songKey: string,
): CurrentSongPianoRoll {
  const [roll, setRoll] = useState<{
    songKey: string;
    layout: string | null;
    micCount: number;
  } | null>(null);

  useEffect(() => {
    // Only the latest request's answer counts: a refetch for the new song
    // mustn't be overwritten by a slower one still in flight for the old.
    let latestRequest = 0;
    let cancelled = false;

    const refetch = () => {
      const request = ++latestRequest;
      fetchQuery<useCurrentSongPianoRollQuery>(
        environment,
        currentSongPianoRollQuery,
        {},
      ).subscribe({
        next: (response) => {
          if (cancelled || request !== latestRequest) return;
          const next = response.currentSongPianoRoll;
          // Keep the previous object when nothing actually changed. Every
          // refetch (the panel coming back into view, the socket
          // reconnecting) would otherwise hand the canvas a new layout
          // identity, which tears down and rebuilds its GL scene and drops
          // the sung-pitch trail with it.
          setRoll((prev) => {
            if (!next) return null;
            const value = {
              songKey: next.songKey,
              layout: next.layout ?? null,
              micCount: next.micCount,
            };
            return prev !== null &&
              prev.songKey === value.songKey &&
              prev.micCount === value.micCount &&
              prev.layout === value.layout
              ? prev
              : value;
          });
        },
        error: (err: Error) => {
          console.warn("currentSongPianoRoll fetch failed, retrying", err);
          setTimeout(() => {
            if (!cancelled && request === latestRequest) refetch();
          }, 2000);
        },
      });
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) refetch();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, refetch);

    const subscription =
      requestSubscription<useCurrentSongPianoRollSubscription>(environment, {
        subscription: currentSongPianoRollSubscription,
        variables: {},
        onNext: (response) => {
          if (!response) return;
          if (response.currentSongPianoRollChanged === null) {
            // Any in-flight fetch is for the song that just ended.
            latestRequest++;
            setRoll(null);
          } else {
            refetch();
          }
        },
      });

    refetch();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(WS_RECONNECTED_EVENT, refetch);
      subscription.dispose();
    };
  }, []);

  const parsed = useMemo((): CurrentSongPianoRoll | null => {
    if (roll === null) return null;
    if (roll.layout === null) return { status: "unavailable" };
    try {
      const layout = JSON.parse(roll.layout) as PianoRollLayout;
      return layout.version === PIANO_ROLL_LAYOUT_VERSION
        ? { status: "ready", layout, micCount: roll.micCount }
        : { status: "incompatible" };
    } catch (e) {
      console.error("Unparseable piano roll layout", e);
      return { status: "unavailable" };
    }
  }, [roll]);

  if (roll === null || roll.songKey !== songKey || parsed === null) {
    return { status: "loading" };
  }

  return parsed;
}
