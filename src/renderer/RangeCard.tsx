import React from "react";

/* tslint:disable:no-submodule-imports no-implicit-dependencies */
import { cyrb53 } from "../common/hash";
import { resolveProfilePictureUrl } from "../common/profilePicture";
import { midiToNoteName } from "../common/tuningExercise";
import { VocalRangeResult } from "../common/vocalRange";
/* tslint:enable:no-submodule-imports no-implicit-dependencies */
import "./RangeCard.css";

// Shown when the guided warm-up ends. Sibling of ScoreCard, and deliberately
// NOT a score: no number out of 100, no band, no comparison to anyone else.
//
// It is headed "your range today" on purpose. A voice at 9pm and the same voice
// at 1am after four songs are different instruments, and a range stamped on
// somebody permanently is both wrong and the kind of thing people would take
// as a verdict on what they are allowed to sing. Nothing here tells anybody
// what to sing.
export interface MeasuredRange {
  result: VocalRangeResult;
  nickname: string;
  profilePictureUrl: string | null;
}

function nicknameBadge(nickname: string) {
  const nicknameHash = cyrb53(nickname);
  return (
    <span
      className="rangeCardNickname"
      style={{
        backgroundColor: `hsl(${(nicknameHash % 180) + 180}, 100%, 50%)`,
        color: `hsl(${nicknameHash % 180}, 100%, 50%)`,
      }}
    >
      {nickname}
    </span>
  );
}

// Semitones -> "2 octaves and 3 notes", which is how singers talk about it.
function spanLabel(lowMidi: number, highMidi: number): string {
  const semis = highMidi - lowMidi;
  const octaves = Math.floor(semis / 12);
  const rest = semis % 12;
  const parts: string[] = [];
  if (octaves > 0) parts.push(`${octaves} octave${octaves === 1 ? "" : "s"}`);
  if (rest > 0) parts.push(`${rest} note${rest === 1 ? "" : "s"}`);
  if (parts.length === 0) return "one note";
  return parts.join(" and ");
}

export default function RangeCard(props: {
  performance: MeasuredRange;
  hiding: boolean;
}) {
  const { result, nickname, profilePictureUrl } = props.performance;
  const portraitUrl =
    profilePictureUrl === null
      ? null
      : resolveProfilePictureUrl(profilePictureUrl);

  // Nobody sang. Say that plainly and warmly rather than reporting a range of
  // zero or a sad-looking empty ladder.
  if (result.lowMidi === null || result.highMidi === null) {
    return (
      <div className={`rangeCard${props.hiding ? " rangeCardHiding" : ""}`}>
        <div className="rangeCardEmpty">
          <div className="rangeCardEmptyTitle">didn't quite catch that</div>
          <div className="rangeCardEmptySub">
            The mic didn't pick up enough to measure. Give it another go
            whenever you like.
          </div>
        </div>
      </div>
    );
  }

  // The ladder spans the exercise, not the singing, so the notes nobody reached
  // still take up space, which is what makes "this is where it got hard"
  // legible instead of invisible.
  const measured = result.targets.filter((t) => t.phase !== "settle");
  const ladderLow = Math.min(...measured.map((t) => t.midiNumber));
  const ladderHigh = Math.max(...measured.map((t) => t.midiNumber));
  const ladderSpan = Math.max(1, ladderHigh - ladderLow);

  const comfortable =
    result.comfortableLowMidi !== null && result.comfortableHighMidi !== null;

  return (
    <div className={`rangeCard${props.hiding ? " rangeCardHiding" : ""}`}>
      <div className="rangeCardHeader">
        {portraitUrl ? (
          <img className="rangeCardPortrait" src={portraitUrl} alt="" />
        ) : null}
        <div className="rangeCardHeaderText">
          <div className="rangeCardTitle">
            {nicknameBadge(nickname)}
            <span className="rangeCardTitleTail">, your range today</span>
          </div>
        </div>
      </div>

      <div className="rangeCardHeadline">
        <span className="rangeCardNote">{midiToNoteName(result.lowMidi)}</span>
        <span className="rangeCardDash">–</span>
        <span className="rangeCardNote">{midiToNoteName(result.highMidi)}</span>
        <span className="rangeCardSpan">
          {spanLabel(result.lowMidi, result.highMidi)}
        </span>
      </div>

      {comfortable ? (
        <div className="rangeCardComfort">
          most comfortable around{" "}
          <b>{midiToNoteName(result.comfortableLowMidi!)}</b> to{" "}
          <b>{midiToNoteName(result.comfortableHighMidi!)}</b>
        </div>
      ) : null}

      <div className="rangeCardLadder">
        {measured.map((target) => {
          const position = ((target.midiNumber - ladderLow) / ladderSpan) * 100;
          const state = target.solid
            ? "Solid"
            : target.reached
              ? "Reached"
              : "Untried";
          return (
            <div
              key={target.index}
              className={`rangeCardRung rangeCardRung${state}`}
              style={{ left: `${position}%` }}
              title={midiToNoteName(target.midiNumber)}
            />
          );
        })}
        <div className="rangeCardLadderAxis">
          <span>{midiToNoteName(ladderLow)}</span>
          <span>{midiToNoteName(ladderHigh)}</span>
        </div>
      </div>

      <div className="rangeCardLegend">
        <span>
          <i className="rangeCardSwatchSolid" />
          comfortable
        </span>
        <span>
          <i className="rangeCardSwatchReached" />
          reached
        </span>
        <span>
          <i className="rangeCardSwatchUntried" />
          not this time
        </span>
      </div>

      {/* The exercise ran out before the voice did. Offered as "there's more
          up there", never as a limit. It is the one case where the
          measurement genuinely understates somebody. */}
      {result.hitFloor || result.hitCeiling ? (
        <div className="rangeCardMore">
          {result.hitFloor && result.hitCeiling
            ? "You went past both ends of the warm-up, so there's more range to find."
            : result.hitFloor
              ? "You reached the bottom of the warm-up. Try the lower-voices setting to find the rest."
              : "You reached the top of the warm-up. Try the higher-voices setting to find the rest."}
        </div>
      ) : null}
    </div>
  );
}
