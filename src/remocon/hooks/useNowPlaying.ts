import { useEffect, useState } from "react";
import { fetchQuery, graphql, requestSubscription } from "react-relay";

import environment, {
  WS_RECONNECTED_EVENT,
} from "../../common/graphqlEnvironment";
import fetchQueryWithRetry from "../../common/hooks/fetchQueryWithRetry";
import {
  useNowPlayingQuery,
  useNowPlayingQuery$data,
} from "./__generated__/useNowPlayingQuery.graphql";

import {
  useNowPlayingSubscription,
  useNowPlayingSubscription$data,
} from "./__generated__/useNowPlayingSubscription.graphql";

const nowPlayingQuery = graphql`
  query useNowPlayingQuery {
    currentSong {
      ... on YoutubeQueueItem {
        __typename
        songId
        name
        artistName
        playtime
        timestamp
        userIdentity {
          deviceId
          nickname
          profilePictureUrl
          profilePictureFrame
          personId
        }
        hasAdhocLyrics
      }

      ... on QueueItemInterface {
        __typename
        songId
        name
        artistName
        playtime
        timestamp
        userIdentity {
          deviceId
          nickname
          profilePictureUrl
          profilePictureFrame
          personId
        }
      }

      ... on JoysoundQueueItem {
        youtubeVideoId
      }
    }
  }
`;

const nowPlayingSubscription = graphql`
  subscription useNowPlayingSubscription {
    currentSongChanged {
      ... on YoutubeQueueItem {
        __typename
        songId
        name
        artistName
        playtime
        timestamp
        userIdentity {
          deviceId
          nickname
          profilePictureUrl
          profilePictureFrame
          personId
        }
        hasAdhocLyrics
      }

      ... on QueueItemInterface {
        __typename
        songId
        name
        artistName
        playtime
        timestamp
        userIdentity {
          deviceId
          nickname
          profilePictureUrl
          profilePictureFrame
          personId
        }
      }

      ... on JoysoundQueueItem {
        youtubeVideoId
      }
    }
  }
`;

export default function useNowPlaying() {
  const [currentSong, setCurrentSong] = useState<
    useNowPlayingSubscription$data["currentSongChanged"] | undefined
  >(undefined);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useNowPlayingQuery>(
        environment,
        nowPlayingQuery,
        {},
      ).subscribe({
        next: (response: useNowPlayingQuery$data) =>
          setCurrentSong(response.currentSong),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useNowPlayingQuery>(
      environment,
      nowPlayingQuery,
      {},
      (response) => setCurrentSong(response.currentSong),
    );

    const subscription = requestSubscription<useNowPlayingSubscription>(
      environment,
      {
        subscription: nowPlayingSubscription,
        variables: {},
        onNext: (response) =>
          setCurrentSong(response?.currentSongChanged || null),
      },
    );

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);
      initialQuery.unsubscribe();
      subscription.dispose();
    };
  }, []);

  return currentSong;
}
