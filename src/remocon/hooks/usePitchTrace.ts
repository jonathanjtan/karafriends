import { useEffect, useRef } from "react";
import { graphql, requestSubscription } from "react-relay";

import environment from "../../common/graphqlEnvironment";
import { usePitchTraceSubscription } from "./__generated__/usePitchTraceSubscription.graphql";

const pitchTraceSubscription = graphql`
  subscription usePitchTraceSubscription {
    pitchTraceChanged {
      songKey
      generation
      mics {
        index
        samples
      }
    }
  }
`;

export interface PitchTraceBatch {
  generation: number;
  // Interleaved [timeSecs, midiValue, ...] per mic, in the values the TV drew.
  mics: readonly {
    readonly index: number;
    readonly samples: readonly number[];
  }[];
}

// The big screen's sung-pitch trail, live. Unlike the other mirrors there is
// no query beside this: the trail is a stream, main stores none of it, and a
// phone that opens the panel mid-song simply starts from the next batch.
//
// Merely holding this subscription open is what tells the big screen someone
// is watching (publishPitchTrace answers with the subscriber count), so it
// must only be mounted while a roll is actually on screen.
//
// `onBatch` is called from the socket, not from React: the canvas appends to a
// GL scene and re-rendering on every batch would buy nothing. Batches for any
// other song are dropped, which covers the moments either side of a change.
export default function usePitchTrace(
  songKey: string,
  onBatch: (batch: PitchTraceBatch) => void,
) {
  const handlerRef = useRef(onBatch);
  handlerRef.current = onBatch;

  useEffect(() => {
    const subscription = requestSubscription<usePitchTraceSubscription>(
      environment,
      {
        subscription: pitchTraceSubscription,
        variables: {},
        onNext: (response) => {
          const batch = response?.pitchTraceChanged;
          if (!batch || batch.songKey !== songKey) return;
          handlerRef.current({
            generation: batch.generation,
            mics: batch.mics,
          });
        },
        onError: (err: Error) =>
          console.warn("pitchTrace subscription failed", err),
      },
    );

    return () => subscription.dispose();
  }, [songKey]);
}
