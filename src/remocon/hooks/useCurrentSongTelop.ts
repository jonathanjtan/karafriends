import { useEffect, useMemo, useState } from "react";
import { fetchQuery, graphql, requestSubscription } from "react-relay";

import environment, {
  WS_RECONNECTED_EVENT,
} from "../../common/graphqlEnvironment";
import { TelopLayout, TELOP_LAYOUT_VERSION } from "../../common/telopLayout";
import { useCurrentSongTelopQuery } from "./__generated__/useCurrentSongTelopQuery.graphql";
import { useCurrentSongTelopSubscription } from "./__generated__/useCurrentSongTelopSubscription.graphql";

const currentSongTelopQuery = graphql`
  query useCurrentSongTelopQuery {
    currentSongTelop {
      songKey
      layout
    }
  }
`;

// Only the key: the layout is tens of kilobytes, and every phone that has the
// panel open receives this event, including ones about to refetch anyway.
const currentSongTelopSubscription = graphql`
  subscription useCurrentSongTelopSubscription {
    currentSongTelopChanged {
      songKey
    }
  }
`;

export type CurrentSongTelop =
  // The TV hasn't published this song's lyrics yet (it parses them as the
  // song starts), or they're still on their way here.
  | { status: "loading" }
  // The TV couldn't lay the lyrics out at all, so it shows none either.
  | { status: "unavailable" }
  // Published by a newer TV than this page understands. A reload fixes it.
  | { status: "incompatible" }
  | { status: "ready"; layout: TelopLayout };

// The current song's lyrics as the TV lays them out. `songKey` is the song
// the caller is showing (queueItemKey of the now-playing item): a layout for
// any other song reads as still loading, which covers the moments either side
// of a song change, when the now-playing event and the telop event race.
export default function useCurrentSongTelop(songKey: string): CurrentSongTelop {
  const [telop, setTelop] = useState<{
    songKey: string;
    layout: string | null;
  } | null>(null);

  useEffect(() => {
    // Only the latest request's answer counts: a refetch for the new song
    // mustn't be overwritten by a slower one still in flight for the old.
    let latestRequest = 0;
    let cancelled = false;

    const refetch = () => {
      const request = ++latestRequest;
      fetchQuery<useCurrentSongTelopQuery>(
        environment,
        currentSongTelopQuery,
        {},
      ).subscribe({
        next: (response) => {
          if (cancelled || request !== latestRequest) return;
          const next = response.currentSongTelop;
          setTelop(
            next
              ? { songKey: next.songKey, layout: next.layout ?? null }
              : null,
          );
        },
        error: (err: Error) => {
          console.warn("currentSongTelop fetch failed, retrying", err);
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

    const subscription = requestSubscription<useCurrentSongTelopSubscription>(
      environment,
      {
        subscription: currentSongTelopSubscription,
        variables: {},
        onNext: (response) => {
          if (!response) return;
          if (response.currentSongTelopChanged === null) {
            // Any in-flight fetch is for the song that just ended.
            latestRequest++;
            setTelop(null);
          } else {
            refetch();
          }
        },
      },
    );

    refetch();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(WS_RECONNECTED_EVENT, refetch);
      subscription.dispose();
    };
  }, []);

  const parsed = useMemo((): CurrentSongTelop | null => {
    if (telop === null) return null;
    if (telop.layout === null) return { status: "unavailable" };
    try {
      const layout = JSON.parse(telop.layout) as TelopLayout;
      return layout.version === TELOP_LAYOUT_VERSION
        ? { status: "ready", layout }
        : { status: "incompatible" };
    } catch (e) {
      console.error("Unparseable telop layout", e);
      return { status: "unavailable" };
    }
  }, [telop]);

  if (telop === null || telop.songKey !== songKey || parsed === null) {
    return { status: "loading" };
  }

  return parsed;
}
