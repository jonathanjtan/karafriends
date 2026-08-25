import React, { useState } from "react";
import { graphql, useLazyLoadQuery } from "react-relay";

import useUserIdentity from "../../hooks/useUserIdentity";
import useYouTubeEmbed, {
  UNEMBEDDABLE_REASON_TEXT,
} from "../../hooks/useYouTubeEmbed";
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
  // Song and artist parsed from the video title by the karaoke-channel
  // search, when that's where this page was opened from. Null when a URL was
  // pasted in by hand, in which case the video's own title and uploader are
  // all there is to go on.
  songOverride?: { name: string; artistName: string } | null;
}

const YouTubeInfo = ({ videoId, songOverride = null }: Props) => {
  const userIdentity = useUserIdentity();

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
  // region-locked out of the US (phones usually aren't on the VPN), when the
  // uploader disabled embedding, or when the device trips a restriction the
  // host didn't see. Fall back to the thumbnail instead. None of that affects
  // playback: the download runs on the VPN'd host.
  const { canEmbed, unembeddableReason, showThumbnailsInstead } =
    useYouTubeEmbed(
      videoId,
      videoInfo.__typename === "YoutubeVideoInfo" ? videoInfo : null,
    );

  return (
    <div className={styles.container}>
      {/* The YouTube API replaces #youtube-player with its iframe, so React
          must never unmount it; visibility is toggled on this wrapper. */}
      <div style={{ display: canEmbed ? "block" : "none" }}>
        <div id="youtube-player" />
      </div>
      {videoInfo.__typename === "YoutubeVideoInfo" && canEmbed && (
        <button
          className={styles.embedFallbackButton}
          onClick={showThumbnailsInstead}
        >
          Preview says "Video unavailable"? Show stills instead
        </button>
      )}
      {videoInfo.__typename === "YoutubeVideoInfo" && !canEmbed && (
        <>
          <img
            className={styles.thumbnail}
            src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
            alt={videoInfo.title}
          />
          {/* YouTube auto-generates stills at 25/50/75% of every video at
              predictable URLs, a quick way to check the content without a
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
            {unembeddableReason
              ? `${UNEMBEDDABLE_REASON_TEXT[unembeddableReason]}, but it can still be queued and played.`
              : "It can still be queued and played."}{" "}
            <a
              className={styles.videoLink}
              href={`https://www.youtube.com/watch?v=${videoId}`}
              target="_blank"
              rel="noreferrer"
            >
              Watch on YouTube
            </a>
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
            songOverride={songOverride}
          />
        </>
      )}
    </div>
  );
};

export default withLoader(YouTubeInfo);
