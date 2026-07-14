// Shared parsing for the DAM-scoring-binary-format `scoringData` blob (see
// PianoRoll's original inline parser, and buildScoringData in
// guideMelody.ts, which is the JOYSOUND-side producer of this same layout).

export interface ScoringNote {
  startTime: number;
  endTime: number;
  midiNumber: number;
}

export interface ScoringInterval {
  startTime: number;
  endTime: number;
}

export interface ParsedScoringData {
  notes: ScoringNote[];
  lyricsIntervals: ScoringInterval[];
  // Gaps between sung phrases, including a leading intro gap (song start to
  // first phrase) and a trailing sentinel (last phrase to 9999) standing in
  // for "to the end of the song".
  freeTimeIntervals: ScoringInterval[];
  pogIntervals: ScoringInterval[];
}

export function parseScoringData(
  scoringData: readonly number[],
): ParsedScoringData {
  const view = new Uint32Array(Uint8Array.from(scoringData).buffer);
  const noteCount = view[1];
  const lyricsIntervalCount = view[2];
  const damTimeWindowIntervalCount = view[3];
  const pogIntervalCount = view[4];

  const notes: ScoringNote[] = [];
  const notesOffset = 6;
  for (let i = notesOffset; i < notesOffset + noteCount * 4; i += 4) {
    notes.push({
      startTime: view[i] / 1000,
      endTime: view[i + 1] / 1000,
      midiNumber: view[i + 2],
    });
  }

  const lyricsIntervals: ScoringInterval[] = [];
  const lyricsIntervalsOffset = notesOffset + noteCount * 4;
  for (
    let i = lyricsIntervalsOffset;
    i < lyricsIntervalsOffset + lyricsIntervalCount * 2;
    i += 2
  ) {
    lyricsIntervals.push({
      startTime: view[i] / 1000,
      endTime: view[i + 1] / 1000,
    });
  }

  const combinedLyricsIntervals = lyricsIntervals.reduce<ScoringInterval[]>(
    (acc, cur) => {
      if (acc.length === 0) {
        return [cur];
      }
      const prev = acc[acc.length - 1];
      if (cur.startTime - prev.endTime <= 10) {
        acc[acc.length - 1] = {
          startTime: prev.startTime,
          endTime: cur.endTime,
        };
        return acc;
      }
      return acc.concat([cur]);
    },
    [],
  );

  const [freeTimeIntervals, lastLyricsIntervalEnd] =
    combinedLyricsIntervals.reduce<[ScoringInterval[], number]>(
      (acc, cur) => {
        const [intervals, prevEnd] = acc;
        return [
          intervals.concat([{ startTime: prevEnd, endTime: cur.startTime }]),
          cur.endTime,
        ];
      },
      [[], 0],
    );
  freeTimeIntervals.push({ startTime: lastLyricsIntervalEnd, endTime: 9999 });

  const damTimeWindowIntervalsOffset =
    lyricsIntervalsOffset + lyricsIntervalCount * 2;

  const pogIntervals: ScoringInterval[] = [];
  const pogIntervalsOffset =
    damTimeWindowIntervalsOffset + damTimeWindowIntervalCount * 2;
  for (
    let i = pogIntervalsOffset;
    i < pogIntervalsOffset + pogIntervalCount * 2;
    i += 2
  ) {
    pogIntervals.push({
      startTime: view[i] / 1000,
      endTime: view[i + 1] / 1000,
    });
  }

  return { notes, lyricsIntervals, freeTimeIntervals, pogIntervals };
}

const INSTRUMENTAL_BREAK_MIN_SECS = 12;

export interface InstrumentalBreak {
  startTime: number;
  endTime: number;
  // Rounded for display, e.g. "約25秒" rather than a suspiciously precise
  // "約23秒" derived from guide-melody note gaps.
  approxDurationSecs: number;
}

// Interior gaps between sung phrases long enough to be a real instrumental
// break (間奏), not just a breath between lines. Excludes the leading intro
// gap (before any singing starts) and the trailing 9999 sentinel (the
// song's outro), neither of which is a mid-song break.
export function findInstrumentalBreaks(
  freeTimeIntervals: readonly ScoringInterval[],
): InstrumentalBreak[] {
  return freeTimeIntervals
    .slice(1, -1)
    .filter(
      ({ startTime, endTime }) =>
        endTime - startTime >= INSTRUMENTAL_BREAK_MIN_SECS,
    )
    .map(({ startTime, endTime }) => ({
      startTime,
      endTime,
      approxDurationSecs: Math.round((endTime - startTime) / 5) * 5,
    }));
}
