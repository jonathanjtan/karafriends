import React, { useState } from "react";
import { graphql, useLazyLoadQuery } from "react-relay";
import { useParams } from "react-router";

import { withLoader } from "../components/Loader";
import RankingFilters, {
  parseRankingPeriod,
  parseRankingSelection,
  RankingCategory,
  RankingPeriod,
  RankingSelection,
} from "../components/RankingFilters";
import RankingList, { RankingArtistList } from "../components/RankingList";
import { DamRankingPageArtistQuery } from "./__generated__/DamRankingPageArtistQuery.graphql";
import { DamRankingPageQuery } from "./__generated__/DamRankingPageQuery.graphql";

const damRankingPageQuery = graphql`
  query DamRankingPageQuery(
    $category: RankingCategory!
    $period: RankingPeriod!
  ) {
    damRanking(category: $category, period: $period) {
      rank
      songId
      name
      nameYomi
      artistName
      artistNameYomi
    }
  }
`;

const damArtistRankingPageQuery = graphql`
  query DamRankingPageArtistQuery($period: RankingPeriod!) {
    damArtistRanking(period: $period) {
      rank
      artistId
      name
      nameYomi
    }
  }
`;

const DamSongResults = withLoader(
  ({
    category,
    period,
  }: {
    category: RankingCategory;
    period: RankingPeriod;
  }) => {
    const data = useLazyLoadQuery<DamRankingPageQuery>(damRankingPageQuery, {
      category,
      period,
    });
    return <RankingList songs={data.damRanking} linkBase="/song" />;
  },
);

const DamArtistResults = withLoader(({ period }: { period: RankingPeriod }) => {
  const data = useLazyLoadQuery<DamRankingPageArtistQuery>(
    damArtistRankingPageQuery,
    { period },
  );
  return (
    <RankingArtistList artists={data.damArtistRanking} linkBase="/artist" />
  );
});

type RankingParams = {
  category?: string;
  period?: string;
};

const DamRankingPage = () => {
  const params = useParams<RankingParams>();
  const [selection, setSelection] = useState<RankingSelection>(
    parseRankingSelection(params.category),
  );
  const [period, setPeriod] = useState<RankingPeriod>(
    parseRankingPeriod(params.period),
  );

  const onChange = (
    nextSelection: RankingSelection,
    nextPeriod: RankingPeriod,
  ) => {
    setSelection(nextSelection);
    setPeriod(nextPeriod);
    history.replaceState(
      {},
      "",
      `#/ranking/dam/${nextSelection.toLowerCase()}/${nextPeriod.toLowerCase()}`,
    );
  };

  return (
    <>
      <h2>DAM Top 100</h2>
      <RankingFilters
        selection={selection}
        period={period}
        onChange={onChange}
        categories={[
          "OVERALL",
          "ANIME",
          "VOCALOID",
          "ENKA",
          "WESTERN",
          "VTUBER",
          "DUET",
          "ARTIST",
        ]}
      />
      {selection === "ARTIST" ? (
        <DamArtistResults period={period} />
      ) : (
        <DamSongResults category={selection} period={period} />
      )}
    </>
  );
};

export default DamRankingPage;
