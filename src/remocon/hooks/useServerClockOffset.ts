import { useEffect, useRef } from "react";
import { graphql } from "react-relay";
import { getRequest } from "relay-runtime";

import { WS_RECONNECTED_EVENT } from "../../common/graphqlEnvironment";

// Timed with a bare fetch rather than Relay's fetchQuery, whose network layer
// and store work would land inside the round trip being measured. Declared
// through graphql`` anyway so the compiler still checks the field exists.
const serverNowQuery = graphql`
  query useServerClockOffsetQuery {
    serverNow
  }
`;

// Round trips per burst, and the gap between them. The best of several is
// what makes this accurate: WiFi latency is mostly queueing, and the fastest
// round trip is the one with the least of it, so its midpoint is the truest.
const BURST_SAMPLES = 7;
const BURST_SPACING_MS = 40;
// While mounted, one more sample this often. Clocks drift apart by tens of
// ppm, a few ms a minute, and NTP can step the phone's clock outright.
const RESAMPLE_INTERVAL_MS = 20 * 1000;
// Samples older than this stop counting, so slow drift ages out.
const SAMPLE_MAX_AGE_MS = 2 * 60 * 1000;
// How often to check the phone's clock hasn't jumped, and by how much it
// must jump to count. See wallMinusMonotonic below.
const STEP_CHECK_INTERVAL_MS = 1000;
const CLOCK_STEP_MS = 50;

interface ClockSample {
  offsetMs: number;
  rttMs: number;
  takenAt: number;
}

export interface ServerClockOffset {
  // Add to Date.now() for main's clock. Null until the first sample lands.
  offsetMs: number | null;
  // The winning sample's round trip. Its midpoint is exact only if the trip
  // was symmetric, so half this bounds the error.
  rttMs: number | null;
}

async function sampleServerClock(): Promise<ClockSample> {
  // Date.now(), not performance.now(): iOS stops the monotonic clock while the
  // phone sleeps, which would leave a pre-sleep offset wrong by however long
  // the screen was off. The wall clock keeps running, so the old offset is
  // still right when the page wakes, before the resync lands.
  const sentAt = Date.now();
  const response = await fetch("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: getRequest(serverNowQuery).params.text }),
    cache: "no-store",
  });
  const body = await response.json();
  const receivedAt = Date.now();

  const serverNow = body?.data?.serverNow;
  if (typeof serverNow !== "number") {
    throw new Error("serverNow missing from response");
  }

  return {
    offsetMs: serverNow - (sentAt + receivedAt) / 2,
    rttMs: receivedAt - sentAt,
    takenAt: receivedAt,
  };
}

// How far this device's clock is from main's, estimated NTP-style, kept fresh
// for as long as the caller stays mounted. It is what lets the remocon place
// the TV's reported playback position on its own timeline.
export default function useServerClockOffset(): React.MutableRefObject<ServerClockOffset> {
  const offsetRef = useRef<ServerClockOffset>({ offsetMs: null, rttMs: null });

  useEffect(() => {
    let cancelled = false;
    let samples: ClockSample[] = [];
    let burstInFlight = false;

    const adopt = () => {
      const now = Date.now();
      samples = samples.filter((s) => now - s.takenAt < SAMPLE_MAX_AGE_MS);
      const best = samples.reduce<ClockSample | null>(
        (acc, s) => (acc === null || s.rttMs < acc.rttMs ? s : acc),
        null,
      );
      if (best !== null) {
        offsetRef.current = { offsetMs: best.offsetMs, rttMs: best.rttMs };
      }
    };

    const takeSample = async () => {
      try {
        const sample = await sampleServerClock();
        if (cancelled) return;
        samples.push(sample);
        adopt();
      } catch (e) {
        // A dropped sample costs accuracy, not correctness; the next one or
        // the next burst will do.
        console.warn("Clock sample failed", e);
      }
    };

    const burst = async (fresh: boolean) => {
      if (burstInFlight) return;
      burstInFlight = true;
      // After the page wakes or the socket comes back, the old samples may
      // predate a clock step; don't let a stale winner keep winning.
      if (fresh) samples = [];
      for (let i = 0; i < BURST_SAMPLES && !cancelled; i++) {
        await takeSample();
        await new Promise((resolve) => setTimeout(resolve, BURST_SPACING_MS));
      }
      burstInFlight = false;
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) burst(true);
    };
    const handleReconnect = () => burst(true);

    // The wall clock minus the monotonic one. It holds still until either is
    // disturbed: NTP stepping the wall clock, or iOS freezing the monotonic
    // clock through a sleep. After that, every sample taken before is on a
    // different footing from every one after, and the fastest of the old ones
    // would otherwise keep winning, wrong by the whole step, until it aged
    // out minutes later.
    const wallMinusMonotonic = () => Date.now() - performance.now();
    let footing = wallMinusMonotonic();
    let sinceResample = 0;

    const tick = setInterval(() => {
      if (document.hidden) return;

      const now = wallMinusMonotonic();
      if (Math.abs(now - footing) > CLOCK_STEP_MS) {
        footing = now;
        burst(true);
        sinceResample = 0;
        return;
      }

      sinceResample += STEP_CHECK_INTERVAL_MS;
      if (sinceResample >= RESAMPLE_INTERVAL_MS) {
        sinceResample = 0;
        takeSample();
      }
    }, STEP_CHECK_INTERVAL_MS);

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleReconnect);

    burst(true);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(WS_RECONNECTED_EVENT, handleReconnect);
      clearInterval(tick);
    };
  }, []);

  return offsetRef;
}
