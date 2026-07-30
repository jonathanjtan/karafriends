// Extracts a piano-roll note track from a Joysound guide melody channel.
//
// Joysound's raw karaoke audio (getFME "ogg") is 3.0-channel vorbis: stereo
// backing on FL/FR and the guide melody isolated on FC. The FC channel is a
// clean monophonic synth that plays the vocal melody note-for-note (validated
// against DAM's scoring reference data for the same song: 97.6% frame-level
// pitch-class agreement), so tracking its pitch yields scoring-quality note
// data on the native Joysound timeline.
//
// This module is pure DSP over raw PCM — no electron/fs/network imports — so
// it can be exercised standalone. Callers decode the FC channel to s16le mono
// PCM at GUIDE_MELODY_SAMPLE_RATE_HZ (via ffmpeg) and feed it in.
//
// Known cosmetic quirk, verified spectrally against DAM data: the guide
// synth caps its register, playing the top note or two of a song an octave
// below the rest of the melody's register (~9% of notes in validation), so
// phrase climaxes can draw lower than the sung contour. This reflects what
// the guide melody actually sounds like, and the piano roll's mic trace
// octave-folds the singer's voice onto the nearest note row, so pitch
// feedback is unaffected.

const GUIDE_MELODY_SAMPLE_RATE_HZ = 16000;
const FRAME_SAMPLES = 640; // 40ms analysis window
const HOP_SAMPLES = 320; // 20ms hop
const F0_MIN_HZ = 80;
// High enough that the guide synth's top notes (~1.1-1.25kHz when it plays
// an octave above notation) resolve with shoulder room for the local-max
// check; with a ceiling of 1200Hz they sat at the edge of the lag range and
// fell back an octave, denting phrase climaxes.
const F0_MAX_HZ = 1500;
// Frames quieter than this RMS (s16 units) are treated as silence. The FC
// channel is fully silent between phrases, so a simple gate suffices.
const RMS_FLOOR = 300;
const CORRELATION_THRESHOLD = 0.6;
// An autocorrelation peak at lag k*T (subharmonic) often edges out the true
// period T. Prefer the shortest local maximum within this fraction of the
// best score; this eliminated nearly all octave/subharmonic errors when
// validated against DAM reference notes. The full lag range is searched on
// every voiced frame — narrowing the search around the previous frame's
// pitch was tried as an optimization but locks onto subharmonics at melodic
// leaps (a fifth up lands its 2/3-frequency subharmonic inside the narrowed
// window), which measurably corrupted whole phrases.
const SUBHARMONIC_PREFERENCE_RATIO = 0.9;
const MIN_NOTE_MS = 100;
// Adjacent equal-pitch segments closer than this are one note with a flutter
// in the middle (vibrato dip, tracker dropout), not two notes.
const NOTE_MERGE_GAP_MS = 60;
// A note this far from the pitch of the notes *around* it is assumed to be a
// residual octave-tracking error and folded back in.
//
// Measured against the median of the whole song this misfires on any melody
// wider than its threshold: Dancing Queen spans 21 semitones in DAM's chart, so
// its lowest genuine notes sit more than 11 below the median and were folded an
// octave up (18 of 204 notes moved), while the real tracking errors -- a fifth
// lower again -- were folded twice and landed past where they started. Local
// context separates the two cleanly, because a wide melody arrives at its
// extremes through its neighbours and a tracking error does not: the errors are
// isolated notes 15-25 semitones below the notes on either side of them.
const OCTAVE_FOLD_THRESHOLD_SEMIS = 11;
// How much of the melody either side of a note counts as its context. Wide
// enough that a run of two or three consecutive bad notes can't outvote the
// phrase they sit in, short enough to be local to the register the song is in
// at that moment.
const OCTAVE_CONTEXT_SECS = 4;
// Notes separated by less than this are part of one sung phrase; the phrase
// spans become the "lyrics intervals" that the piano roll uses to shade
// no-singing stretches as free time.
const PHRASE_GAP_MS = 4000;
// Below either of these, the extraction is judged to have found no real
// guide melody (e.g. the channel is missing or silent) and is discarded.
const MIN_TOTAL_NOTES = 24;
const MIN_TOTAL_VOICED_MS = 20000;

// Bump when a change to this module would produce a different note track from
// the same audio. Cached melodies carry it (see buildScoringData), and
// joysoundMelody.ts treats an older one as a cache miss -- re-extraction runs
// off the ogg or the composited video, both already on disk, so healing the
// cache costs an ffmpeg decode and no network.
//
// 1: original extraction.
// 2: octave outliers folded against local context rather than the song's
//    overall median, which was clipping any melody wider than the threshold
//    (40 of 53 cached melodies sat pinned exactly at it).
export const GUIDE_MELODY_EXTRACTION_VERSION = 2;

