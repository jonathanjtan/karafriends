import { useEffect, useRef, useState } from "react";
import YouTubePlayer from "youtube-player";

// IFrame API error codes that mean "this device can't play this video in an
// embed": 5 = HTML5 player error, 100 = removed/private, 101 and 150 = the
// owner disallows embedded playback (also what a region lock reports).
// https://developers.google.com/youtube/iframe_api_reference#onError
const EMBED_ERROR_CODES = [5, 100, 101, 150];

export type UnembeddableReason =
  | "regionLocked"
  | "embeddingDisabled"
  | "clientBlocked";

// Why a preview isn't showing, as a clause each surface can finish with its
// own "…but it still works" reassurance.
export const UNEMBEDDABLE_REASON_TEXT: Record<UnembeddableReason, string> = {
  clientBlocked: "This video wouldn't play on this device",
  embeddingDisabled: "This video doesn't allow embedded previews",
  regionLocked:
    "This video is region-locked outside Japan, so it can't be previewed here",
};

interface Playability {
  readonly embeddable: boolean;
  // Null/undefined when the video info didn't say — treated as "no reason to
  // think it's blocked", same as true.
  readonly availableInUs?: boolean | null;
}

/**
 * Owns the shared `#youtube-player` embed: creates the IFrame player, swaps
 * videos into it, and decides whether an embed can be shown at all.
 *
 * `playability` is what the *host* machine saw when it fetched the video info,
 * which catches most unplayable videos up front. It can't catch all of them —
 * the host fetches over the VPN and the phone doesn't, and a video can be
 * blocked in ways `playability_status` doesn't report — so a video that looks
 * fine here still shows up as a bare "Video unavailable" (sometimes only after
 * the viewer taps play) on the device. The player's own `error` event is the
 * only signal for those, so it feeds back into `canEmbed` and the caller falls
 * back to thumbnails. Pass `null` when the video info couldn't be fetched.
 *
 * None of this gates queueing: the download runs on the host, not the phone.
 */
export default function useYouTubeEmbed(
  videoId: string,
  playability: Playability | null,
) {
  const playerRef: React.MutableRefObject<ReturnType<
    typeof YouTubePlayer
  > | null> = useRef(null);
  // Videos this device has actually failed to play. Keyed by id rather than a
  // single flag so switching back to an earlier pick doesn't re-embed a video
  // we already know is broken here.
  const [blockedVideoIds, setBlockedVideoIds] = useState<readonly string[]>([]);
  // The error event says what went wrong but not which video it went wrong
  // for, so track what we last handed the player.
  const loadedVideoIdRef = useRef<string>("");

  const blockVideoId = (id: string) =>
    setBlockedVideoIds((ids) => (id && !ids.includes(id) ? [...ids, id] : ids));

  let unembeddableReason: UnembeddableReason | null = null;
  if (playability) {
    if (!playability.embeddable) {
      unembeddableReason = "embeddingDisabled";
    } else if (playability.availableInUs === false) {
      unembeddableReason = "regionLocked";
    } else if (blockedVideoIds.includes(videoId)) {
      unembeddableReason = "clientBlocked";
    }
  }

  const canEmbed = playability !== null && unembeddableReason === null;

  useEffect(() => {
    if (canEmbed) {
      loadedVideoIdRef.current = videoId;

      if (playerRef.current == null) {
        const player = YouTubePlayer("youtube-player", { videoId });

        player.on("error", (event) => {
          const code = (event as CustomEvent & { data?: unknown }).data;

          if (typeof code === "number" && EMBED_ERROR_CODES.includes(code)) {
            blockVideoId(loadedVideoIdRef.current);
          }
        });

        playerRef.current = player;
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

  return {
    canEmbed,
    unembeddableReason,
    // Escape hatch for the embeds that fail silently — the player renders a
    // poster frame and only reveals "Video unavailable" once tapped, with no
    // error event to catch.
    showThumbnailsInstead: () => blockVideoId(videoId),
  };
}
