import formatDuration from "format-duration";
import React, { useEffect, useState } from "react";

import { cyrb53 } from "../common/hash";
import useQueue from "../common/hooks/useQueue";
import QRCode from "./QRCode";
import "./QueueIntermission.css";

const MAX_VISIBLE_UPCOMING = 6;

function nicknameBadge(nickname: string, profilePictureUrl?: string | null) {
  const nicknameHash = cyrb53(nickname);
  return (
    <span
      className="queueIntermissionNickname"
      style={{
        backgroundColor: `hsl(${(nicknameHash % 180) + 180}, 100%, 50%)`,
        color: `hsl(${nicknameHash % 180}, 100%, 50%)`,
      }}
    >
      {profilePictureUrl ? (
        <img
          className="queueIntermissionAvatar"
          src={profilePictureUrl}
          alt=""
        />
      ) : null}
      {nickname}
    </span>
  );
}

// Fullscreen between-songs queue screen (like a real DAM/JOYSOUND machine):
// the song about to play up top, then the next few reservations. With an
// empty queue it doubles as the idle screen, inviting people to scan the QR
// code and add songs.
export default function QueueIntermission(props: {
  queue: ReturnType<typeof useQueue>;
  hostname: string;
  // True while fading out; the parent unmounts after the animation runs.
  hiding?: boolean;
  // Epoch ms when the current break ends; null when not on break.
  breakEndsAt?: number | null;
  // Custom message to show while on break, if any.
  breakMessage?: { text: string; author: string | null } | null;
  // Canonical name of the BGM track currently audible, if any.
  bgmNowPlaying?: string | null;
}) {
  // Tick while a break is active so the countdown counts down.
  const [now, setNow] = useState(() => Date.now());
  const breakActive =
    props.breakEndsAt != null && props.breakEndsAt > Date.now();
  useEffect(() => {
    if (!breakActive) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [breakActive]);
  const breakRemainingMs = breakActive
    ? Math.max(props.breakEndsAt! - now, 0)
    : 0;

  const [nextUp, ...upcoming] = props.queue;
  const hiddenCount = Math.max(upcoming.length - MAX_VISIBLE_UPCOMING, 0);
  // useQueue's ETAs are seeded with the current song's full playtime, but
  // during the intermission that song has already finished — rebase so each
  // row shows time-until-it-starts measured from the next song starting now.
  const baseEta = nextUp ? nextUp[1] : 0;

  return (
    <div
      className={`queueIntermission ${
        props.hiding ? "queueIntermissionHiding" : ""
      }`}
    >
      <div className="queueIntermissionQr">
        <QRCode hostname={props.hostname} />
      </div>
      <div className="queueIntermissionQrInverted">
        <QRCode hostname={props.hostname} inverted />
      </div>
      {props.bgmNowPlaying ? (
        <div className="queueIntermissionNowPlayingBgm">
          ♪ Now Playing: {props.bgmNowPlaying}
        </div>
      ) : null}
      {breakActive ? (
        <div className="queueIntermissionBreak">
          休憩中 / On Break —{" "}
          {props.queue.length > 0
            ? `Up next in ${formatDuration(breakRemainingMs)}...`
            : `Break ends in ${formatDuration(breakRemainingMs)}...`}
        </div>
      ) : null}
      {breakActive && props.breakMessage ? (
        <div className="queueIntermissionBreakMessage">
          {props.breakMessage.text}{" "}
          {props.breakMessage.author
            ? nicknameBadge(props.breakMessage.author)
            : null}
        </div>
      ) : null}
      <div className="queueIntermissionHeader">次の演奏曲 / Up Next</div>
      {nextUp ? (
        <div className="queueIntermissionNextUp">
          <div className="queueIntermissionSongName">{nextUp[0].name}</div>
          <div className="queueIntermissionArtistName">
            {nextUp[0].artistName}{" "}
            {nicknameBadge(
              nextUp[0].userIdentity?.nickname || "",
              nextUp[0].userIdentity?.profilePictureUrl,
            )}
          </div>
        </div>
      ) : (
        <div className="queueIntermissionNextUp">
          <div className="queueIntermissionSongName">Nothing...</div>
          <div className="queueIntermissionArtistName">
            waiting for songs — scan a QR code to queue
          </div>
        </div>
      )}
      {upcoming.length > 0 && (
        <div className="queueIntermissionUpcoming">
          {upcoming.slice(0, MAX_VISIBLE_UPCOMING).map(([item, eta], i) => (
            <div
              key={`${item.songId}_${i}`}
              className="queueIntermissionUpcomingItem"
            >
              <span className="queueIntermissionUpcomingIndex">{i + 1}</span>
              <span className="queueIntermissionUpcomingSong">
                {item.name} - {item.artistName}{" "}
                {nicknameBadge(
                  item.userIdentity?.nickname || "",
                  item.userIdentity?.profilePictureUrl,
                )}
              </span>
              <span className="queueIntermissionUpcomingEta">
                T+{formatDuration((eta - baseEta) * 1000)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="queueIntermissionFooter">
        予約曲数 {props.queue.length} 曲
        {hiddenCount > 0 ? ` (+${hiddenCount} not shown)` : ""}
      </div>
    </div>
  );
}
