import formatDuration from "format-duration";
import React, { useState } from "react";
/* tslint:disable:no-submodule-imports */
import { MdArrowDownward, MdArrowUpward, MdClose } from "react-icons/md";
/* tslint:enable:no-submodule-imports */
import { graphql, useMutation } from "react-relay";
import { useNavigate } from "react-router";

import SourceBadge from "../../../common/components/SourceBadge";
import { cyrb53 } from "../../../common/hash";
import { useQueueQueueQuery$data } from "../../../common/hooks/__generated__/useQueueQueueQuery.graphql";
import useConfig from "../../hooks/useConfig";
import useUserIdentity from "../../hooks/useUserIdentity";
import Marquee from "../Marquee";
import WeebText from "../WeebText";
import * as styles from "./SongQueue.module.scss";
import { SongQueueItemMoveSongMutation } from "./__generated__/SongQueueItemMoveSongMutation.graphql";
import { SongQueueItemRemoveSongMutation } from "./__generated__/SongQueueItemRemoveSongMutation.graphql";

const removeSongMutation = graphql`
  mutation SongQueueItemRemoveSongMutation(
    $songId: String!
    $timestamp: String!
  ) {
    removeSong(songId: $songId, timestamp: $timestamp)
  }
`;

const moveSongMutation = graphql`
  mutation SongQueueItemMoveSongMutation(
    $songId: String!
    $timestamp: String!
    $offset: Int!
  ) {
    moveSong(songId: $songId, timestamp: $timestamp, offset: $offset)
  }
`;

interface Props {
  item: useQueueQueueQuery$data["queue"][0];
  eta: number;
  myNickname: string;
  isCurrent?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

const SongQueueItem = ({
  item,
  eta,
  myNickname,
  isCurrent,
  canMoveUp,
  canMoveDown,
}: Props) => {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [commit, isInFlight] = useMutation(removeSongMutation);
  const [commitMove, isMoveInFlight] =
    useMutation<SongQueueItemMoveSongMutation>(moveSongMutation);

  const config = useConfig();
  const identity = useUserIdentity();

  let canRemove = true;

  // Config finally loaded, let's evaluate things
  if (config !== undefined) {
    // personId is the real owner key; the nickname/deviceId comparison is the
    // fallback for items queued before the registry existed. (It used to
    // compare the item's deviceId against *our nickname*, which never
    // matched — supervised mode was leaning entirely on the name.)
    const itemOwnedByUser =
      identity.personId && item.userIdentity!.personId
        ? item.userIdentity!.personId === identity.personId
        : item.userIdentity!.nickname === identity.nickname ||
          item.userIdentity!.deviceId === identity.deviceId;
    canRemove =
      config.adminNicks.includes(identity.nickname) ||
      config.adminDeviceIds.includes(identity.deviceId) ||
      !(config.supervisedMode === true && !itemOwnedByUser);
  }

  const itemType = item.__typename;
  const nickname =
    (item.userIdentity && item.userIdentity.nickname) || "Unknown";
  const profilePictureUrl =
    (item.userIdentity && item.userIdentity.profilePictureUrl) || null;
  const avatarClassName = `${styles.avatar}${
    item.userIdentity?.profilePictureFrame === "female"
      ? ` ${styles.avatarFemale}`
      : ""
  }`;
  const nicknameHash = cyrb53(nickname);
  const nicknameBgColor = `hsl(${(nicknameHash % 180) + 180}, 50%, 50%)`;

  const onClick = () => {
    if (itemType === "DamQueueItem") navigate(`/song/${item.songId}`);
    if (itemType === "JoysoundQueueItem")
      navigate(`/joysoundSong/${item.songId}`);
    if (itemType === "YoutubeQueueItem")
      navigate(`/search/youtube/${item.songId}`);
    if (itemType === "NicoQueueItem")
      navigate(`/search/niconico/${item.songId}`);
  };

  const onRemove = (songId?: string, timestamp?: string) => {
    commit({ variables: { songId, timestamp } });
  };

  const onMove = (offset: number) => {
    if (!item.songId || !item.timestamp || isMoveInFlight) return;
    commitMove({
      variables: { songId: item.songId, timestamp: item.timestamp, offset },
    });
  };

  return (
    <div className={styles.queueItem}>
      {expanded ? (
        <div className={styles.controls}>
          <div
            className={styles.nickname}
            style={{ backgroundColor: nicknameBgColor }}
            onClick={() => setExpanded(false)}
          >
            {profilePictureUrl && (
              <img className={avatarClassName} src={profilePictureUrl} alt="" />
            )}
            {nickname}
          </div>
          {item.songId && item.timestamp && !isCurrent && canRemove && (
            <>
              {canMoveUp && (
                <div className={styles.move} onClick={() => onMove(-1)}>
                  <MdArrowUpward />
                </div>
              )}
              {canMoveDown && (
                <div className={styles.move} onClick={() => onMove(1)}>
                  <MdArrowDownward />
                </div>
              )}
              <div
                className={styles.remove}
                onClick={() => onRemove(item.songId, item.timestamp)}
              >
                <MdClose />
              </div>
            </>
          )}
        </div>
      ) : (
        <div
          className={styles.initial}
          style={
            profilePictureUrl ? undefined : { backgroundColor: nicknameBgColor }
          }
          onClick={() => setExpanded(true)}
        >
          {profilePictureUrl ? (
            <img className={avatarClassName} src={profilePictureUrl} alt="" />
          ) : (
            nickname.slice(0, 1)
          )}
        </div>
      )}
      <div className={styles.songMeta} onClick={onClick}>
        <Marquee>
          <div className={styles.songMetaContent}>
            <WeebText
              text={item.artistName ?? ""}
              yomi={item.artistNameYomi ?? ""}
            />{" "}
            - <WeebText text={item.name ?? ""} yomi={item.nameYomi ?? ""} />
          </div>
        </Marquee>
      </div>
      <SourceBadge
        typename={itemType}
        youtubeVideoId={
          "youtubeVideoId" in item ? item.youtubeVideoId : undefined
        }
        fontSize="11px"
      />
      {!isCurrent && <div>+{formatDuration(eta * 1000)}</div>}
    </div>
  );
};

export default SongQueueItem;
