import React, { useState } from "react";
import { graphql, useLazyLoadQuery } from "react-relay";
import { useParams } from "react-router";

import { withLoader } from "../components/Loader";
import RankingFilters, {
  parseRankingCategory,
  parseRankingPeriod,
  RankingCategory,
  RankingPeriod,
} from "../components/RankingFilters";
import RankingList from "../components/RankingList";
import { JoysoundRankingPageQuery } from "./__generated__/JoysoundRankingPageQuery.graphql";

const joysoundRankingPageQuery = graphql`
  query JoysoundRankingPageQuery(
    $category: RankingCategory!
    $period: RankingPeriod!
  ) {
    joysoundRanking(category: $category, period: $period) {
      rank
      id
      name
      nameYomi
      artistName
      artistNameYomi
    }
  }
`;

interface ResultsProps {
  category: RankingCategory;
  period: RankingPeriod;
}

const JoysoundRankingResults = withLoader(
  ({ category, period }: ResultsProps) => {
    const data = useLazyLoadQuery<JoysoundRankingPageQuery>(
      joysoundRankingPageQuery,
      { category, period },
    );

    return (
      <RankingList songs={data.joysoundRanking} linkBase="/joysoundSong" />
    );
  },
);

type RankingParams = {
  category?: string;
  period?: string;
};

const JoysoundRankingPage = () => {
  const params = useParams<RankingParams>();
  const [category, setCategory] = useState<RankingCategory>(
    parseRankingCategory(params.category),
  );
  const [period, setPeriod] = useState<RankingPeriod>(
    parseRankingPeriod(params.period),
  );

  const onChange = (newCategory: RankingCategory, newPeriod: RankingPeriod) => {
    setCategory(newCategory);
    setPeriod(newPeriod);
    history.replaceState(
      {},
      "",
      `#/ranking/joysound/${newCategory.toLowerCase()}/${newPeriod.toLowerCase()}`,
    );
  };

  return (
    <>
      <h2>JOYSOUND Top 100</h2>
      <RankingFilters category={category} period={period} onChange={onChange} />
      <JoysoundRankingResults category={category} period={period} />
    </>
  );
};

export default JoysoundRankingPage;
