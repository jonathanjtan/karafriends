import React from "react";

// Solid-fill source pills readable on both the white remocon UI and the dark
// renderer screens. DAM and JOYSOUND are both "red" brands, so they get
// clearly separated shades: burgundy vs the lighter JOYSOUND-logo red.
const SOURCE_COLORS: Record<string, string> = {
  DamQueueItem: "#8e1f2f",
  JoysoundQueueItem: "#ef4b4b",
  YoutubeQueueItem: "#ff0000",
  NicoQueueItem: "#5f5e5a",
};

const YOUTUBE_RED = "#ff0000";

const pillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25em",
  padding: "0.1em 0.65em",
  borderRadius: "1em",
  color: "#fff",
  fontWeight: 600,
  letterSpacing: "0.04em",
  lineHeight: 1.5,
  whiteSpace: "nowrap",
};

function PlayIcon() {
  return (
    <svg
      viewBox="0 0 10 10"
      style={{ width: "0.6em", height: "0.6em", fill: "currentColor" }}
      aria-hidden="true"
    >
      <path d="M1.5 0.5 L9.5 5 L1.5 9.5 Z" />
    </svg>
  );
}

interface Props {
  // A QueueItem __typename; unknown/missing values render nothing.
  typename: string | undefined;
  // JOYSOUND only: set when a YouTube MV is composited behind the song.
  youtubeVideoId?: string | null;
  fontSize?: string;
}

// Sized entirely in em so one component scales from 11px remocon rows to
// vh-sized TV text via the fontSize prop.
export default function SourceBadge({
  typename,
  youtubeVideoId,
  fontSize,
}: Props) {
  const color = typename ? SOURCE_COLORS[typename] : undefined;
  if (!color) return null;

  const withMv = typename === "JoysoundQueueItem" && !!youtubeVideoId;

  let label: React.ReactNode = null;
  if (typename === "DamQueueItem") label = "DAM";
  if (typename === "JoysoundQueueItem") label = "JOYSOUND";
  if (typename === "NicoQueueItem") label = "niconico";
  if (typename === "YoutubeQueueItem")
    label = (
      <>
        <PlayIcon />
        YT
      </>
    );

  const outerStyle: React.CSSProperties = {
    display: "inline-flex",
    flex: "none",
    alignSelf: "center",
    verticalAlign: "middle",
    fontSize,
  };

  if (!withMv) {
    return (
      <span style={outerStyle}>
        <span style={{ ...pillStyle, backgroundColor: color }}>{label}</span>
      </span>
    );
  }

  return (
    <span style={outerStyle}>
      <span
        style={{
          ...pillStyle,
          backgroundColor: color,
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
          paddingRight: "0.5em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          ...pillStyle,
          backgroundColor: YOUTUBE_RED,
          borderTopLeftRadius: 0,
          borderBottomLeftRadius: 0,
          paddingLeft: "0.5em",
        }}
      >
        <PlayIcon />
        MV
      </span>
    </span>
  );
}
