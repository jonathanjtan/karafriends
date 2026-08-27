import React, { useState } from "react";
import { fetchQuery, graphql } from "react-relay";

import environment from "../../../common/graphqlEnvironment";
import Button from "../Button";
import { SongLyricsQuery } from "./__generated__/SongLyricsQuery.graphql";

const songLyricsQuery = graphql`
  query SongLyricsQuery($source: SongSource!, $songId: String!) {
    songLyrics(source: $source, songId: $songId) {
      ... on SongLyrics {
        __typename
        lines
        source
        matchedSongId
        matchedName
        matchedArtistName
      }
      ... on SongLyricsError {
        __typename
        reason
      }
    }
  }
`;

// Enough of the lyrics to recognize the song and know what you're in for,
// without turning the song page into a scroll. The rest is one tap away.
const INITIAL_LINES_SHOWN = 12;

interface Match {
  songId: string | null;
  name: string | null;
  artistName: string | null;
}

interface Props {
  source: "DAM" | "JOYSOUND";
  songId: string;
  // The one truncated opening line the catalog itself publishes, shown until
  // someone asks for more.
  lyricsPreview: string | null | undefined;
}

const SongLyrics = ({ source, songId, lyricsPreview }: Props) => {
  const [loading, setLoading] = useState<boolean>(false);
  const [lines, setLines] = useState<readonly string[] | null>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState<boolean>(false);

  const onClickShowLyrics = () => {
    setLoading(true);
    setError(null);

    fetchQuery<SongLyricsQuery>(environment, songLyricsQuery, {
      source,
      songId,
    }).subscribe({
      next: (queryData) => {
        setLoading(false);

        const result = queryData.songLyrics;

        if (result.__typename === "SongLyrics") {
          setLines(result.lines);
          setMatch({
            songId: result.matchedSongId ?? null,
            name: result.matchedName ?? null,
            artistName: result.matchedArtistName ?? null,
          });
        } else if (result.__typename === "SongLyricsError") {
          setError(result.reason);
        }
      },
      error: (e: Error) => {
        setLoading(false);
        setError(e.message);
      },
    });
  };

  const visibleLines =
    lines && !showAll ? lines.slice(0, INITIAL_LINES_SHOWN) : lines;
  const hiddenLineCount = lines
    ? lines.length - (visibleLines?.length ?? 0)
    : 0;

  return (
    <>
      {visibleLines ? (
        <blockquote
          // Fully expanded, a long lyric is taller than the phone, which
          // would leave the queue buttons a 50-line scroll below the fold.
          // Cap it and let the lyrics scroll inside instead.
          style={showAll ? { maxHeight: "50vh", overflowY: "auto" } : undefined}
        >
          {visibleLines.map((line, i) => (
            <React.Fragment key={i}>
              {line}
              <br />
            </React.Fragment>
          ))}
          {hiddenLineCount > 0 && "..."}
        </blockquote>
      ) : (
        !!lyricsPreview && <blockquote>{lyricsPreview} ...</blockquote>
      )}
      {/* DAM publishes no lyrics, so a DAM song's lines are read off the
          matching JOYSOUND song. Say so rather than passing them off as
          DAM's, since a mismatch is the reader's to catch. */}
      {match?.name && (
        <p>
          Lyrics from JOYSOUND: {match.name} / {match.artistName}
        </p>
      )}
      {error && <p>{error}</p>}
      {hiddenLineCount > 0 ? (
        <Button
          full
          style={{ marginBottom: 8 }}
          onClick={() => setShowAll(true)}
        >
          Show {hiddenLineCount} more line{hiddenLineCount === 1 ? "" : "s"}
        </Button>
      ) : (
        !lines && (
          <Button
            full
            style={{ marginBottom: 8 }}
            disabled={loading}
            onClick={onClickShowLyrics}
          >
            {loading ? "Loading lyrics..." : "Show more lyrics"}
          </Button>
        )
      )}
    </>
  );
};

export default SongLyrics;
