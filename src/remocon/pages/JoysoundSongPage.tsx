import formatDuration from "format-duration";
import React, { useRef, useState } from "react";
import { fetchQuery, graphql, useLazyLoadQuery } from "react-relay";
import { Link, useParams } from "react-router";

import environment from "../../common/graphqlEnvironment";
import Button from "../components/Button";
import JoysoundQueueButtons from "../components/JoysoundQueueButtons";
import JoysoundYouTubeInfo from "../components/JoysoundYouTubeInfo";
import { List, ListItem } from "../components/List";
import { withLoader } from "../components/Loader";
import SearchFormWrapper from "../components/SearchFormWrapper";
import SongLyrics from "../components/SongLyrics";
import WeebText from "../components/WeebText";
import { JoysoundSongPageQuery } from "./__generated__/JoysoundSongPageQuery.graphql";
import { JoysoundSongPageSuggestedYoutubeVideosQuery } from "./__generated__/JoysoundSongPageSuggestedYoutubeVideosQuery.graphql";

import { getVideoId as getYoutubeVideoId } from "./YouTubePage";

const joysoundSongPageQuery = graphql`
  query JoysoundSongPageQuery($id: String!) {
    joysoundSongDetail(id: $id) {
      id
      name
      nameYomi
      artistName
      artistNameYomi
      lyricsPreview
      tieUp
      lastYoutubeVideoId
      lastYoutubeVideoSyncEnabled
    }
  }
`;

const joysoundSongPageSuggestedYoutubeVideosQuery = graphql`
  query JoysoundSongPageSuggestedYoutubeVideosQuery($songId: String!) {
    suggestedYoutubeVideos(songId: $songId) {
      ... on SuggestedYoutubeVideos {
        __typename
        videos {
          videoId
          title
          author
          lengthSeconds
          isLikelyOfficial
        }
      }
      ... on SuggestedYoutubeVideoError {
        __typename
        reason
      }
    }
  }
`;

// The server returns up to 6 ranked candidates; show the top few by default
// with the rest behind a "show more" button.
const INITIAL_LUCKY_CANDIDATES_SHOWN = 3;

interface LuckyCandidate {
  videoId: string;
  title: string;
  author: string;
  lengthSeconds: number;
  isLikelyOfficial: boolean;
}

type RouteParams = {
  id: string;
  youtubeVideoId?: string;
};

