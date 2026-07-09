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

  const [youtubeVideoId, setYoutubeVideoId] = useState<string>(
    params.youtubeVideoId || "",
  );
  const [validatedYoutubeId, setValidatedYoutubeVideoId] = useState<string>("");
  const [youtubeVideoSyncEnabled, setYoutubeVideoSyncEnabled] =
    useState<boolean>(true);
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

  const isConfidentLuckyPick =
    !!luckyCandidates &&
    luckyCandidates.length > 1 &&
    luckyCandidates[0].isLikelyOfficial;
  const visibleLuckyCandidates =
    isConfidentLuckyPick && !showAllLuckyCandidates
      ? luckyCandidates!.slice(0, 1)
      : luckyCandidates;
  const hiddenLuckyCandidateCount = luckyCandidates
    ? luckyCandidates.length - (visibleLuckyCandidates?.length ?? 0)
    : 0;

  return (
    <div>
      <h2>
        <WeebText bold text={song.name} yomi={song.nameYomi} />
      </h2>
      <Link to={`/search/artist/${song.artistName}`}>
        <WeebText text={song.artistName} yomi={song.artistNameYomi} />
      </Link>
      {!!song.tieUp && <span> • {song.tieUp}</span>}
      {!!song.lyricsPreview && (
        <blockquote>{song.lyricsPreview} ...</blockquote>
      )}
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
              margin: "8px 0",
            }}
          >
            <input
              type="checkbox"
              checked={youtubeVideoSyncEnabled}
              onChange={(e) => setYoutubeVideoSyncEnabled(e.target.checked)}
            />
            Sync video timing to karaoke track
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
              : "Set background video from YouTube"}
          </Button>
          <Button
            full
            style={{ marginTop: 8 }}
            disabled={luckyLoading}
            onClick={onClickImFeelingLucky}
          >
            {luckyLoading
              ? "Searching YouTube..."
              : "Search background video from Youtube"}
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
