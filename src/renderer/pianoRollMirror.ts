// What the remocon's lyrics panel needs to draw the big screen's piano roll:
// the roll's layout for this song (published once, and again on every key
// change) and the sung-pitch samples the screen is plotting right now.
//
// The layout half mirrors lyricsMirror.ts's telop half exactly. The trace half
// is different in kind: it is a stream, not a snapshot, so nothing is stored
// in main and the renderer only pays for it while a phone is actually
// listening (publishPitchTrace answers that, and the publisher below drops to
// a slow probe when the answer is no).

import { commitMutation, graphql } from "react-relay";

import environment from "../common/graphqlEnvironment";
import { PianoRollLayout } from "../common/pianoRoll/layout";
import { pianoRollMirrorPublishPitchTraceMutation } from "./__generated__/pianoRollMirrorPublishPitchTraceMutation.graphql";
import { pianoRollMirrorPublishSongPianoRollMutation } from "./__generated__/pianoRollMirrorPublishSongPianoRollMutation.graphql";

const publishSongPianoRollMutation = graphql`
  mutation pianoRollMirrorPublishSongPianoRollMutation(
    $input: SongPianoRollInput!
  ) {
    publishSongPianoRoll(input: $input)
  }
`;

const publishPitchTraceMutation = graphql`
  mutation pianoRollMirrorPublishPitchTraceMutation($input: PitchTraceInput!) {
    publishPitchTrace(input: $input)
  }
`;

// How often a batch of samples goes out while someone is watching. The mic
// poll runs at 25ms, so a batch carries ~4 readings per mic; the phone's trail
// is that far behind the TV's, which at the roll's 7s window is under 3% of
// the canvas.
const FLUSH_MS = 100;
// How often to send an (often empty) batch while nobody is listening, purely
// to find out whether someone has started. Cheap enough to leave running for a
// whole song, and it means opening the panel mid-song costs no round trip of
// its own.
const PROBE_MS = 2000;

export function publishSongPianoRoll(
  songKey: string,
  layout: PianoRollLayout | null,
  micCount: number,
) {
  commitMutation<pianoRollMirrorPublishSongPianoRollMutation>(environment, {
    mutation: publishSongPianoRollMutation,
    variables: {
      input: {
        songKey,
        layout: layout === null ? null : JSON.stringify(layout),
        micCount,
      },
    },
    // A phone without the roll is a phone without the roll, not a broken song.
    onError: (err) =>
      console.error("Publishing the piano roll layout failed", err),
  });
}

// Collects the values the roll just plotted and ships them to main on a timer.
// One per song (the renderer's GL effect owns it), so it can hold the song key
// and the seek generation for its whole life.
export class PitchTracePublisher {
  private readonly songKey: string;
  private readonly pending = new Map<number, number[]>();
  private readonly timer: ReturnType<typeof setInterval>;
  private generation = 0;
  private listening = false;
  private lastSentAt = 0;

  constructor(songKey: string) {
    this.songKey = songKey;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
  }

  // `value` is what the roll drew, not the raw estimate: already octave-folded
  // onto the guide melody and key-shifted, so the phone can append it as-is.
  add(micIndex: number, time: number, value: number) {
    const samples = this.pending.get(micIndex);
    if (samples === undefined) {
      this.pending.set(micIndex, [time, value]);
    } else {
      samples.push(time, value);
    }
  }

  // The big screen cleared its own trails (a seek). Tells the phones to do the
  // same rather than stitching the new position onto the old trail.
  clear() {
    this.generation++;
    this.pending.clear();
  }

  dispose() {
    clearInterval(this.timer);
    this.pending.clear();
  }

  private flush() {
    const now = Date.now();
    if (!this.listening && now - this.lastSentAt < PROBE_MS) {
      // Nobody is watching; these samples are already on the TV, which is the
      // only screen that matters, so drop them rather than queueing a backlog
      // for a phone that may never arrive.
      this.pending.clear();
      return;
    }
    this.lastSentAt = now;

    const mics = [...this.pending.entries()].map(([index, samples]) => ({
      index,
      samples,
    }));
    this.pending.clear();

    commitMutation<pianoRollMirrorPublishPitchTraceMutation>(environment, {
      mutation: publishPitchTraceMutation,
      variables: {
        input: { songKey: this.songKey, generation: this.generation, mics },
      },
      onCompleted: (response) => {
        this.listening = response.publishPitchTrace;
      },
      // Same reasoning as the layout above, and doubly so here: a dropped
      // batch is a gap in a trail, which the phone draws straight through.
      onError: () => {
        this.listening = false;
      },
    });
  }
}
