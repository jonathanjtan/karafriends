import React from "react";
import { graphql, useLazyLoadQuery } from "react-relay";

import { withLoader } from "../components/Loader";
import RankingList from "../components/RankingList";
import { DamRankingPageQuery } from "./__generated__/DamRankingPageQuery.graphql";

const damRankingPageQuery = graphql`
  query DamRankingPageQuery {
    damRanking {
      rank
      id
      name
      nameYomi
      artistName
      artistNameYomi
    }
  }
`;

const DamRankingResults = withLoader(() => {
  const data = useLazyLoadQuery<DamRankingPageQuery>(damRankingPageQuery, {});

  return <RankingList songs={data.damRanking} linkBase="/song" />;
});

const DamRankingPage = () => (
  <>
    <h2>DAM Top 100</h2>
    <DamRankingResults />
  </>
);

export default DamRankingPage;