export interface GuideMelodyNote {
  startMs: number;
  endMs: number;
  midi: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FramePitch {
  lag: number;
  midi: number;
}

function bestLagInRange(
  samples: Float32Array,
  offset: number,
  lagMin: number,
  lagMax: number,
): { lag: number; corr: number } {
  const corrs = new Float32Array(lagMax - lagMin + 1);
  let bestCorr = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    const end = offset + FRAME_SAMPLES - lag;
    for (let i = offset; i < end; i++) {
      num += samples[i] * samples[i + lag];
      denA += samples[i] * samples[i];
      denB += samples[i + lag] * samples[i + lag];
    }
    const corr = num / (Math.sqrt(denA * denB) + 1e-9);
    corrs[lag - lagMin] = corr;
    if (corr > bestCorr) bestCorr = corr;
  }

  if (bestCorr < CORRELATION_THRESHOLD) return { lag: 0, corr: bestCorr };

  // Shortest local maximum within SUBHARMONIC_PREFERENCE_RATIO of the best.
  for (let i = 1; i < corrs.length - 1; i++) {
    if (
      corrs[i] >= bestCorr * SUBHARMONIC_PREFERENCE_RATIO &&
      corrs[i] >= corrs[i - 1] &&
      corrs[i] >= corrs[i + 1]
    ) {
      // Parabolic interpolation for sub-sample lag precision; matters for
      // semitone resolution at the high end of the pitch range.
      const num = corrs[i - 1] - corrs[i + 1];
      const den = corrs[i - 1] - 2 * corrs[i] + corrs[i + 1];
      const refined = i + (den !== 0 ? (0.5 * num) / den : 0);
      return { lag: lagMin + refined, corr: corrs[i] };
    }
  }

  return { lag: 0, corr: -Infinity };
}

async function trackFramePitches(
  pcm: Int16Array,
): Promise<(FramePitch | null)[]> {
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i];

  const globalLagMin = Math.floor(GUIDE_MELODY_SAMPLE_RATE_HZ / F0_MAX_HZ);
  const globalLagMax = Math.ceil(GUIDE_MELODY_SAMPLE_RATE_HZ / F0_MIN_HZ);

  const frames: (FramePitch | null)[] = [];

  for (
    let offset = 0;
    offset + FRAME_SAMPLES <= samples.length;
    offset += HOP_SAMPLES
  ) {
    if (frames.length % 500 === 499) await yieldToEventLoop();

    let sumSq = 0;
    for (let i = offset; i < offset + FRAME_SAMPLES; i++) {
      sumSq += samples[i] * samples[i];
    }
    if (Math.sqrt(sumSq / FRAME_SAMPLES) < RMS_FLOOR) {
      frames.push(null);
      continue;
    }

    const result = bestLagInRange(samples, offset, globalLagMin, globalLagMax);
    if (result.corr < CORRELATION_THRESHOLD || result.lag <= 0) {
      frames.push(null);
      continue;
    }

    frames.push({
      lag: result.lag,
      midi: 69 + 12 * Math.log2(GUIDE_MELODY_SAMPLE_RATE_HZ / result.lag / 440),
    });
  }

  return frames;
}

