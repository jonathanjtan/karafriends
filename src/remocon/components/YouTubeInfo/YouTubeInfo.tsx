import React, { useEffect, useRef, useState } from "react";
import { graphql, useLazyLoadQuery } from "react-relay";
import { Link } from "react-router";
import YouTubePlayer from "youtube-player";

import useUserIdentity from "../../hooks/useUserIdentity";
import Button from "../Button";
import { withLoader } from "../Loader";
import VideoMetadata from "../VideoMetadata";
import * as styles from "./YouTubeInfo.module.scss";
import YouTubeLyricsForm from "./YouTubeLyricsForm";
import YouTubeQueueButton from "./YouTubeQueueButton";
import { YouTubeInfoVideoInfoQuery } from "./__generated__/YouTubeInfoVideoInfoQuery.graphql";

const youTubeInfoVideoInfoQuery = graphql`
  query YouTubeInfoVideoInfoQuery($videoId: String!) {
    youtubeVideoInfo(videoId: $videoId) {
      ... on YoutubeVideoInfo {
        __typename
        author
        availableInUs
        captionLanguages {
          name
          code
        }
        channelId
        embeddable
        keywords
        lengthSeconds
        title
        viewCount
        gainValue
      }
      ... on YoutubeVideoInfoError {
        __typename
        reason
      }
    }
  }
`;

interface Props {
  videoId: string;
}

const YouTubeInfo = ({ videoId }: Props) => {
  const userIdentity = useUserIdentity();

  const playerRef: React.MutableRefObject<ReturnType<
    typeof YouTubePlayer
  > | null> = useRef(null);
  const [adhocSongLyrics, setAdhocSongLyrics] = useState<string | null>(null);
  const [selectedCaption, setSelectedCaption] = useState<string | undefined>(
    undefined,
  );

  const videoData = useLazyLoadQuery<YouTubeInfoVideoInfoQuery>(
    youTubeInfoVideoInfoQuery,
    { videoId },
  );

  const videoInfo = videoData.youtubeVideoInfo;
  // An embedded player shows a bare "Video unavailable" when the video is
  // region-locked out of the US (phones usually aren't on the VPN) or when
  // the uploader disabled embedding — fall back to the thumbnail instead.
  // Neither condition affects playback: the download runs on the VPN'd host.
  const canEmbed =
    videoInfo.__typename === "YoutubeVideoInfo" &&
    videoInfo.embeddable &&
    videoInfo.availableInUs !== false;

  useEffect(() => {
    if (canEmbed) {
      if (playerRef.current == null) {
        playerRef.current = YouTubePlayer("youtube-player", { videoId });
      } else {
        playerRef.current.loadVideoById(videoId);
        playerRef.current.stopVideo();
      }
    } else if (playerRef.current != null) {
      // A previously embedded video may still be loaded (and even playing)
      // in the now-hidden iframe.
      playerRef.current.stopVideo();
    }
  }, [videoId, canEmbed]);

  return (
    <div className={styles.container}>
      {/* The YouTube API replaces #youtube-player with its iframe, so React
          must never unmount it; visibility is toggled on this wrapper. */}
      <div style={{ display: canEmbed ? "block" : "none" }}>
        <div id="youtube-player" />
      </div>
      {videoInfo.__typename === "YoutubeVideoInfo" && !canEmbed && (
        <>
          <img
            className={styles.thumbnail}
            src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
            alt={videoInfo.title}
          />
          {/* YouTube auto-generates stills at 25/50/75% of every video at
              predictable URLs — a quick way to check the content without a
              playable embed. */}
          <div className={styles.stills}>
            {[1, 2, 3].map((n) => (
              <img
                key={n}
                src={`https://i.ytimg.com/vi/${videoId}/mq${n}.jpg`}
                alt=""
              />
            ))}
          </div>
          <p>
            {videoInfo.availableInUs === false
              ? "This video is region-locked outside Japan, so it can't be previewed here — but it can still be queued and played."
              : "This video doesn't allow embedded previews — but it can still be queued and played."}
          </p>
        </>
      )}
      {videoData.youtubeVideoInfo.__typename === "YoutubeVideoInfoError" && (
        <div>
          Unable to get video info for the following reason:{" "}
          {videoData.youtubeVideoInfo.reason}
        </div>
      )}
      {videoData.youtubeVideoInfo.__typename === "YoutubeVideoInfo" && (
        <>
          <VideoMetadata
            videoSource="youtube"
            videoInfo={videoData.youtubeVideoInfo}
          />
          <YouTubeLyricsForm
            videoInfo={videoData.youtubeVideoInfo}
            onSelectCaption={(language) => setSelectedCaption(language)}
            onAdhocLyricsChanged={(lyrics) => setAdhocSongLyrics(lyrics)}
          />
          <YouTubeQueueButton
            videoId={videoId}
            videoInfo={videoData.youtubeVideoInfo}
            adhocSongLyrics={adhocSongLyrics}
            selectedCaption={selectedCaption || null}
            userIdentity={userIdentity}
          />
        </>
      )}
    </div>
  );
};

export default withLoader(YouTubeInfo);
