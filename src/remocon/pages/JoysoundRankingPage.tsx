import React, { useState } from "react";
import { graphql, useLazyLoadQuery } from "react-relay";
import { useParams } from "react-router";

import { withLoader } from "../components/Loader";
import RankingFilters, {
  JoysoundMonthPicker,
  parseRankingPeriod,
  parseRankingSelection,
  RankingCategory,
  RankingPeriod,
  RankingSelection,
} from "../components/RankingFilters";
import RankingList, { RankingArtistList } from "../components/RankingList";
import { JoysoundRankingPageArtistQuery } from "./__generated__/JoysoundRankingPageArtistQuery.graphql";
import { JoysoundRankingPageQuery } from "./__generated__/JoysoundRankingPageQuery.graphql";

const joysoundRankingPageQuery = graphql`
  query JoysoundRankingPageQuery(
    $category: RankingCategory!
    $period: RankingPeriod!
    $month: String
  ) {
    joysoundRanking(category: $category, period: $period, month: $month) {
      rank
      songId
      name
      nameYomi
      artistName
      artistNameYomi
    }
  }
`;

const joysoundArtistRankingPageQuery = graphql`
  query JoysoundRankingPageArtistQuery(
    $period: RankingPeriod!
    $month: String
  ) {
    joysoundArtistRanking(period: $period, month: $month) {
      rank
      artistId
      name
      nameYomi
    }
  }
`;

const JoysoundSongResults = withLoader(
  ({
    category,
    period,
    month,
  }: {
    category: RankingCategory;
    period: RankingPeriod;
    month: string | null;
  }) => {
    const data = useLazyLoadQuery<JoysoundRankingPageQuery>(
      joysoundRankingPageQuery,
      { category, period, month },
    );
    return (
      <RankingList songs={data.joysoundRanking} linkBase="/joysoundSong" />
    );
  },
);

const JoysoundArtistResults = withLoader(
  ({ period, month }: { period: RankingPeriod; month: string | null }) => {
    const data = useLazyLoadQuery<JoysoundRankingPageArtistQuery>(
      joysoundArtistRankingPageQuery,
      { period, month },
    );
    return (
      <RankingArtistList
        artists={data.joysoundArtistRanking}
        linkBase="/joysoundArtist"
      />
    );
  },
);

type RankingParams = {
  category?: string;
  period?: string;
  month?: string;
};

const JoysoundRankingPage = () => {
  const params = useParams<RankingParams>();
  const [selection, setSelection] = useState<RankingSelection>(
    parseRankingSelection(params.category),
  );
  const [period, setPeriod] = useState<RankingPeriod>(
    parseRankingPeriod(params.period),
  );
  const [month, setMonth] = useState<string | null>(params.month || null);

  const syncRoute = (
    nextSelection: RankingSelection,
    nextPeriod: RankingPeriod,
    nextMonth: string | null,
  ) => {
    const monthSeg =
      nextPeriod === "MONTHLY" && nextMonth ? `/${nextMonth}` : "";
    history.replaceState(
      {},
      "",
      `#/ranking/joysound/${nextSelection.toLowerCase()}/${nextPeriod.toLowerCase()}${monthSeg}`,
    );
  };

  const onChange = (
    nextSelection: RankingSelection,
    nextPeriod: RankingPeriod,
  ) => {
    setSelection(nextSelection);
    setPeriod(nextPeriod);
    syncRoute(nextSelection, nextPeriod, month);
  };

  const onMonthChange = (nextMonth: string | null) => {
    setMonth(nextMonth);
    syncRoute(selection, period, nextMonth);
  };

  return (
    <>
      <h2>JOYSOUND Top 100</h2>
      <RankingFilters
        selection={selection}
        period={period}
        onChange={onChange}
      />
      {period === "MONTHLY" && (
        <JoysoundMonthPicker month={month} onChange={onMonthChange} />
      )}
      {selection === "ARTIST" ? (
        <JoysoundArtistResults period={period} month={month} />
      ) : (
        <JoysoundSongResults
          category={selection}
          period={period}
          month={month}
        />
      )}
    </>
  );
};

export default JoysoundRankingPage;
