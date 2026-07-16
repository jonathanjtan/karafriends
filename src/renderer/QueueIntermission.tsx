import formatDuration from "format-duration";
import React, { useEffect, useRef, useState } from "react";

/* tslint:disable:no-submodule-imports no-implicit-dependencies */
import damIcon from "url:./images/sources/dam.jpg";
import joysoundIcon from "url:./images/sources/joysound.jpg";
import niconicoIcon from "url:./images/sources/niconico.jpg";
import youtubeIcon from "url:./images/sources/youtube.jpg";
import SourceBadge from "../common/components/SourceBadge";
import { cyrb53 } from "../common/hash";
import useQueue from "../common/hooks/useQueue";
/* tslint:enable:no-submodule-imports no-implicit-dependencies */
import QRCode from "./QRCode";
import "./QueueIntermission.css";

// Official app icons for the big Up Next slot; the smaller upcoming rows use
// the text pills (SourceBadge) instead, which stay legible at row size.
const SOURCE_ICONS: Record<string, string> = {
  DamQueueItem: damIcon,
  JoysoundQueueItem: joysoundIcon,
  YoutubeQueueItem: youtubeIcon,
  NicoQueueItem: niconicoIcon,
};

const MAX_VISIBLE_UPCOMING = 6;

function nicknameBadge(nickname: string) {
  const nicknameHash = cyrb53(nickname);
  return (
    <span
      className="queueIntermissionNickname"
      style={{
        backgroundColor: `hsl(${(nicknameHash % 180) + 180}, 100%, 50%)`,
        color: `hsl(${nicknameHash % 180}, 100%, 50%)`,
      }}
    >
      {nickname}
    </span>
  );
}

// Gap (px) between the end of one copy of the track name and the start of
// the next, while it scrolls.
const BGM_MARQUEE_GAP_PX = 60;
// Scroll speed in px/sec — kept constant so short and long names scroll at
// the same pace rather than taking the same total duration.
const BGM_MARQUEE_PX_PER_SEC = 60;

// The BGM track name only scrolls if it's too wide to fit; short names stay
// static. "Now Playing" is a separate, always-static label so only the name
// itself marquees.
function NowPlayingBgm(props: { track: string }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrolling, setScrolling] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const text = textRef.current;
    if (!wrapper || !text) return;

    const measure = () => {
      setTrackWidth(text.scrollWidth);
      setScrolling(text.scrollWidth > wrapper.clientWidth);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [props.track]);

  const scrollDistance = trackWidth + BGM_MARQUEE_GAP_PX;
  const trackStyle:
    | (React.CSSProperties & { "--bgm-marquee-distance": string })
    | undefined = scrolling
    ? {
        "--bgm-marquee-distance": `${scrollDistance}px`,
        animationDuration: `${scrollDistance / BGM_MARQUEE_PX_PER_SEC}s`,
      }
    : undefined;

  return (
    <div className="queueIntermissionNowPlayingBgm">
      <span className="queueIntermissionNowPlayingLabel">♪ Now Playing:</span>
      <div className="queueIntermissionNowPlayingTrackWrapper" ref={wrapperRef}>
        <div
          className={`queueIntermissionNowPlayingTrack ${
            scrolling ? "queueIntermissionNowPlayingTrackScrolling" : ""
          }`}
          style={trackStyle}
        >
          <span
            ref={textRef}
            style={scrolling ? { marginRight: BGM_MARQUEE_GAP_PX } : undefined}
          >
            {props.track}
          </span>
          {scrolling && <span aria-hidden="true">{props.track}</span>}
        </div>
      </div>
    </div>
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
        <NowPlayingBgm track={props.bgmNowPlaying} />
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
        <div className="queueIntermissionNextUpRow">
          {nextUp[0].userIdentity?.profilePictureUrl ? (
            <img
              className={`queueIntermissionNextUpPortrait${
                nextUp[0].userIdentity?.profilePictureFrame === "female"
                  ? " queueIntermissionNextUpPortraitFemale"
                  : ""
              }`}
              src={nextUp[0].userIdentity.profilePictureUrl}
              alt=""
            />
          ) : null}
          {nextUp[0].__typename && SOURCE_ICONS[nextUp[0].__typename] ? (
            <div className="queueIntermissionNextUpSource">
              <img
                className="queueIntermissionNextUpSourceIcon"
                src={SOURCE_ICONS[nextUp[0].__typename]}
                alt=""
              />
              {"youtubeVideoId" in nextUp[0] && nextUp[0].youtubeVideoId ? (
                <img
                  className="queueIntermissionNextUpSourceMv"
                  src={youtubeIcon}
                  alt=""
                />
              ) : null}
            </div>
          ) : null}
          <div className="queueIntermissionNextUp">
            <div className="queueIntermissionSongName">{nextUp[0].name}</div>
            <div className="queueIntermissionArtistName">
              {nextUp[0].artistName}{" "}
              {nicknameBadge(nextUp[0].userIdentity?.nickname || "")}
            </div>
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
              {item.userIdentity?.profilePictureUrl ? (
                <img
                  className={`queueIntermissionUpcomingPortrait${
                    item.userIdentity?.profilePictureFrame === "female"
                      ? " queueIntermissionUpcomingPortraitFemale"
                      : ""
                  }`}
                  src={item.userIdentity.profilePictureUrl}
                  alt=""
                />
              ) : null}
              <span className="queueIntermissionUpcomingSong">
                {item.name} - {item.artistName}{" "}
                {nicknameBadge(item.userIdentity?.nickname || "")}
              </span>
              <SourceBadge
                typename={item.__typename}
                youtubeVideoId={
                  "youtubeVideoId" in item ? item.youtubeVideoId : undefined
                }
                fontSize="1.9vh"
              />
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
