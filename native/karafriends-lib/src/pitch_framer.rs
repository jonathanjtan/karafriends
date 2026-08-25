use crate::pitch_detector::PitchDetector;

/// One pitch reading, and how far back in the captured audio it sits.
pub struct PitchEstimate {
    /// Milliseconds between the end of this estimate's window and the newest
    /// audio the framer had when it produced the batch. The most recent
    /// estimate is ~0; older ones grow by the hop. Callers stamp their own
    /// clock at poll time and subtract this, which is what lets a batch of
    /// estimates land at the times they were actually sung rather than all at
    /// the instant they were collected.
    pub age_ms: f32,
    pub midi_number: f32,
    pub confidence: f32,
    pub rms: f32,
}

/// Slides the detector's analysis window over captured audio at a hop finer
/// than the window, and hands back every reading since the last call.
///
/// The detector needs a window of a fixed size (its FFT is planned for it), and
/// that size is bounded below by the lowest pitch worth resolving: 25ms is
/// already only two cycles at 80Hz. But the *hop* between windows is free to be
/// smaller, and it is the hop, not the window, that sets how finely a pitch
/// **changes** over time can be measured.
///
/// That distinction is the whole point of this type. Reading one window per JS
/// poll made the hop 25ms and, worse, irregular, since the poll shares a
/// renderer with a WebGL draw loop and runs late routinely. Vibrato rate came
/// out pinned at 6.7Hz for every singer on every song, which is 1/(2 x 75ms):
/// three sample slots per half cycle. The detector was reporting the sampling
/// grid rather than the voice.
///
/// Windows overlap, so consecutive estimates are not independent, but
/// tracking a 5-7Hz modulation does not need independent samples, it needs
/// samples of the modulation envelope, and a 25ms window spans only about 15%
/// of a 6Hz cycle. It smooths the depth slightly rather than hiding the shape.
pub struct PitchFramer {
    detector: PitchDetector,
    sample_rate: f32,
    window: usize,
    hop: usize,
    max_backlog: usize,
    /// Audio not yet consumed by a whole window, carried between calls so the
    /// slide continues across batch boundaries instead of restarting at each
    /// poll. Without it the effective hop would be the poll interval again.
    history: Vec<f32>,
}

impl PitchFramer {
    pub fn new(sample_rate: f32, window: usize, hop: usize, max_backlog: usize) -> PitchFramer {
        PitchFramer {
            detector: PitchDetector::new(sample_rate, window),
            sample_rate,
            window,
            hop,
            max_backlog: max_backlog.max(window),
            history: Vec::with_capacity(max_backlog.max(window) + window),
        }
    }

