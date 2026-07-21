import React from "react";
import { graphql, useLazyLoadQuery } from "react-relay";
import { useNavigate, useParams } from "react-router";

import {
  isOriconChartYear,
  oriconChartForYear,
  ORICON_LATEST_YEAR,
} from "../../common/oriconChart";
import { withLoader } from "../components/Loader";
import {
  OriconSelection,
  OriconYearPicker,
} from "../components/RankingFilters";
import { OriconRankingList } from "../components/RankingList";
import * as styles from "./OriconRankingPage.module.scss";
import { OriconRankingPageWeeklyQuery } from "./__generated__/OriconRankingPageWeeklyQuery.graphql";

const oriconWeeklyQuery = graphql`
  query OriconRankingPageWeeklyQuery {
    oriconWeeklyRanking {
      date
      songs {
        rank
        name
        artistName
      }
    }
  }
`;

// The only part of this page that touches the network. Past years are bundled
// and render instantly; the live week is scraped (server-side, cached for the
// calendar week) and so needs the loader/error boundary withLoader provides —
// Oricon rate-limits, and a failed fetch should degrade to a retry message
// with the year chips still usable, not blank the page.
const OriconWeeklyResults = withLoader(() => {
  const data = useLazyLoadQuery<OriconRankingPageWeeklyQuery>(
    oriconWeeklyQuery,
    {},
  );
  const { date, songs } = data.oriconWeeklyRanking;

  return (
    <>
      {/* Reports the real count: the weekly chart is a Top 20, but page 2 is
          best-effort, so this reads "Top 10" if only the first page landed. */}
      <p className={styles.weekNote}>
        Top {songs.length} · week of {date}
      </p>
      <OriconRankingList songs={songs} linkBase="/search/oricon" />
    </>
  );
});

type OriconRankingParams = {
  year?: string;
};

function parseSelection(raw: string | undefined): OriconSelection {
  if (raw === undefined || raw === "current") return "current";
  const parsed = Number(raw);
  return isOriconChartYear(parsed) ? parsed : ORICON_LATEST_YEAR;
}

const OriconRankingPage = () => {
  const params = useParams<OriconRankingParams>();
  const navigate = useNavigate();
  // Derived from the route rather than mirrored into state: the selection is
  // already in the URL, and a copy in useState goes stale whenever the param
  // changes without a remount (a shared deep link, or the back button).
  const selection = parseSelection(params.year);

  const onChange = (next: OriconSelection) => {
    navigate(`/ranking/oricon/${next}`, { replace: true });
  };

  return (
    <>
      <h2>Oricon Top N</h2>
      <OriconYearPicker selection={selection} onChange={onChange} />
      <p className={styles.blurb}>N=10 by year, N=20 this week</p>
      {selection === "current" ? (
        <OriconWeeklyResults />
      ) : (
        <OriconRankingList
          songs={oriconChartForYear(selection)}
          linkBase="/search/oricon"
        />
      )}
    </>
  );
};

export default OriconRankingPage;
