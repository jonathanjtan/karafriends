import React, { useState } from "react";
import { useParams } from "react-router";

import DebouncedInput from "../components/DebouncedInput";
import SearchFormWrapper from "../components/SearchFormWrapper";
import { SearchSource } from "../components/SearchSourceFilter";
import SongSearchResults from "../components/SongSearchResults";

type SongSearchParams = {
  query: string;
};

interface Props {
  // The service-specific routes (/search/joysoundSong/…) still exist so old
  // links and the back button keep working; they land here with the catalog
  // preselected rather than on a separate single-service page.
  initialSource?: SearchSource | null;
  routeBase?: string;
}

function SongSearchPage({
  initialSource = null,
  routeBase = "/search/song",
}: Props) {
  const params = useParams<SongSearchParams>();
  const [query, setQuery] = useState<string | null>(params.query || null);

  return (
    <SearchFormWrapper>
      <h2>Search by song title</h2>
      <DebouncedInput
        period={500}
        placeholder="Start typing..."
        onChange={(e) => {
          setQuery(e.target.value === "" ? null : e.target.value);
          history.replaceState({}, "", `#${routeBase}/${e.target.value}`);
        }}
        defaultValue={params.query}
      />
      <SongSearchResults query={query} initialSource={initialSource} />
    </SearchFormWrapper>
  );
}

export default SongSearchPage;
