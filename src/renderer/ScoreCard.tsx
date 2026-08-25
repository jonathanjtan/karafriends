import React from "react";

/* tslint:disable:no-submodule-imports no-implicit-dependencies */
import { cyrb53 } from "../common/hash";
import { resolveProfilePictureUrl } from "../common/profilePicture";
import { ScoreResult } from "../common/scoring";
import { InstrumentalBreak } from "../common/scoringData";
/* tslint:enable:no-submodule-imports no-implicit-dependencies */
import NoteRibbon, { ribbonCounts } from "./NoteRibbon";
import "./ScoreCard.css";

export interface ScoredPerformance {
  result: ScoreResult;
  songName: string;
  artistName: string | null;
  nickname: string;
  profilePictureUrl: string | null;
  // Shaded on the ribbon. Passed in rather than derived here because Player
  // already parses the scoring data and computes these for the piano roll.
  instrumentalBreaks: readonly InstrumentalBreak[];
  // How many times this singer has sung this song, this play included. 0 when
  // history recording is off, or when the count query hasn't answered; both
  // read as "first time", which is why the copy below never prints the number
  // below 2.
  timesSung: number;
  // This singer's best stored score on this song *before* this take, or null
  // if they have none on the current formula. Fetched at song start so the
  // card shows the number that was there to beat.
  personalBest: { display: number; band: string } | null;
}

// A detail, not a metric: no ranking, nothing comparing one singer to another.
// Ordinals stop at "4th" and then go plain, because "23rd time" is funnier than
// a superscript.
function timesSungLabel(timesSung: number): string {
  switch (timesSung) {
    case 0:
    case 1:
      return "first time on this one";
    case 2:
      return "2nd time you've sung this";
    case 3:
      return "3rd time you've sung this";
    default:
      return `${timesSung}th time you've sung this`;
  }
}

function nicknameBadge(nickname: string) {
  const nicknameHash = cyrb53(nickname);
  return (
    <span
      className="scoreCardNickname"
      style={{
        backgroundColor: `hsl(${(nicknameHash % 180) + 180}, 100%, 50%)`,
        color: `hsl(${nicknameHash % 180}, 100%, 50%)`,
      }}
    >
      {nickname}
    </span>
  );
}

// One axis: its name, its score, a meter, and the raw fact behind it. The fact
// is the point. An unfamiliar metric is only trustworthy next to its
// evidence, and "81" means nothing until you know it's 53 held notes.
//
// An axis the song can't be judged on shows "—" and says why, rather than being
// quietly folded away: a missing axis leans the headline harder on pitch (see
// ScoreResult), so hiding it would overstate what the score measured.
function axisRow(
  key: string,
  labelJp: string,
  labelEn: string,
  value: number | null,
  note: string,
) {
  return (
    <div
      className={`scoreCardAxis scoreCardAxis${key}${
        value === null ? " scoreCardAxisAbsent" : ""
      }`}
      key={key}
    >
      <div className="scoreCardAxisName">
        {labelJp}
        <br />
        {labelEn}
      </div>
      <div className="scoreCardAxisValue">
        {value === null ? "—" : Math.round(value * 100)}
      </div>
      <div className="scoreCardMeter">
        {value === null ? null : (
          <i style={{ width: `${(value * 100).toFixed(1)}%` }} />
        )}
      </div>
      <div className="scoreCardAxisNote">{note}</div>
    </div>
  );
}

// EXPERIMENTAL end-of-song scoring card. Gated behind config.yaml's
// experimentalScoring; see src/common/scoring.ts for why the numbers are ours
// rather than DAM's.
export default function ScoreCard(props: {
  performance: ScoredPerformance;
  hiding: boolean;
}) {
  const {
    result,
    songName,
    artistName,
    nickname,
    profilePictureUrl,
    instrumentalBreaks,
    timesSung,
    personalBest,
  } = props.performance;
  const portraitUrl =
    profilePictureUrl === null
      ? null
      : resolveProfilePictureUrl(profilePictureUrl);
  const counts = ribbonCounts(result);
  const landed = counts.hit + counts.close;

  // Three decimals like the machines everyone recognises, so "you beat me by
  // 0.4" works. The integer part carries the reading from across the room; the
  // fraction is for the argument afterwards.
  const whole = Math.floor(result.display);
  const fraction = (result.display - whole).toFixed(3).slice(1);

  return (
    <div
      className={`scoreCard${props.hiding ? " scoreCardHiding" : ""}`}
      data-testid="scoreCard"
    >
      <div className="scoreCardTopRail">
        <span className="scoreCardTag">Experimental</span>
        <span className="scoreCardSpacer" />
        <span>
          {result.notesTotal} notes · fitted {Math.round(result.compensationMs)}
          ms
        </span>
      </div>

      <div className="scoreCardIdentity">
        <div className="scoreCardSinger">
          {portraitUrl ? (
            <img className="scoreCardPortrait" src={portraitUrl} alt="" />
          ) : null}
          {nicknameBadge(nickname)}
        </div>
        <div className={`scoreCardBand scoreCardBand${result.band}`}>
          {result.band}
        </div>
        <div className="scoreCardOverall">
          <span className="scoreCardOverallWhole">{whole}</span>
          <span className="scoreCardOverallFraction">{fraction}</span>
          <span className="scoreCardOverallUnit">pts</span>
        </div>
        <div className="scoreCardTimesSung">{timesSungLabel(timesSung)}</div>
        {/* Compared only against themselves. Nothing on this card ranks one
            singer against another. Beating it is the interesting case, so say
            so rather than making them do the subtraction. */}
        {personalBest === null ? null : (
          <div className="scoreCardTimesSung">
            {result.display > personalBest.display
              ? `beat your best of ${personalBest.display.toFixed(1)}`
              : `your best ${personalBest.display.toFixed(1)} ${personalBest.band}`}
          </div>
        )}
      </div>

      <div className="scoreCardMain">
        <div className="scoreCardSongLine">
          <div className="scoreCardSongName">{songName}</div>
          {artistName ? (
            <div className="scoreCardArtist">{artistName}</div>
          ) : null}
        </div>

        <div className="scoreCardAxes">
          {axisRow(
            "Pitch",
            "音程",
            "PITCH",
            result.pitch,
            `${landed} of ${result.notesTotal} notes landed`,
          )}
          {axisRow(
            "Long",
            "ロングトーン",
            "LONG TONE",
            result.longTone,
            result.longToneCount === 0
              ? "no note over a second"
              : `${result.longToneCount} held notes`,
          )}
          {axisRow(
            "Timing",
            "リズム",
            "TIMING",
            result.timing,
            result.timingSpreadMs === null
              ? `only ${result.timingCount} clean attacks`
              : `±${Math.round(result.timingSpreadMs)} ms spread`,
          )}
        </div>
      </div>

      <div className="scoreCardRibbonWrap">
        <NoteRibbon result={result} breaks={instrumentalBreaks} />
        <div className="scoreCardLegend">
          <span>
            <i style={{ background: "#5dff9b" }} />
            hit {counts.hit}
          </span>
          <span>
            <i style={{ background: "#ffd34d" }} />
            close {counts.close}
          </span>
          <span>
            <i style={{ background: "#ff6b81" }} />
            missed {counts.missed}
          </span>
          <span>
            <i style={{ background: "rgba(127,168,217,0.22)" }} />
            not sung {counts.unsung}
          </span>
          <span className="scoreCardLegendRight">
            best run {counts.bestRun} notes ·{" "}
            {Math.round((result.notesAttempted / result.notesTotal) * 100)}% of
            phrases sung
          </span>
        </div>
      </div>
    </div>
  );
}
