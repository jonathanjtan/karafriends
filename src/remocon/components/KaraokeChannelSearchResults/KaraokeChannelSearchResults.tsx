import React, { useState } from "react";
import { graphql, useLazyLoadQuery } from "react-relay";

import { List } from "../List";
import { withLoader } from "../Loader";
import { SourceUnavailableNotice } from "../SearchSourceFilter";
import KaraokeChannelSearchResultsItem from "./KaraokeChannelSearchResultsItem";
import { KaraokeChannelSearchResultsQuery } from "./__generated__/KaraokeChannelSearchResultsQuery.graphql";

const karaokeChannelSearchResultsQuery = graphql`
  query KaraokeChannelSearchResultsQuery($keyword: String) {
    karaokeChannelSongs(keyword: $keyword) {
      unavailableChannels
      songs {
        id
        videoId
        channelLabel
        name
        artistName
        variant
        catalogId
        playtime
      }
    }
  }
`;

interface Props {
  query: string | null;
}

const KaraokeChannelSearchResults = ({ query }: Props) => {
  if (!query) return null;

  // Bumping this re-issues the query; a channel that didn't answer is the
  // only reason to, so the retry goes straight past the store.
  const [retryKey, setRetryKey] = useState(0);

  const data = useLazyLoadQuery<KaraokeChannelSearchResultsQuery>(
    karaokeChannelSearchResultsQuery,
    { keyword: query },
    // Re-running the whole nine-channel fan-out because the user came back to
    // the tab is a lot of requests for a list that hasn't changed; the server
    // caches each channel's answer briefly anyway.
    {
      fetchPolicy: retryKey === 0 ? "store-or-network" : "network-only",
      fetchKey: retryKey,
    },
  );

  const { songs, unavailableChannels } = data.karaokeChannelSongs;

  return (
    <>
      <SourceUnavailableNotice
        sources={unavailableChannels}
        onRetry={() => setRetryKey((key) => key + 1)}
        isRetrying={false}
      />
      {songs.length === 0 ? (
        <span>No results found</span>
      ) : (
        <List>
          {songs.map((song) => (
            <KaraokeChannelSearchResultsItem key={song.id} {...song} />
          ))}
        </List>
      )}
    </>
  );
};

export default withLoader(KaraokeChannelSearchResults);
