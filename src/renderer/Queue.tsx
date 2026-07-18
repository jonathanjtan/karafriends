import formatDuration from "format-duration";
import React from "react";

import SourceBadge from "../common/components/SourceBadge";
import { cyrb53 } from "../common/hash";
import useQueue from "../common/hooks/useQueue";
import { resolveProfilePictureUrl } from "../common/profilePicture";
import "./Queue.css";

export default function Queue() {
  const queue = useQueue();
  return (
    <div className="collection queueQueue">
      {queue.map(([item, eta], i) => {
        const nickname =
          (item.userIdentity && item.userIdentity.nickname) || "";
        const profilePictureUrl =
          (item.userIdentity && item.userIdentity.profilePictureUrl) || null;
        const nicknameHash = cyrb53(nickname);
        const nicknameColor = `hsl(${nicknameHash % 180}, 100%, 50%)`;
        const nicknameBgColor = `hsl(${(nicknameHash % 180) + 180}, 100%, 50%)`;
        const entry = (
          <>
            {item.name} - {item.artistName}{" "}
            <span
              style={{
                backgroundColor: nicknameBgColor,
                color: nicknameColor,
              }}
            >
              {profilePictureUrl && (
                <img
                  className={`queueNicknameAvatar${
                    item.userIdentity?.profilePictureFrame === "female"
                      ? " queueNicknameAvatarFemale"
                      : ""
                  }`}
                  src={resolveProfilePictureUrl(profilePictureUrl)}
                  alt=""
                />
              )}
              {nickname}
            </span>{" "}
          </>
        );
        return (
          <div
            key={`${item.songId}_${i}`}
            className="collection-item"
            style={{ display: "flex", gap: "0.5em" }}
          >
            <span className="queueMarquee">
              <span className="queueMarqueeInner">
                <span>
                  {entry}
                  {entry}
                  {entry}
                  {entry}
                </span>
              </span>
            </span>
            <SourceBadge
              typename={item.__typename}
              youtubeVideoId={
                "youtubeVideoId" in item ? item.youtubeVideoId : undefined
              }
              fontSize="0.75em"
            />
            <span className="secondary-content">
              {formatDuration(eta * 1000)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
