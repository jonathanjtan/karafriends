import React, { useState } from "react";
import { useParams } from "react-router";

import ArtistSearchResults from "../components/ArtistSearchResults";
import DebouncedInput from "../components/DebouncedInput";
import SearchFormWrapper from "../components/SearchFormWrapper";
import { SearchSource } from "../components/SearchSourceFilter";

type ArtistSearchParams = {
  query: string;
};

interface Props {
  // See SongSearchPage — the service-specific routes land here with the
  // catalog preselected.
  initialSource?: SearchSource | null;
  routeBase?: string;
}

const ArtistSearchPage = ({
  initialSource = null,
  routeBase = "/search/artist",
}: Props) => {
  const params = useParams<ArtistSearchParams>();
  const [query, setQuery] = useState<string | null>(params.query || null);

  return (
    <SearchFormWrapper>
      {/* Names both catalogs — see SongSearchPage. */}
      <h2>Search JOYSOUND/DAM by artist name</h2>
      <DebouncedInput
        period={500}
        placeholder="Start typing..."
        onChange={(e) => {
          setQuery(e.target.value === "" ? null : e.target.value);
          history.replaceState({}, "", `#${routeBase}/${e.target.value}`);
        }}
        defaultValue={params.query}
      />
      <ArtistSearchResults query={query} initialSource={initialSource} />
    </SearchFormWrapper>
  );
};

export default ArtistSearchPage;
