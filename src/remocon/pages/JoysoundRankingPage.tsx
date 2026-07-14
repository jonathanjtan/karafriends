import React from "react";
import { graphql, useLazyLoadQuery } from "react-relay";

import { withLoader } from "../components/Loader";
import RankingList from "../components/RankingList";
import { JoysoundRankingPageQuery } from "./__generated__/JoysoundRankingPageQuery.graphql";

const joysoundRankingPageQuery = graphql`
  query JoysoundRankingPageQuery {
    joysoundRanking {
      rank
      id
      name
      nameYomi
      artistName
      artistNameYomi
    }
  }
`;

const JoysoundRankingResults = withLoader(() => {
  const data = useLazyLoadQuery<JoysoundRankingPageQuery>(
    joysoundRankingPageQuery,
    {},
  );

  return <RankingList songs={data.joysoundRanking} linkBase="/joysoundSong" />;
});

const JoysoundRankingPage = () => (
  <>
    <h2>JOYSOUND Top 100</h2>
    <JoysoundRankingResults />
  </>
);

export default JoysoundRankingPage;
