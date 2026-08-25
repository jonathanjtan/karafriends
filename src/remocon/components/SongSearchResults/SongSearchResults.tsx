import React, { useState } from "react";
import { graphql, useLazyLoadQuery, usePaginationFragment } from "react-relay";

import useSongFits from "../../hooks/useSongFits";
import Button from "../Button";
import { List } from "../List";
import { default as Loader, withLoader } from "../Loader";
import SearchSourceFilter, {
  SearchSource,
  SourceUnavailableNotice,
} from "../SearchSourceFilter";
import SongSearchResultsItem from "./SongSearchResultsItem";
import { SongSearchResultsPaginationQuery } from "./__generated__/SongSearchResultsPaginationQuery.graphql";
import { SongSearchResultsViewQuery } from "./__generated__/SongSearchResultsViewQuery.graphql";
import { SongSearchResults_searchSongs$key } from "./__generated__/SongSearchResults_searchSongs.graphql";

const songSearchResultsViewQuery = graphql`
  query SongSearchResultsViewQuery($keyword: String) {
    ...SongSearchResults_searchSongs @arguments(keyword: $keyword)
  }
`;

const songSearchResultsPaginationQuery = graphql`
  fragment SongSearchResults_searchSongs on Query
  @argumentDefinitions(
    count: { type: "Int", defaultValue: 30 }
    cursor: { type: "String" }
    keyword: { type: "String" }
  )
  @refetchable(queryName: "SongSearchResultsPaginationQuery") {
    searchSongs(keyword: $keyword, first: $count, after: $cursor)
      @connection(key: "SongSearchResultsPagination_searchSongs") {
      unavailableSources
      edges {
        node {
          id
          songId
          source
          name
          nameYomi
          artistName
          artistNameYomi
        }
      }
    }
  }
`;

// `count` is per catalog server-side, so a page is up to twice this many rows.
const PAGE_SIZE = 30;

interface Props {
  query: string | null;
  // Catalog the list opens filtered to, for the routes that still name one
  // service. Null opens unfiltered; either way both catalogs are searched and
  // the chips can switch between them without another request.
  initialSource?: SearchSource | null;
}

const SongSearchResults = ({ query, initialSource = null }: Props) => {
  if (!query) return null;

  const [source, setSource] = useState<SearchSource | null>(initialSource);

  const queryData = useLazyLoadQuery<SongSearchResultsViewQuery>(
    songSearchResultsViewQuery,
    { keyword: query },
  );

  const { data, hasNext, loadNext, isLoadingNext, refetch } =
    usePaginationFragment<
      SongSearchResultsPaginationQuery,
      SongSearchResults_searchSongs$key
    >(songSearchResultsPaginationQuery, queryData);

  const edges = data.searchSongs.edges;
  const unavailable = data.searchSongs.unavailableSources;
  const counts = {
    DAM: edges.filter(({ node }) => node.source === "DAM").length,
    JOYSOUND: edges.filter(({ node }) => node.source === "JOYSOUND").length,
  };
  // A catalog that stops answering mid-session must not leave the list
  // filtered down to nothing: its chip is disabled at that point, so tapping
  // it again can't clear the selection either. Fall back to unfiltered and
  // let the notice explain the gap. The selection itself is kept, so it
  // takes effect again if the catalog comes back.
  const effectiveSource =
    source && unavailable.includes(source) ? null : source;
  const shown = effectiveSource
    ? edges.filter(({ node }) => node.source === effectiveSource)
    : edges;

  // One cache-only lookup for the whole page. Rows we know nothing about get no
  // marker, which is the same thing as having no opinion about them.
  const fits = useSongFits(
    shown.map(({ node }) => ({ source: node.source, songId: node.songId })),
  );

  return (
    <>
      <SearchSourceFilter
        selected={effectiveSource}
        onSelect={setSource}
        counts={counts}
        unavailable={unavailable}
      />
      <SourceUnavailableNotice
        sources={unavailable}
        onRetry={() =>
          refetch({ keyword: query }, { fetchPolicy: "network-only" })
        }
        isRetrying={isLoadingNext}
      />
      {shown.length === 0 ? (
        <span>
          {edges.length === 0
            ? "No results found"
            : `No ${effectiveSource} results among the ones loaded. Try More.`}
        </span>
      ) : (
        <List>
          {shown.map(({ node }) => (
            <SongSearchResultsItem
              key={node.id}
              {...node}
              comfortable={fits.get(`${node.source}:${node.songId}`) === true}
            />
          ))}
        </List>
      )}
      {isLoadingNext ? (
        <Loader />
      ) : (
        hasNext && (
          <Button
            full
            disabled={isLoadingNext}
            onClick={() => loadNext(PAGE_SIZE)}
          >
            More
          </Button>
        )
      )}
    </>
  );
};

export default withLoader(SongSearchResults);
