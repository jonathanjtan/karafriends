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

interface ResultsProps {
  category: RankingCategory;
  period: RankingPeriod;
}

const DamRankingResults = withLoader(({ category, period }: ResultsProps) => {
  const data = useLazyLoadQuery<DamRankingPageQuery>(damRankingPageQuery, {
    category,
    period,
  });

  return <RankingList songs={data.damRanking} linkBase="/song" />;
});

type RankingParams = {
  category?: string;
  period?: string;
};

const DamRankingPage = () => {
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
      `#/ranking/dam/${newCategory.toLowerCase()}/${newPeriod.toLowerCase()}`,
    );
  };

  return (
    <>
      <h2>DAM Top 100</h2>
      <RankingFilters category={category} period={period} onChange={onChange} />
      <DamRankingResults category={category} period={period} />
    </>
  );
};

export default DamRankingPage;
