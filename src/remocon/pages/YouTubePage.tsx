import { invariant } from "ts-invariant";

import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import useNowPlaying from "../hooks/useNowPlaying";
import useUserIdentity from "../hooks/useUserIdentity";

import Button from "../components/Button";
import { withLoader } from "../components/Loader";
import SearchFormWrapper from "../components/SearchFormWrapper";
import YouTubeInfo from "../components/YouTubeInfo";

import { useNowPlayingQuery$data } from "../hooks/__generated__/useNowPlayingQuery.graphql";

export function getVideoId(videoQuery: string): string | null {
  try {
    const url = new URL(videoQuery);
    return url.hostname === "youtu.be"
      ? url.pathname.replace("/", "")
      : url.searchParams.get("v");
  } catch (e) {
    if (e instanceof Error && e.name !== "TypeError") {
      throw e;
    }
  }
  return videoQuery;
}

export function isYouTubeVideoWithLyricsPlaying(
  currentSong: useNowPlayingQuery$data["currentSong"] | null | undefined,
  videoId: string,
  nickname: string,
): boolean {
  if (!currentSong || currentSong.__typename !== "YoutubeQueueItem") {
    return false;
  }

  invariant(currentSong.hasAdhocLyrics !== undefined);

  return (
    currentSong.songId === videoId &&
    currentSong.userIdentity?.nickname === nickname &&
    currentSong.hasAdhocLyrics
  );
}

type YouTubeParams = {
  videoId: string;
};

const YouTubePage = () => {
  const navigate = useNavigate();
  const { nickname } = useUserIdentity();
  const currentSong = useNowPlaying();

  const params = useParams<YouTubeParams>();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);

  const [videoId, setVideoId] = useState<string>(params.videoId || "");

  // A row from the karaoke-channel search arrives with the song and artist
  // already parsed out of the video title, and those are what should land in
  // the queue -- "Mr. Brightside" by "The Killers", not "The Killers - Mr.
  // Brightside (Karaoke Version)". Pasting a different URL into the form
  // below drops them: they described the video we navigated in with.
  const routedSong = location.state as {
    name?: string;
    artistName?: string;
  } | null;
  const [songOverride, setSongOverride] = useState<{
    name: string;
    artistName: string;
  } | null>(
    routedSong?.name && routedSong?.artistName
      ? { name: routedSong.name, artistName: routedSong.artistName }
      : null,
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputRef.current) return;
    const newVideoId = getVideoId(inputRef.current.value);
    if (newVideoId !== null) {
      setVideoId(newVideoId);
      setSongOverride(null);
      history.replaceState({}, "", `#/search/youtube/${newVideoId}`);
    }
  };

  if (
    isYouTubeVideoWithLyricsPlaying(
      currentSong,
      videoId || params.videoId || "",
      nickname,
    )
  ) {
    navigate(`/adhocLyrics/${videoId || params.videoId || ""}`);
  }

  return (
    <SearchFormWrapper>
      <h2>Add YouTube video</h2>
      <form onSubmit={onSubmit}>
        <input
          ref={inputRef}
          placeholder="YouTube video URL or ID"
          defaultValue={videoId}
        />
        <Button type="submit">Get Video Info</Button>
      </form>
      {videoId !== "" && (
        <YouTubeInfo videoId={videoId} songOverride={songOverride} />
      )}
    </SearchFormWrapper>
  );
};

export default withLoader(YouTubePage);