    /// Appends captured audio and returns every window that completed, oldest
    /// first.
    pub fn analyze(&mut self, samples: &[f32]) -> Vec<PitchEstimate> {
        self.history.extend_from_slice(samples);

        // A stall long enough to exceed this means the singer has moved on and
        // the audio is no longer worth scoring; dropping the oldest bounds both
        // the work done here and the memory held. This replaces the old
        // "discard everything but the newest window" rule, which threw away
        // real singing on every late poll. The threshold is now a stall of
        // most of a second rather than a poll running a few ms behind.
        if self.history.len() > self.max_backlog {
            self.history.drain(..self.history.len() - self.max_backlog);
        }

        let mut estimates = Vec::new();
        let mut pos = 0;
        while pos + self.window <= self.history.len() {
            let frame = &self.history[pos..pos + self.window];
            let level = crate::rms(frame);
            let (midi_number, confidence) = self.detector.detect(frame.to_vec());
            let age_samples = self.history.len() - (pos + self.window);
            estimates.push(PitchEstimate {
                age_ms: age_samples as f32 * 1000.0 / self.sample_rate,
                midi_number,
                confidence,
                rms: level,
            });
            pos += self.hop;
        }

        // Keep the tail the next window will start from. It is shorter than one
        // window by construction, so this cannot grow without bound.
        self.history.drain(..pos);
        estimates
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SAMPLE_RATE: f32 = 44100.0;

    fn window_for(sample_rate: f32) -> usize {
        (sample_rate as u32).div_ceil(40) as usize
    }

    /// A tone whose pitch is modulated sinusoidally: vibrato with an exactly
    /// known rate and depth, which is a better ground truth than any sung take.
    fn vibrato_tone(secs: f32, carrier_hz: f32, rate_hz: f32, depth_semis: f32) -> Vec<f32> {
        let count = (SAMPLE_RATE * secs) as usize;
        let mut phase = 0.0f32;
        (0..count)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE;
                let semis = depth_semis * (2.0 * PI * rate_hz * t).sin();
                let freq = carrier_hz * 2.0f32.powf(semis / 12.0);
                phase += 2.0 * PI * freq / SAMPLE_RATE;
                phase.sin()
            })
            .collect()
    }

    /// Rate of the dominant oscillation in a pitch series, by counting how
    /// often it crosses its own mean.
    fn oscillation_rate_hz(midi: &[f32], hop_secs: f32) -> f32 {
        let mean = midi.iter().sum::<f32>() / midi.len() as f32;
        let crossings = midi
            .windows(2)
            .filter(|w| (w[0] - mean).signum() != (w[1] - mean).signum())
            .count();
        crossings as f32 / 2.0 / (midi.len() as f32 * hop_secs)
    }

    // The reason this module exists. A 10ms hop has to recover a vibrato rate
    // the old 25ms-per-poll framing could not represent at all: at that hop the
    // only rates expressible by counting extrema are 10.0, 6.7, 5.0 and 4.0Hz,
    // which is why every singer measured 6.7.
    #[test]
    fn recovers_vibrato_rate_a_25ms_hop_cannot_represent() {
        let window = window_for(SAMPLE_RATE);
        let hop = (SAMPLE_RATE as u32).div_ceil(100) as usize; // 10ms
        let mut framer = PitchFramer::new(SAMPLE_RATE, window, hop, SAMPLE_RATE as usize);

        // Fed in small buffers, the way the audio callback delivers it. A
        // 2s tone handed over in one call would exceed the backlog cap and be
        // trimmed to the last second, which is the cap working, not a bug.
        let tone = vibrato_tone(2.0, 220.0, 5.5, 0.5);
        let estimates: Vec<PitchEstimate> = tone
            .chunks(512)
            .flat_map(|chunk| framer.analyze(chunk))
            .collect();

        // Drop the first window: it straddles the tone's onset.
        let midi: Vec<f32> = estimates
            .iter()
            .skip(2)
            .filter(|e| e.confidence > 0.5)
            .map(|e| e.midi_number)
            .collect();
        assert!(
            midi.len() > 150,
            "expected a dense series over 2s at a 10ms hop, got {}",
            midi.len()
        );

        let rate = oscillation_rate_hz(&midi, hop as f32 / SAMPLE_RATE);
        assert!(
            (rate - 5.5).abs() < 0.7,
            "expected ~5.5Hz vibrato, measured {rate:.2}Hz"
        );

        // And the depth is in the right ballpark: +/-0.5 semitone means a peak
        // to trough of about a semitone, smoothed slightly by the window.
        let lo = midi.iter().cloned().fold(f32::MAX, f32::min);
        let hi = midi.iter().cloned().fold(f32::MIN, f32::max);
        assert!(
            (hi - lo) > 0.6 && (hi - lo) < 1.4,
            "expected ~1 semitone peak-to-peak, measured {:.2}",
            hi - lo
        );
    }

    // Estimates have to be evenly spaced by the hop and carry ages that put
    // them where they were sung, or a batch collapses onto the poll instant.
    #[test]
    fn estimates_are_hop_spaced_and_aged_oldest_first() {
        let window = window_for(SAMPLE_RATE);
        let hop = (SAMPLE_RATE as u32).div_ceil(100) as usize;
        let mut framer = PitchFramer::new(SAMPLE_RATE, window, hop, SAMPLE_RATE as usize);

        let estimates = framer.analyze(&vibrato_tone(0.5, 220.0, 5.5, 0.1));
        assert!(estimates.len() > 20);

        let hop_ms = hop as f32 * 1000.0 / SAMPLE_RATE;
        for pair in estimates.windows(2) {
            let step = pair[0].age_ms - pair[1].age_ms;
            assert!(
                (step - hop_ms).abs() < 0.01,
                "expected {hop_ms:.2}ms between estimates, got {step:.2}ms"
            );
        }
        assert!(
            estimates.last().unwrap().age_ms < hop_ms,
            "the newest estimate should sit at the live edge"
        );
    }

    // The slide must continue across calls. Feeding the same audio in small
    // chunks has to yield the same estimates as feeding it in one go, or the
    // effective hop silently becomes the poll interval again.
    #[test]
    fn chunked_input_yields_the_same_estimates_as_one_batch() {
        let window = window_for(SAMPLE_RATE);
        let hop = (SAMPLE_RATE as u32).div_ceil(100) as usize;
        let tone = vibrato_tone(0.4, 196.0, 6.0, 0.4);

        let mut whole = PitchFramer::new(SAMPLE_RATE, window, hop, SAMPLE_RATE as usize);
        let batch = whole.analyze(&tone);

        let mut chunked = PitchFramer::new(SAMPLE_RATE, window, hop, SAMPLE_RATE as usize);
        let mut incremental = Vec::new();
        for chunk in tone.chunks(512) {
            incremental.extend(chunked.analyze(chunk).into_iter().map(|e| e.midi_number));
        }

        let batch_midi: Vec<f32> = batch.iter().map(|e| e.midi_number).collect();
        assert_eq!(batch_midi.len(), incremental.len());
        for (a, b) in batch_midi.iter().zip(incremental.iter()) {
            assert!(
                (a - b).abs() < 1e-4,
                "chunking changed a reading: {a} vs {b}"
            );
        }
    }

    // A late poll used to cost every window but the newest. Now the backlog is
    // analysed in full, so a renderer stall costs latency, not lost singing.
    #[test]
    fn a_backlog_is_analysed_rather_than_discarded() {
        let window = window_for(SAMPLE_RATE);
        let hop = (SAMPLE_RATE as u32).div_ceil(100) as usize;
        let mut framer = PitchFramer::new(SAMPLE_RATE, window, hop, SAMPLE_RATE as usize);

        // A tenth of a second arriving at once, four polls' worth.
        let estimates = framer.analyze(&vibrato_tone(0.1, 220.0, 5.5, 0.2));
        assert!(
            estimates.len() >= 7,
            "expected the whole backlog to be analysed, got {} estimates",
            estimates.len()
        );
        assert!(estimates.iter().all(|e| e.midi_number > 0.0));
    }

    // But not without limit: audio older than the cap is dropped, because a
    // long stall means the singer has moved on.
    #[test]
    fn backlog_beyond_the_cap_is_dropped() {
        let window = window_for(SAMPLE_RATE);
        let hop = (SAMPLE_RATE as u32).div_ceil(100) as usize;
        let cap = (SAMPLE_RATE * 0.2) as usize;
        let mut framer = PitchFramer::new(SAMPLE_RATE, window, hop, cap);

        let estimates = framer.analyze(&vibrato_tone(1.0, 220.0, 5.5, 0.2));
        let max_estimates = cap / hop + 1;
        assert!(
            estimates.len() <= max_estimates,
            "expected at most {max_estimates} estimates from a {cap}-sample cap, got {}",
            estimates.len()
        );
    }
}
