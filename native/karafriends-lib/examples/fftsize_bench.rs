// Cost of the YIN detector's three transforms at the FFT size each mic sample
// rate produces. PITCH_WINDOW_DIVISOR = 40, so window = sample_rate / 40:
// 44100 -> 1103 (prime), 48000 -> 1200 (2^4 * 3 * 5^2).
use realfft::RealFftPlanner;
use std::time::Instant;

fn bench(label: &str, size: usize, iters: usize) -> f64 {
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(size);
    let rfft = planner.plan_fft_inverse(size);

    let mut samples: Vec<f32> = (0..size).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
    let mut kernel = fft.make_input_vec();
    let mut scratch = fft.make_scratch_vec();
    let mut spec_a = fft.make_output_vec();
    let mut spec_b = fft.make_output_vec();
    let mut out = rfft.make_output_vec();

    // warm up
    for _ in 0..50 {
        let mut s = samples.clone();
        fft.process_with_scratch(&mut s, &mut spec_a, &mut scratch)
            .unwrap();
    }

    let start = Instant::now();
    for _ in 0..iters {
        // exactly what PitchDetector::detect does: 2 forward + 1 inverse
        let mut s = samples.clone();
        fft.process_with_scratch(&mut s, &mut spec_a, &mut scratch)
            .unwrap();
        fft.process_with_scratch(&mut kernel, &mut spec_b, &mut scratch)
            .unwrap();
        let mut prod: Vec<_> = spec_a
            .iter()
            .zip(spec_b.iter())
            .map(|(a, b)| a * b)
            .collect();
        rfft.process(&mut prod, &mut out).unwrap();
        samples[0] += 1e-9;
    }
    let us = start.elapsed().as_secs_f64() * 1e6 / iters as f64;
    println!("{label:<34} size {size:>5}  {us:>8.1} us per detect()");
    us
}

fn main() {
    let iters = 3000;
    let p1103 = bench("44.1 kHz mic (window 1103, PRIME)", 1103, iters);
    let p1200 = bench("48 kHz mic (window 1200)", 1200, iters);
    let p1024 = bench("nearest power of two", 1024, iters);
    let p1152 = bench("smooth >= 1103 (1152 = 2^7*3^2)", 1152, iters);
    println!();
    println!("44.1kHz vs 48kHz : {:.1}x", p1103 / p1200);
    println!("44.1kHz vs 1024  : {:.1}x", p1103 / p1024);
    println!("44.1kHz vs 1152  : {:.1}x", p1103 / p1152);
    println!();
    // Steady state: poll every 25ms, hop 10ms -> ~2.5 windows per poll per mic.
    // Worst case: PITCH_MAX_BACKLOG_SECS = 1.0s of backlog at a 10ms hop = 100
    // windows drained in a single synchronous setInterval callback.
    for (label, us) in [("44.1 kHz", p1103), ("48 kHz", p1200)] {
        for mics in [1usize, 2, 4] {
            println!(
                "{label}, {mics} mic(s): steady {:.2} ms per poll, {:.1} ms/s of main thread; \
                 full 1s backlog drain = {:.0} ms in ONE callback",
                us * 2.5 * mics as f64 / 1000.0,
                us * 100.0 * mics as f64 / 1000.0,
                us * 100.0 * mics as f64 / 1000.0,
            );
        }
    }
}
