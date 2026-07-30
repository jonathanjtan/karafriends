import React from "react";

/* tslint:disable:no-submodule-imports no-implicit-dependencies */
import { cyrb53 } from "../common/hash";
import { resolveProfilePictureUrl } from "../common/profilePicture";
import { ScoreResult } from "../common/scoring";
/* tslint:enable:no-submodule-imports no-implicit-dependencies */
import "./ScoreCard.css";

export interface ScoredPerformance {
  result: ScoreResult;
  songName: string;
  nickname: string;
  profilePictureUrl: string | null;
}

function nicknameBadge(nickname: string) {
  const nicknameHash = cyrb53(nickname);
  return (
    <span
      style={{
        backgroundColor: `hsl(${(nicknameHash % 180) + 180}, 100%, 50%)`,
        color: `hsl(${nicknameHash % 180}, 100%, 50%)`,
        padding: "0 1vh",
        borderRadius: "0.5vh",
      }}
    >
      {nickname}
    </span>
  );
}

// EXPERIMENTAL end-of-song scoring card. Gated behind config.yaml's
// experimentalScoring; see src/common/scoring.ts for why the numbers are ours
// rather than DAM's.
export default function ScoreCard(props: {
  performance: ScoredPerformance;
  hiding: boolean;
}) {
  const { result, songName, nickname, profilePictureUrl } = props.performance;
  const portraitUrl =
    profilePictureUrl === null
      ? null
      : resolveProfilePictureUrl(profilePictureUrl);

  return (
    <div
      className={`scoreCard${props.hiding ? " scoreCardHiding" : ""}`}
      data-testid="scoreCard"
    >
      <div className="scoreCardExperimentalTag">Experimental</div>

      <div className="scoreCardSinger">
        {portraitUrl ? (
          <img className="scoreCardPortrait" src={portraitUrl} alt="" />
        ) : null}
        {nicknameBadge(nickname)}
      </div>

      <div className="scoreCardSongName">{songName}</div>

      <div className={`scoreCardBand scoreCardBand${result.band}`}>
        {result.band}
      </div>

      <div className="scoreCardOverall">{result.display.toFixed(1)}</div>

      {/* One row per axis, each with the raw fact behind it: an unfamiliar
          metric is only trustworthy next to its evidence. An axis the song
          can't be judged on reads "—" rather than being quietly folded away
          (see ScoreResult), because a missing axis leans the score on pitch. */}
      <div className="scoreCardBreakdown">
        <div>
          Pitch{" "}
          <span className="scoreCardBreakdownValue">
            {Math.round(result.pitch * 100)}
          </span>
        </div>
        <div>
          Long tone{" "}
          <span className="scoreCardBreakdownValue">
            {result.longTone === null ? "—" : Math.round(result.longTone * 100)}
          </span>{" "}
          <span className="scoreCardBreakdownNote">
            {result.longToneCount === 0
              ? "no held notes"
              : `${result.longToneCount} held`}
          </span>
        </div>
        <div>
          Timing{" "}
          <span className="scoreCardBreakdownValue">
            {result.timing === null ? "—" : Math.round(result.timing * 100)}
          </span>{" "}
          <span className="scoreCardBreakdownNote">
            {result.timingSpreadMs === null
              ? `${result.timingCount} attacks`
              : `±${Math.round(result.timingSpreadMs)}ms`}
          </span>
        </div>
      </div>

      <div className="scoreCardGraph">
        {result.buckets.map((bucket, i) =>
          bucket === null ? (
            <div key={i} className="scoreCardBarEmpty" />
          ) : (
            <div
              key={i}
              className="scoreCardBar"
              style={{ height: `${Math.max(bucket * 100, 3)}%` }}
            />
          ),
        )}
      </div>
    </div>
  );
}