function medianOfThree(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function segmentNotes(frames: (FramePitch | null)[]): GuideMelodyNote[] {
  const hopMs = (HOP_SAMPLES / GUIDE_MELODY_SAMPLE_RATE_HZ) * 1000;

  // Median-of-3 smoothing kills single-frame pitch blips without eating
  // notes shorter than the minimum duration.
  const smoothed: (number | null)[] = frames.map((frame, i) => {
    if (frame === null) return null;
    const prev = frames[i - 1];
    const next = frames[i + 1];
    if (!prev || !next) return frame.midi;
    return medianOfThree(prev.midi, frame.midi, next.midi);
  });

  const segments: GuideMelodyNote[] = [];
  let current: GuideMelodyNote | null = null;
  for (let i = 0; i < smoothed.length; i++) {
    const midi = smoothed[i] === null ? null : Math.round(smoothed[i]!);
    const timeMs = i * hopMs;
    if (current !== null && midi === current.midi) {
      current.endMs = timeMs + hopMs;
      continue;
    }
    if (current !== null) segments.push(current);
    current =
      midi === null ? null : { startMs: timeMs, endMs: timeMs + hopMs, midi };
  }
  if (current !== null) segments.push(current);

  // Merge equal-pitch segments separated by tiny gaps, then drop the runts.
  const merged: GuideMelodyNote[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.midi === segment.midi &&
      segment.startMs - last.endMs <= NOTE_MERGE_GAP_MS
    ) {
      last.endMs = segment.endMs;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged.filter((note) => note.endMs - note.startMs >= MIN_NOTE_MS);
}

// Duration-weighted median pitch of the notes within OCTAVE_CONTEXT_SECS of
// `notes[index]`, excluding the note itself. Weighted by duration so a spray of
// passing sixteenths can't outvote the held note they decorate. Null when the
// note has too little company to judge it by -- the ends of the song, and songs
// so sparse there is no local register to speak of.
function localMedianPitch(
  notes: readonly GuideMelodyNote[],
  index: number,
): number | null {
  const centre = (notes[index].startMs + notes[index].endMs) / 2;
  const weighted: number[] = [];

  for (let i = index - 1; i >= 0; i--) {
    if (centre - notes[i].endMs > OCTAVE_CONTEXT_SECS * 1000) break;
    const frames = Math.max(
      1,
      Math.round((notes[i].endMs - notes[i].startMs) / 20),
    );
    for (let f = 0; f < frames; f++) weighted.push(notes[i].midi);
  }
  for (let i = index + 1; i < notes.length; i++) {
    if (notes[i].startMs - centre > OCTAVE_CONTEXT_SECS * 1000) break;
    const frames = Math.max(
      1,
      Math.round((notes[i].endMs - notes[i].startMs) / 20),
    );
    for (let f = 0; f < frames; f++) weighted.push(notes[i].midi);
  }

  if (weighted.length < 10) return null;
  weighted.sort((a, b) => a - b);
  return weighted[Math.floor(weighted.length / 2)];
}

function foldOctaveOutliers(notes: GuideMelodyNote[]): void {
  if (notes.length === 0) return;

  // Read every context off the original pitches, then apply: folding in place
  // would let an early correction feed the next note's context and walk a whole
  // phrase an octave.
  const medians = notes.map((_, i) => localMedianPitch(notes, i));

  for (let i = 0; i < notes.length; i++) {
    const median = medians[i];
    if (median === null) continue;
    const note = notes[i];
    while (note.midi - median > OCTAVE_FOLD_THRESHOLD_SEMIS) note.midi -= 12;
    while (median - note.midi > OCTAVE_FOLD_THRESHOLD_SEMIS) note.midi += 12;
  }
}

function phraseIntervals(notes: GuideMelodyNote[]): [number, number][] {
  const intervals: [number, number][] = [];
  for (const note of notes) {
    const last = intervals[intervals.length - 1];
    if (last && note.startMs - last[1] <= PHRASE_GAP_MS) {
      last[1] = Math.max(last[1], note.endMs);
    } else {
      intervals.push([note.startMs, note.endMs]);
    }
  }
  return intervals;
}

export async function extractGuideMelodyNotes(
  pcm: Int16Array,
): Promise<GuideMelodyNote[]> {
  const frames = await trackFramePitches(pcm);
  const notes = segmentNotes(frames);
  foldOctaveOutliers(notes);

  const totalVoicedMs = notes.reduce(
    (acc, note) => acc + (note.endMs - note.startMs),
    0,
  );
  if (notes.length < MIN_TOTAL_NOTES || totalVoicedMs < MIN_TOTAL_VOICED_MS) {
    return [];
  }
  return notes;
}

// Parses scoring data (DAM's reference data, or the equivalent built by
// buildScoringData below) back into note records. Layout mirrors
// PianoRoll.tsx: little-endian uint32 words, note count in word 1, note
// records (startMs, endMs, midi, flags) from word 6.
export function parseScoringData(data: ArrayLike<number>): GuideMelodyNote[] {
  const words = new Uint32Array(Uint8Array.from(data).buffer);
  if (words.length < 6) return [];

  const noteCount = words[1];
  const notesOffset = 6;
  if (words.length < notesOffset + noteCount * 4) return [];

  const notes: GuideMelodyNote[] = [];
  for (let i = notesOffset; i < notesOffset + noteCount * 4; i += 4) {
    notes.push({
      startMs: words[i],
      endMs: words[i + 1],
      midi: words[i + 2],
    });
  }
  return notes;
}

// The extraction version a cached melody was built by, or 1 for blobs written
// before the field existed (word 5 was left zero then). Only call this on our
// own cache files: DAM's blobs carry an unrelated value in the same word.
export function scoringDataExtractionVersion(data: ArrayLike<number>): number {
  const words = new Uint32Array(Uint8Array.from(data).buffer);
  if (words.length < 6) return 0;
  return words[5] === 0 ? 1 : words[5];
}

// Serializes notes into the same binary layout as DAM's scoring reference
// data (see PianoRoll.tsx): little-endian uint32 words with counts in the
// header, note records (startMs, endMs, midi, flags) from word 6, then
// lyrics intervals. DAM time windows and pog intervals are left empty. This
// lets the renderer's PianoRoll consume Joysound songs unchanged.
export function buildScoringData(notes: GuideMelodyNote[]): Uint8Array {
  const intervals = phraseIntervals(notes);
  const words = new Uint32Array(6 + notes.length * 4 + intervals.length * 2);
  words[1] = notes.length;
  words[2] = intervals.length;
  // DAM's real blobs do put something in word 5 (6333 and 6500 on the two
  // surveyed), but nothing reads it: parseScoringData takes every count it
  // needs from words 1-4. So it is free for our version in the blobs *we*
  // write, and the version check only ever runs against our own cache files --
  // a DAM blob never reaches it.
  words[5] = GUIDE_MELODY_EXTRACTION_VERSION;

  let w = 6;
  for (const note of notes) {
    words[w++] = Math.round(note.startMs);
    words[w++] = Math.round(note.endMs);
    words[w++] = note.midi;
    words[w++] = 0;
  }
  for (const [startMs, endMs] of intervals) {
    words[w++] = Math.round(startMs);
    words[w++] = Math.round(endMs);
  }
  return new Uint8Array(words.buffer);
}
