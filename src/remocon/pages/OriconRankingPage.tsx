import React from "react";
import { useNavigate, useParams } from "react-router";

import {
  isOriconChartYear,
  oriconChartForYear,
  ORICON_LATEST_YEAR,
} from "../../common/oriconChart";
import { OriconYearPicker } from "../components/RankingFilters";
import { OriconRankingList } from "../components/RankingList";
import * as styles from "./OriconRankingPage.module.scss";

type OriconRankingParams = {
  year?: string;
};

function parseYear(raw: string | undefined): number {
  const parsed = Number(raw);
  return raw && isOriconChartYear(parsed) ? parsed : ORICON_LATEST_YEAR;
}

const OriconRankingPage = () => {
  const params = useParams<OriconRankingParams>();
  const navigate = useNavigate();
  // Derived from the route rather than mirrored into state: the year is
  // already in the URL, and a copy in useState goes stale whenever the param
  // changes without a remount (a shared deep link, or the back button).
  const year = parseYear(params.year);

  const onChange = (nextYear: number) => {
    navigate(`/ranking/oricon/${nextYear}`, { replace: true });
  };

  return (
    <>
      <h2>Oricon Yearly Top 10</h2>
      <OriconYearPicker year={year} onChange={onChange} />
      <p className={styles.blurb}>
        Top 10 Karaoke Songs by year on the Oricon (オリコン) charts. Tap one to
        search it on Joysound/DAM
      </p>
      <OriconRankingList
        songs={oriconChartForYear(year)}
        linkBase="/search/oricon"
      />
    </>
  );
};

export default OriconRankingPage;
