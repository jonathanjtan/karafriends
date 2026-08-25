import React, { useState } from "react";
import { graphql, useLazyLoadQuery, usePaginationFragment } from "react-relay";

import Button from "../Button";
import { List } from "../List";
import { default as Loader, withLoader } from "../Loader";
import SearchSourceFilter, {
  SearchSource,
  SourceUnavailableNotice,
} from "../SearchSourceFilter";
import ArtistSearchResultsItem from "./ArtistSearchResultsItem";
import { ArtistSearchResultsPaginationQuery } from "./__generated__/ArtistSearchResultsPaginationQuery.graphql";
import { ArtistSearchResultsViewQuery } from "./__generated__/ArtistSearchResultsViewQuery.graphql";
import { ArtistSearchResults_searchArtists$key } from "./__generated__/ArtistSearchResults_searchArtists.graphql";

const artistSearchResultsViewQuery = graphql`
  query ArtistSearchResultsViewQuery($keyword: String) {
    ...ArtistSearchResults_searchArtists @arguments(keyword: $keyword)
  }
`;

const artistSearchResultsPaginationQuery = graphql`
  fragment ArtistSearchResults_searchArtists on Query
  @argumentDefinitions(
    count: { type: "Int", defaultValue: 30 }
    cursor: { type: "String" }
    keyword: { type: "String" }
  )
  @refetchable(queryName: "ArtistSearchResultsPaginationQuery") {
    searchArtists(keyword: $keyword, first: $count, after: $cursor)
      @connection(key: "ArtistSearchResultsPagination_searchArtists") {
      unavailableSources
      edges {
        node {
          id
          artistId
          source
          name
          nameYomi
          songCount
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

const ArtistSearchResults = ({ query, initialSource = null }: Props) => {
  if (!query) return null;

  const [source, setSource] = useState<SearchSource | null>(initialSource);

  const queryData = useLazyLoadQuery<ArtistSearchResultsViewQuery>(
    artistSearchResultsViewQuery,
    { keyword: query },
  );

  const { data, hasNext, loadNext, isLoadingNext, refetch } =
    usePaginationFragment<
      ArtistSearchResultsPaginationQuery,
      ArtistSearchResults_searchArtists$key
    >(artistSearchResultsPaginationQuery, queryData);

  const edges = data.searchArtists.edges;
  const unavailable = data.searchArtists.unavailableSources;
  const counts = {
    DAM: edges.filter(({ node }) => node.source === "DAM").length,
    JOYSOUND: edges.filter(({ node }) => node.source === "JOYSOUND").length,
  };
  // See SongSearchResults: a catalog that stops answering must not leave the
  // list filtered to nothing behind a disabled chip.
  const effectiveSource =
    source && unavailable.includes(source) ? null : source;
  const shown = effectiveSource
    ? edges.filter(({ node }) => node.source === effectiveSource)
    : edges;

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
            <ArtistSearchResultsItem key={node.id} {...node} />
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

export default withLoader(ArtistSearchResults);
