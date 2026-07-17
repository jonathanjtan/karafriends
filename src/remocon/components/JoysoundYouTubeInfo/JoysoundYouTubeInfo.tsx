import React, { useEffect } from "react";
import { graphql, useLazyLoadQuery } from "react-relay";

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

  useEffect(() => {
    if (videoId && videoInfo.__typename === "YoutubeVideoInfo") {
      setYoutubeVideoId(videoId);
    }
  }, [videoId]);

  return (
    <div className={styles.container}>
      <h3>Selected background video: {videoId}</h3>
      {videoInfo.__typename === "YoutubeVideoInfo" && (
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
          {/* Neither condition affects the actual karaoke playback: the
              download runs on the (VPN'd) host machine. */}
          {videoInfo.availableInUs === false && (
            <p>
              This video is region-locked outside Japan, but it will still work
              as the background video.
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
