import { useEffect, useMemo, useState } from "react";
import { fetchQuery, graphql } from "react-relay";

import environment from "../../common/graphqlEnvironment";
import useUserIdentity from "./useUserIdentity";
import { useSongFitsQuery } from "./__generated__/useSongFitsQuery.graphql";

// Which of these songs would sit comfortably for whoever is holding the phone.
//
// Returns a map keyed "SOURCE:songId" -> true. **Only positive entries exist**:
// a song that isn't a nice fit, and a song we have no cached range for, are
// both simply absent, and callers render nothing for either. That equivalence
// is deliberate. It is what lets the cache be partial (a JOYSOUND song nobody
// has played has no extracted melody, and extracting one costs ~8s) without the
// UI ever implying something negative about a song.
//
// fetchQuery rather than useLazyLoadQuery: this must never suspend the list it
// decorates. A search result page has to render the instant the results land,
// with or without markers, and a failure here is a no-op rather than an error
// boundary swallowing the whole list.
const songFitsQuery = graphql`
  query useSongFitsQuery(
    $songs: [SongFitRef!]!
    $nickname: String!
    $personId: String
  ) {
    songFits(songs: $songs, nickname: $nickname, personId: $personId) {
      source
      songId
      fit {
        comfortable
      }
    }
  }
`;

export interface SongRef {
  // Widened to string rather than the SongSource union: Relay generates its
  // enums with a "%future added value" member, so a value read straight off a
  // query doesn't satisfy the narrow type. The server validates it against the
  // real enum regardless.
  source: string;
  songId: string;
}

export default function useSongFits(
  songs: readonly SongRef[],
): Map<string, boolean> {
  const identity = useUserIdentity();
  const [fits, setFits] = useState<Map<string, boolean>>(new Map());

  // Keyed on the song list itself, so paging in more rows re-runs this but a
  // re-render with the same rows does not.
  const key = useMemo(
    () => songs.map((song) => `${song.source}:${song.songId}`).join(","),
    [songs],
  );

  useEffect(() => {
    if (songs.length === 0 || identity.deviceId === "Unknown") return;
    let cancelled = false;

    fetchQuery<useSongFitsQuery>(environment, songFitsQuery, {
      // Cast for the same reason SongRef widens it: the input type wants the
      // narrow SongSource, and these values came off a query that types the
      // enum with a "%future added value" member.
      songs: songs.map((song) => ({
        source: song.source as "DAM" | "JOYSOUND",
        songId: song.songId,
      })),
      nickname: identity.nickname,
      personId: identity.personId,
    }).subscribe({
      next: (response) => {
        if (cancelled) return;
        const next = new Map<string, boolean>();
        for (const entry of response.songFits) {
          if (entry.fit.comfortable) {
            next.set(`${entry.source}:${entry.songId}`, true);
          }
        }
        setFits(next);
      },
      // A missing marker is a missing marker. Never surface this.
      error: () => undefined,
    });

    return () => {
      cancelled = true;
    };
  }, [key, identity.nickname, identity.personId, identity.deviceId]);

  return fits;
}