const JoysoundSongPage = () => {
  const params = useParams<RouteParams>();
  const inputRef = useRef<HTMLInputElement>(null);

  const data = useLazyLoadQuery<JoysoundSongPageQuery>(joysoundSongPageQuery, {
    id: params.id!,
  });

  const song = data.joysoundSongDetail;

  // Default to the video this song was last queued with (if any), so picking
  // the same song again doesn't require another YouTube search. An explicit
  // URL param (e.g. from a rewritten hash) still wins.
  const [youtubeVideoId, setYoutubeVideoId] = useState<string>(
    params.youtubeVideoId || song.lastYoutubeVideoId || "",
  );
  const [validatedYoutubeId, setValidatedYoutubeVideoId] = useState<string>("");
  const [youtubeVideoSyncEnabled, setYoutubeVideoSyncEnabled] =
    useState<boolean>(song.lastYoutubeVideoSyncEnabled ?? true);
  const [waitForVideoIdInput, setWaitForVideoIdInput] =
    useState<boolean>(false);
  const [luckyLoading, setLuckyLoading] = useState<boolean>(false);
  const [luckyCandidates, setLuckyCandidates] = useState<
    readonly LuckyCandidate[] | null
  >(null);
  const [luckyError, setLuckyError] = useState<string | null>(null);
  const [showAllLuckyCandidates, setShowAllLuckyCandidates] =
    useState<boolean>(false);
  const clearLuckyState = () => {
    setLuckyLoading(false);
    setLuckyCandidates(null);
    setLuckyError(null);
    setShowAllLuckyCandidates(false);
  };

  const onClickImFeelingLucky = () => {
    setLuckyLoading(true);
    setLuckyCandidates(null);
    setLuckyError(null);
    setShowAllLuckyCandidates(false);

    fetchQuery<JoysoundSongPageSuggestedYoutubeVideosQuery>(
      environment,
      joysoundSongPageSuggestedYoutubeVideosQuery,
      { songId: song.id },
    ).subscribe({
      next: (queryData) => {
        setLuckyLoading(false);

        const result = queryData.suggestedYoutubeVideos;

        if (result.__typename === "SuggestedYoutubeVideos") {
          setLuckyCandidates(result.videos);
        } else if (result.__typename === "SuggestedYoutubeVideoError") {
          setLuckyError(result.reason);
        }
      },
      error: (e: Error) => {
        setLuckyLoading(false);
        setLuckyError(e.message);
      },
    });
  };

  const onPickLuckyCandidate = (candidateVideoId: string) => {
    setYoutubeVideoId(candidateVideoId);
    // Re-gate the queue buttons on the new video's validation. A stale
    // validated ID would otherwise queue the previously selected video (or
    // one whose validation failed) while the UI shows the new pick.
    setValidatedYoutubeVideoId("");
    // Picking a suggestion IS setting the video. Leaving the URL form open
    // behind it (with a "Set video" button still to press) reads as if the
    // pick hadn't taken.
    setWaitForVideoIdInput(false);
    clearLuckyState();

    history.replaceState(
      {},
      "",
      `#/joysoundSong/${song.id}/${candidateVideoId}`,
    );
  };

  const onSubmitYoutubeForm = (e: React.FormEvent) => {
    e.preventDefault();

    if (!inputRef.current) return;

    const newYoutubeVideoId = getYoutubeVideoId(inputRef.current.value);

    if (newYoutubeVideoId !== null) {
      setYoutubeVideoId(newYoutubeVideoId);
      // Same re-gating as onPickLuckyCandidate: don't let a previously
      // validated video satisfy the new one's validation.
      setValidatedYoutubeVideoId("");
      setWaitForVideoIdInput(false);

      history.replaceState(
        {},
        "",
        `#/joysoundSong/${song.id}/${newYoutubeVideoId}`,
      );
    }
  };

  const detachVideo = () => {
    setYoutubeVideoId("");
    setValidatedYoutubeVideoId("");
    clearLuckyState();

    history.replaceState({}, "", `#/joysoundSong/${song.id}`);
  };

  const visibleLuckyCandidates =
    luckyCandidates && !showAllLuckyCandidates
      ? luckyCandidates.slice(0, INITIAL_LUCKY_CANDIDATES_SHOWN)
      : luckyCandidates;
  const hiddenLuckyCandidateCount = luckyCandidates
    ? luckyCandidates.length - (visibleLuckyCandidates?.length ?? 0)
    : 0;

  return (
    <div>
      <h2 data-subject>
        <WeebText bold text={song.name} yomi={song.nameYomi} />
      </h2>
      <Link to={`/search/artist/${song.artistName}`}>
        <WeebText text={song.artistName} yomi={song.artistNameYomi} />
      </Link>
      {!!song.tieUp && <span> • {song.tieUp}</span>}
      <SongLyrics
        source="JOYSOUND"
        songId={song.id}
        lyricsPreview={song.lyricsPreview}
      />
      {youtubeVideoId ? (
        <>
          <Button full onClick={() => detachVideo()}>
            Detach YouTube video
          </Button>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              margin: "8px 0 20px",
            }}
          >
            <input
              type="checkbox"
              checked={youtubeVideoSyncEnabled}
              onChange={(e) => setYoutubeVideoSyncEnabled(e.target.checked)}
            />
            Sync video to karaoke (Recommended, takes a sec!)
          </label>
        </>
      ) : (
        <>
          <Button
            full
            onClick={() => setWaitForVideoIdInput(!waitForVideoIdInput)}
          >
            {waitForVideoIdInput
              ? "Cancel"
              : "Set background video from YouTube URL"}
          </Button>
          <Button
            full
            style={{ marginTop: 8 }}
            disabled={luckyLoading}
            onClick={onClickImFeelingLucky}
          >
            {luckyLoading
              ? "Searching YouTube..."
              : "Suggest background video from YouTube"}
          </Button>
        </>
      )}
      {luckyError && <p>{luckyError}</p>}
      {visibleLuckyCandidates && (
        <List>
          {visibleLuckyCandidates.map((candidate) => (
            <div
              key={candidate.videoId}
              onClick={() => onPickLuckyCandidate(candidate.videoId)}
            >
              <ListItem>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <img
                    src={`https://i.ytimg.com/vi/${candidate.videoId}/mqdefault.jpg`}
                    alt=""
                    width={80}
                    height={45}
                    style={{ flexShrink: 0, objectFit: "cover" }}
                  />
                  <div>
                    <div>{candidate.title}</div>
                    <div>
                      {candidate.author} •{" "}
                      {formatDuration(candidate.lengthSeconds * 1000)}
                    </div>
                  </div>
                </div>
              </ListItem>
            </div>
          ))}
        </List>
      )}
      {hiddenLuckyCandidateCount > 0 && (
        <Button full onClick={() => setShowAllLuckyCandidates(true)}>
          Show {hiddenLuckyCandidateCount} more option
          {hiddenLuckyCandidateCount === 1 ? "" : "s"}
        </Button>
      )}
      {waitForVideoIdInput ? (
        <SearchFormWrapper>
          <form onSubmit={onSubmitYoutubeForm}>
            <input
              ref={inputRef}
              placeholder="Youtube video URL or ID"
              defaultValue={youtubeVideoId}
            />
            <Button full type="submit">
              Set video
            </Button>
          </form>
        </SearchFormWrapper>
      ) : (
        <>
          <JoysoundQueueButtons
            song={song}
            youtubeVideoId={youtubeVideoId}
            validatedYoutubeId={validatedYoutubeId}
            youtubeVideoSyncEnabled={youtubeVideoSyncEnabled}
          />
          {youtubeVideoId !== "" && (
            <JoysoundYouTubeInfo
              videoId={youtubeVideoId}
              setYoutubeVideoId={setValidatedYoutubeVideoId}
            />
          )}
        </>
      )}
    </div>
  );
};

export default withLoader(JoysoundSongPage);
