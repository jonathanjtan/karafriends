import React, { useEffect } from "react";
import { graphql, useLazyLoadQuery } from "react-relay";

import useYouTubeEmbed, {
  UNEMBEDDABLE_REASON_TEXT,
} from "../../hooks/useYouTubeEmbed";
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
  const videoData = useLazyLoadQuery<JoysoundYouTubeInfoVideoInfoQuery>(
    joysoundYouTubeInfoVideoInfoQuery,
    { videoId },
  );

  const videoInfo = videoData.youtubeVideoInfo;
  // An embedded player shows a bare "Video unavailable" when the video is
  // region-locked out of the US (phones usually aren't on the VPN), when the
  // uploader disabled embedding, or when the device trips a restriction the
  // host didn't see. Fall back to the thumbnail instead. None of that affects
  // the actual karaoke playback: the download runs on the (VPN'd) host.
  const { canEmbed, unembeddableReason, showThumbnailsInstead } =
    useYouTubeEmbed(
      videoId,
      videoInfo.__typename === "YoutubeVideoInfo" ? videoInfo : null,
    );

  useEffect(() => {
    if (videoId && videoInfo.__typename === "YoutubeVideoInfo") {
      setYoutubeVideoId(videoId);
    }
  }, [videoId, videoInfo.__typename]);

  return (
    <div className={styles.container}>
      <h3>
        Selected background video:{" "}
        <a
          className={styles.videoLink}
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noreferrer"
        >
          {videoId}
        </a>
      </h3>
      {/* The YouTube API replaces #youtube-player with its iframe, so React
          must never unmount it; visibility is toggled on this wrapper. */}
      <div style={{ display: canEmbed ? "block" : "none" }}>
        <div id="youtube-player" />
      </div>
      {videoInfo.__typename === "YoutubeVideoInfo" && (
        <>
          {!canEmbed && (
            <img
              className={styles.thumbnail}
              src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
              alt={videoInfo.title}
            />
          )}
          {/* YouTube auto-generates stills at 25/50/75% of every video at
              predictable URLs, a quick way to check the content without
              scrubbing through it. */}
          <div className={styles.stills}>
            {[1, 2, 3].map((n) => (
              <img
                key={n}
                src={`https://i.ytimg.com/vi/${videoId}/mq${n}.jpg`}
                alt=""
              />
            ))}
          </div>
          {canEmbed ? (
            <button
              className={styles.embedFallbackButton}
              onClick={showThumbnailsInstead}
            >
              Preview says "Video unavailable"? Show stills instead
            </button>
          ) : (
            <p>
              {unembeddableReason
                ? `${UNEMBEDDABLE_REASON_TEXT[unembeddableReason]}, but it will still work as the background video.`
                : "It will still work as the background video."}
            </p>
          )}
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
