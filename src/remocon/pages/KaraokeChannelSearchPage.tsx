import React, { useState } from "react";
import { useParams } from "react-router";

import DebouncedInput from "../components/DebouncedInput";
import KaraokeChannelSearchResults from "../components/KaraokeChannelSearchResults";
import SearchFormWrapper from "../components/SearchFormWrapper";

type KaraokeChannelSearchParams = {
  query: string;
};

// Searches a fixed set of karaoke YouTube channels rather than YouTube at
// large: their titles parse into real song/artist pairs, so this behaves like
// a catalog search even though every row is a YouTube video. See
// main/karaokeChannels.ts.
function KaraokeChannelSearchPage() {
  const params = useParams<KaraokeChannelSearchParams>();
  const [query, setQuery] = useState<string | null>(params.query || null);

  return (
    <SearchFormWrapper>
      <h2>Search curated YouTube karaoke channels</h2>
      <DebouncedInput
        period={500}
        placeholder="Start typing..."
        onChange={(e) => {
          setQuery(e.target.value === "" ? null : e.target.value);
          history.replaceState({}, "", `#/search/karaoke/${e.target.value}`);
        }}
        defaultValue={params.query}
      />
      <KaraokeChannelSearchResults query={query} />
    </SearchFormWrapper>
  );
}

export default KaraokeChannelSearchPage;
