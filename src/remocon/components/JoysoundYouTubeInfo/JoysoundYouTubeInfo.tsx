import React, { useEffect, useRef } from "react";
import { graphql, useLazyLoadQuery } from "react-relay";
import YouTubePlayer from "youtube-player";

import { withLoader } from "../Loader";
import VideoMetadata from "../VideoMetadata";
import * as styles from "./JoysoundYouTubeInfo.module.scss";
import { JoysoundYouTubeInfoVideoInfoQuery } from "./__generated__/JoysoundYouTubeInfoVideoInfoQuery.graphql";

const joysoundYouTubeInfoVideoInfoQuery = graphql`
  query JoysoundYouTubeInfoVideoInfoQuery($videoId: String!) {
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
  setYoutubeVideoId: (videoId: string) => void;
}

const JoysoundYouTubeInfo = ({ videoId, setYoutubeVideoId }: Props) => {
  const playerRef: React.MutableRefObject<ReturnType<
    typeof YouTubePlayer
  > | null> = useRef(null);
  const videoData = useLazyLoadQuery<JoysoundYouTubeInfoVideoInfoQuery>(
    joysoundYouTubeInfoVideoInfoQuery,
    { videoId },
  );

  const videoInfo = videoData.youtubeVideoInfo;
  // An embedded player shows a bare "Video unavailable" when the video is
  // region-locked out of the US (phones usually aren't on the VPN) or when
  // the uploader disabled embedding — fall back to the thumbnail instead.
  // Neither condition affects the actual karaoke playback: the download runs
  // on the (VPN'd) host machine.
  const canEmbed =
    videoInfo.__typename === "YoutubeVideoInfo" &&
    videoInfo.embeddable &&
    videoInfo.availableInUs !== false;

  useEffect(() => {
    if (canEmbed) {
      if (playerRef.current == null) {
        playerRef.current = YouTubePlayer("youtube-player", {
          videoId,
        });
      } else {
        playerRef.current.loadVideoById(videoId);
        playerRef.current.stopVideo();
      }
    } else if (playerRef.current != null) {
      // A previously embedded video may still be loaded (and even playing)
      // in the now-hidden iframe.
      playerRef.current.stopVideo();
    }

    if (videoId && videoInfo.__typename === "YoutubeVideoInfo") {
      setYoutubeVideoId(videoId);
    }
  }, [videoId, canEmbed]);

  return (
    <div className={styles.container}>
      <h3>Selected background video: {videoId}</h3>
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
              ? "This video is region-locked outside Japan, so it can't be previewed here — but it will still work as the background video."
              : "This video doesn't allow embedded previews — but it will still work as the background video."}
          </p>
        </>
      )}
      {videoInfo.__typename === "YoutubeVideoInfoError" && (
        <p>
          Unable to get video info for the following reason: {videoInfo.reason}
        </p>
      )}
      {videoInfo.__typename === "YoutubeVideoInfo" && (
        <VideoMetadata videoSource="youtube" videoInfo={videoInfo} />
      )}
    </div>
  );
};

export default withLoader(JoysoundYouTubeInfo);
