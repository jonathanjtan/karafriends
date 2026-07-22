#![allow(non_snake_case)]

mod pitch_detector;
mod reverb_module;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::iter::{FromIterator, Iterator};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, LazyLock, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use itertools::{EitherOrBoth, Itertools};
use neon::prelude::Finalize;
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use rubato::Resampler;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

// How many pitch-detection windows of headroom the input ring carries. One
// window is what the detector consumes per call; the rest is slack for a late
// poll, so the input callback never has to drop fresh audio. Four windows is
// 100ms at 48kHz -- comfortably more jitter than a renderer setInterval shows
// in practice, and still small enough that a stall discards audio rather than
// letting a long backlog build up.
const PITCH_RING_WINDOWS: usize = 4;

// Discard everything in the pitch ring except the most recent `window`
// samples. The ring carries several windows so the input callback never has
// to drop fresh audio, but any backlog that accumulated since the last poll
// is stale by definition -- the singer is at the newest end of it. Analysing
// the oldest window instead would score the performance against audio that is
// already one or more poll intervals late.
fn skip_stale_pitch_samples(rx: &mut impl Consumer<Item = f32>, window: usize) {
    let backlog = rx.occupied_len();
    if backlog > window {
        rx.skip(backlog - window);
    }
}

#[cfg(feature = "asio")]
static CPAL_ASIO_HOST: LazyLock<std::result::Result<cpal::Host, cpal::HostUnavailable>> =
    LazyLock::new(|| cpal::host_from_id(cpal::HostId::Asio));

static INPUT_DEVICES: LazyLock<Mutex<HashMap<String, cpal::Device>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

enum DeviceType {
    #[cfg(feature = "asio")]
    Asio,
    Usb,
}

struct Stream(cpal::Stream);

unsafe impl Send for Stream {}
unsafe impl Sync for Stream {}

pub struct InputDevice {
    input_stream: Arc<Mutex<Stream>>,
    output_stream: Arc<Mutex<Stream>>,
    pitch_rx: ringbuf::HeapCons<f32>,
    pitch_sample_count: usize,
    pitch_detector: pitch_detector::PitchDetector,
    // Shared with the input callback, which reads it every buffer. Gates only
    // the mic's path out to the speakers (dry + reverb); pitch tracking
    // always sees the raw mic signal.
    mic_output_enabled: Arc<AtomicBool>,
}

unsafe impl Send for InputDevice {}

impl Finalize for InputDevice {}

impl InputDevice {
    pub fn collect_devices<Collector: FromIterator<(String, cpal::StreamConfig)>>(
    ) -> Result<Collector> {
        _input_devices()?
            .map(|(input_device, device_type)| {
                let mut supported_input_configs: Vec<_> =
                    input_device.supported_input_configs().unwrap().collect();
                supported_input_configs.sort_by(|a, b| compare_configs(a, b, None));
                let best_supported_input_config = supported_input_configs
                    .last()
                    .ok_or("No supported input configs")?;
                let input_config = supported_config_to_config(best_supported_input_config);
                Ok((_device_name(&input_device, &device_type), input_config))
            })
            .collect::<Result<Collector>>()
    }

    pub fn new(name: &str, channel_selection: usize) -> Result<Self> {
        let mut input_devices = INPUT_DEVICES.lock().unwrap();
        let input_device = match input_devices.get(name) {
            Some(device) => device,
            None => {
                input_devices.insert(
                    name.to_string(),
                    _input_devices()?
                        .find(|(input_device, device_type)| {
                            _device_name(input_device, device_type) == name
                        })
                        .ok_or(format!("Could not find device: {}", name))?
                        .0,
                );
                &input_devices[name]
            }
        };
        let mut supported_input_configs: Vec<_> = input_device.supported_input_configs()?.collect();
        supported_input_configs.sort_by(|a, b| compare_configs(a, b, None));
        let best_supported_input_config = supported_input_configs
            .last()
            .ok_or("No supported input configs")?;
        let input_config = supported_config_to_config(best_supported_input_config);
        let _input_channels = input_config.channels as usize;

        println!(
            "Created input device {} with config {:#?}, sample format {:#?}",
            input_device.id()?,
            input_config,
            best_supported_input_config.sample_format(),
        );

        let output_host = cpal::default_host();
        let output_device = output_host
            .default_output_device()
            .ok_or("No default output device")?;
        let mut supported_output_configs: Vec<_> =
            output_device.supported_output_configs()?.collect();
        supported_output_configs
            .sort_by(|a, b| compare_configs(a, b, Some(input_config.sample_rate)));
        let best_supported_output_config = supported_output_configs
            .last()
            .ok_or("No supported output configs")?;
        let mut output_config = supported_config_to_config(best_supported_output_config);
        if input_config.sample_rate >= best_supported_output_config.min_sample_rate()
            && input_config.sample_rate <= best_supported_output_config.max_sample_rate()
        {
            output_config.sample_rate = input_config.sample_rate;
        }
        let output_channels = output_config.channels as usize;

        println!(
            "Created output device {} with config {:#?}, sample format {:#?}",
            output_device.id().unwrap(),
            output_config,
            best_supported_output_config.sample_format(),
        );

        let pitch_sample_count = input_config.sample_rate.div_ceil(40) as usize;
        // Several windows deep, not one. The consumer (get_pitch) is a JS
        // setInterval sharing a renderer with a WebGL draw loop, so it runs
        // late routinely. At exactly one window the ring was full whenever
        // that happened and push_slice -- which writes only what fits and
        // drops the rest -- threw away the *newest* audio while get_pitch went
        // on analysing the stale samples still sitting in the buffer. That
        // both lost signal and added a jittery lateness on top of the
        // systematic capture/output latency. The headroom absorbs the jitter;
        // get_pitch discards all but the most recent window.
        let (pitch_tx, pitch_rx) =
            ringbuf::HeapRb::new(pitch_sample_count * PITCH_RING_WINDOWS).split();

        // TODO: rationalize how to pick this size
        // it really needs to be large enough for the input bufer provided by the OS, which can be quite large on windows (upper bound??)
        let (output_tx, output_rx) = ringbuf::HeapRb::new(
            (2048.0 * output_channels as f32 * output_config.sample_rate as f32
                / input_config.sample_rate as f32) as usize,
        )
        .split();

        let pitch_detector =
            pitch_detector::PitchDetector::new(input_config.sample_rate as f32, pitch_sample_count);

        let error_callback = |e| panic!("{}", e);

        let mic_output_enabled = Arc::new(AtomicBool::new(true));

        let input_stream = match best_supported_input_config.sample_format() {
            cpal::SampleFormat::U8 => {
                let mut input_callback = Self::input_data_callback::<u8>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let mut input_callback = Self::input_data_callback::<u16>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U32 => {
                let mut input_callback = Self::input_data_callback::<u32>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U64 => {
                let mut input_callback = Self::input_data_callback::<u64>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I8 => {
                let mut input_callback = Self::input_data_callback::<i8>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let mut input_callback = Self::input_data_callback::<i16>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I32 => {
                let mut input_callback = Self::input_data_callback::<i32>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I64 => {
                let mut input_callback = Self::input_data_callback::<i64>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::F32 => {
                let mut input_callback = Self::input_data_callback::<f32>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::F64 => {
                let mut input_callback = Self::input_data_callback::<f64>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                    Arc::clone(&mic_output_enabled),
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
        }?;

        let output_stream = match best_supported_output_config.sample_format() {
            cpal::SampleFormat::U8 => {
                let mut output_callback = Self::output_data_callback::<u8>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let mut output_callback = Self::output_data_callback::<u16>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U32 => {
                let mut output_callback = Self::output_data_callback::<u32>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U64 => {
                let mut output_callback = Self::output_data_callback::<u64>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I8 => {
                let mut output_callback = Self::output_data_callback::<i8>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let mut output_callback = Self::output_data_callback::<i16>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I32 => {
                let mut output_callback = Self::output_data_callback::<i32>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I64 => {
                let mut output_callback = Self::output_data_callback::<i64>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::F32 => {
                let mut output_callback = Self::output_data_callback::<f32>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::F64 => {
                let mut output_callback = Self::output_data_callback::<f64>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
        }?;

        input_stream.play()?;
        output_stream.play()?;

        Ok(InputDevice {
            input_stream: Arc::new(Mutex::new(Stream(input_stream))),
            output_stream: Arc::new(Mutex::new(Stream(output_stream))),
            pitch_rx,
            pitch_sample_count,
            pitch_detector,
            mic_output_enabled,
        })
    }

    // Mute/unmute the mic in the room's speakers without touching pitch
    // tracking, so the mics can be mixed through external hardware while
    // scoring and the piano roll keep working.
    pub fn set_mic_output_enabled(&self, enabled: bool) {
        self.mic_output_enabled
            .store(enabled, AtomicOrdering::Relaxed);
    }

    pub fn get_pitch(&mut self) -> Result<(f32, f32, f32)> {
        skip_stale_pitch_samples(&mut self.pitch_rx, self.pitch_sample_count);

        let mut samples = vec![0.0; self.pitch_sample_count];
        let popped = self.pitch_rx.pop_slice(&mut samples);
        // RMS over only the samples actually captured this window: the poll
        // and the input callback aren't synchronized, so a partially-filled
        // window would otherwise understate the level (zeros diluting it) and
        // make an absolute-level gate flap on loud singing. YIN itself is
        // amplitude-invariant, so callers need this to tell a singer from
        // quiet-but-periodic bleed (e.g. a mixer's FX return on an idle
        // channel).
        let level = rms(&samples[..popped]);
        let (midi_number, confidence) = self.pitch_detector.detect(samples);
        Ok((midi_number, confidence, level))
    }

    pub fn stop(&self) -> Result<()> {
        self.input_stream.lock().unwrap().0.pause()?;
        self.output_stream.lock().unwrap().0.pause()?;
        Ok(())
    }

    fn input_data_callback<Sample: cpal::Sample + Copy>(
        input_config: &cpal::StreamConfig,
        output_config: &cpal::StreamConfig,
        channel_selection: usize,
        mut pitch_tx: ringbuf::HeapProd<f32>,
        mut output_tx: ringbuf::HeapProd<f32>,
        mic_output_enabled: Arc<AtomicBool>,
    ) -> Result<impl FnMut(&[Sample]) + Send + 'static>
    where
        f32: cpal::FromSample<Sample>,
    {
        let input_config = input_config.clone();
        let output_config = output_config.clone();

        let input_channels = input_config.channels as usize;
        let output_channels = output_config.channels as usize;

        let mut reverbs = [
            reverb_module::ReverbModule::new(input_config.sample_rate, 0.09920, 0.750)?,
            reverb_module::ReverbModule::new(input_config.sample_rate, 0.06930, 0.720)?,
            reverb_module::ReverbModule::new(input_config.sample_rate, 0.04836, 0.691)?,
            reverb_module::ReverbModule::new(input_config.sample_rate, 0.03570, 0.649)?,
            reverb_module::ReverbModule::new(input_config.sample_rate, 0.02196, 0.662)?,
        ];

        let resampler_chunk_size = match input_config.buffer_size {
            cpal::BufferSize::Fixed(count) => count as usize,
            cpal::BufferSize::Default => {
                (input_config.sample_rate / output_config.sample_rate) as usize
            }
        };
        let mut resampler = rubato::SincFixedIn::<f32>::new(
            output_config.sample_rate as f64 / input_config.sample_rate as f64,
            1.0,
            rubato::SincInterpolationParameters {
                sinc_len: 256,
                f_cutoff: 0.95,
                interpolation: rubato::SincInterpolationType::Linear,
                oversampling_factor: 256,
                window: rubato::WindowFunction::BlackmanHarris2,
            },
            resampler_chunk_size,
            1,
        )?;
        // TODO: file a PR against rubato so that it doesn't error for unfilled buffers
        let mut resampler_output = resampler.output_buffer_allocate(true);

        Ok(move |samples: &[Sample]| {
            let mono_samples: Vec<_> = samples
                .chunks(input_channels)
                .map(|channel_samples| {
                    <f32 as cpal::Sample>::from_sample(channel_samples[channel_selection])
                })
                .collect();

            pitch_tx.push_slice(&mono_samples);

            // Everything below is the speaker path — what the room hears out
            // of the app's own output device. Muting gates it here, at the
            // reverb's input, so the tail decays out naturally instead of
            // being chopped off mid-tail; the pitch feed above is untouched,
            // so scoring and the piano roll keep working while the mics are
            // mixed through external hardware.
            let dry_samples: Vec<_> = if mic_output_enabled.load(AtomicOrdering::Relaxed) {
                mono_samples.clone()
            } else {
                vec![0.0; mono_samples.len()]
            };

            let mut reverb_samples: Vec<_> = dry_samples.iter().map(|s| s * 0.2).collect();
            for reverb in &mut reverbs {
                reverb_samples = reverb.process(reverb_samples.as_slice());
            }

            let mut output_samples: Vec<_> = dry_samples
                .iter()
                .zip_longest(reverb_samples.iter())
                .map(|s| match s {
                    EitherOrBoth::Both(a, b) => a + b,
                    EitherOrBoth::Left(s) | EitherOrBoth::Right(s) => *s,
                })
                .collect();

            if input_config.sample_rate != output_config.sample_rate {
                output_samples
                    .chunks(resampler_chunk_size)
                    .for_each(|chunk| {
                        match resampler.process_into_buffer(&[&chunk], &mut resampler_output, None)
                        {
                            Err(e) => eprintln!("resampling error: {}", e),
                            Ok((_input_samples_consumed, output_samples_produced)) => {
                                let samples_written = output_tx.push_iter(
                                    &mut resampler_output[0]
                                        .iter_mut()
                                        .take(output_samples_produced)
                                        .flat_map(|sample| {
                                            std::iter::repeat_n(*sample, output_channels)
                                        }),
                                );
                                if samples_written < output_samples_produced {
                                    eprintln!("output fell behind (with sample rate conversion)!");
                                }
                            }
                        }
                    });
            } else {
                let samples_written = output_tx.push_iter(
                    &mut output_samples
                        .iter_mut()
                        .flat_map(|sample| std::iter::repeat_n(*sample, output_channels)),
                );
                if samples_written < resampler_output[0].len() {
                    eprintln!("output fell behind (without sample rate conversion)!");
                }
            }
        })
    }

    fn output_data_callback<Sample: cpal::Sample + cpal::FromSample<f32> + Send>(
        mut output_rx: ringbuf::HeapCons<f32>,
    ) -> Result<impl FnMut(&mut [Sample]) + Send + 'static> {
        Ok(move |samples: &mut [Sample]| {
            if output_rx.occupied_len() < samples.len() {
                eprintln!("input fell behind");
            }
            samples
                .iter_mut()
                .zip(output_rx.pop_iter())
                .for_each(|(sample, float_sample)| *sample = Sample::from_sample(float_sample));
        })
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

fn compare_configs(
    a: &cpal::SupportedStreamConfigRange,
    b: &cpal::SupportedStreamConfigRange,
    desired_sample_rate: Option<cpal::SampleRate>,
) -> Ordering {
    // Our priorities in order are buffer size (lower is better), sample rate
    // (higher is better), and channel count (higher is better).
    // If we have a desired sample rate, just being in range is good enough.
    if a.buffer_size() == &cpal::SupportedBufferSize::Unknown
        && b.buffer_size() != &cpal::SupportedBufferSize::Unknown
    {
        return Ordering::Less;
    }
    if a.buffer_size() != &cpal::SupportedBufferSize::Unknown
        && b.buffer_size() == &cpal::SupportedBufferSize::Unknown
    {
        return Ordering::Greater;
    }
    if let cpal::SupportedBufferSize::Range { min, max: _ } = a.buffer_size() {
        let a_min = min;
        if let cpal::SupportedBufferSize::Range { min, max: _ } = b.buffer_size() {
            let b_min = min;
            let buffer_size_cmp = a_min.cmp(b_min);
            if buffer_size_cmp != Ordering::Equal {
                return buffer_size_cmp.reverse();
            }
        }
    }
    if let Some(sample_rate) = desired_sample_rate {
        let a_in_range = sample_rate >= a.min_sample_rate() && sample_rate <= a.max_sample_rate();
        let b_in_range = sample_rate >= b.min_sample_rate() && sample_rate <= b.max_sample_rate();
        if !a_in_range && b_in_range {
            return Ordering::Less;
        }
        if a_in_range && !b_in_range {
            return Ordering::Greater;
        }
    }

    let sample_rate_cmp = a.max_sample_rate().cmp(&b.max_sample_rate());
    if sample_rate_cmp != Ordering::Equal {
        return sample_rate_cmp;
    }

    let channels_cmp = a.channels().cmp(&b.channels());
    if channels_cmp != Ordering::Equal {
        return channels_cmp;
    }

    a.cmp_default_heuristics(b)
}

fn supported_config_to_config(
    config_range: &cpal::SupportedStreamConfigRange,
) -> cpal::StreamConfig {
    cpal::StreamConfig {
        channels: config_range.channels(),
        sample_rate: config_range.max_sample_rate(),
        buffer_size: match config_range.buffer_size() {
            // WASAPI lies about buffer size ranges and doesn't repect fixed size requests
            #[cfg(not(windows))]
            cpal::SupportedBufferSize::Range { min, max: _ } => cpal::BufferSize::Fixed(*min),
            _ => cpal::BufferSize::Default,
        },
    }
}

fn _input_devices() -> Result<impl Iterator<Item = (cpal::Device, DeviceType)>> {
    let default_devices = cpal::default_host()
        .input_devices()?
        .map(|device| (device, DeviceType::Usb));
    #[cfg(feature = "asio")]
    {
        Ok(default_devices.chain(
            CPAL_ASIO_HOST
                .as_ref()
                .map_err(|_| "ASIO cpal host unavailable!")?
                .input_devices()?
                .map(|device| (device, DeviceType::Asio)),
        ))
    }
    #[cfg(not(feature = "asio"))]
    Ok(default_devices)
}

fn _device_name(device: &cpal::Device, device_type: &DeviceType) -> String {
    format!(
        "{} ({})",
        device.id().unwrap(),
        match device_type {
            #[cfg(feature = "asio")]
            DeviceType::Asio => "ASIO",
            DeviceType::Usb => "USB",
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pitch_detector::{freq2midi, PitchDetector};
    use wavegen::{sine, wf};

    #[test]
    #[ignore] // TODO: handle reverb
    fn test_input_callback_outputs() -> Result<()> {
        let input_config = cpal::StreamConfig {
            channels: 1,
            sample_rate: 44100,
            buffer_size: cpal::BufferSize::Fixed(256),
        };
        let output_config = cpal::StreamConfig {
            channels: 1,
            sample_rate: 44100,
            buffer_size: cpal::BufferSize::Fixed(256),
        };

        let (pitch_tx, mut pitch_rx) =
            ringbuf::HeapRb::new((input_config.sample_rate as usize).div_ceil(40)).split();
        let (output_tx, mut output_rx) = ringbuf::HeapRb::new(2048).split();

        let mut input_callback = InputDevice::input_data_callback::<f32>(
            &input_config,
            &output_config,
            0,
            pitch_tx,
            output_tx,
            Arc::new(AtomicBool::new(true)),
        )?;

        let latency_sample_count =
            (input_config.sample_rate as f32 * /*ECHO_DELAY_SECS*/ 0.0) as usize;

        let input_samples = wf!(f32, input_config.sample_rate as f32, sine!(185.0))
            .iter()
            .take(latency_sample_count)
            .collect::<Vec<_>>();
        input_callback(&input_samples);

        let output_samples = output_rx.pop_iter().collect::<Vec<_>>();
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect::<Vec<_>>();
        assert_eq!(input_samples[..output_samples.len()], output_samples);
        assert_eq!(input_samples[..pitch_samples.len()], pitch_samples);

        let silence = vec![0.0; latency_sample_count];
        input_callback(&silence);

        // We should now have some echo in the output, but pitch should get a clean signal
        let output_samples = output_rx.pop_iter().collect::<Vec<_>>();
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect::<Vec<_>>();
        assert_eq!(
            input_samples[..output_samples.len()]
                .iter()
                .map(|f| f * /*ECHO_AMPLITUDE*/ 0.0)
                .collect::<Vec<_>>(),
            output_samples
        );
        assert_eq!(silence[..pitch_samples.len()], pitch_samples);

        Ok(())
    }

    // Muting the mics has to stay strictly a speaker-path concern: the room
    // hears nothing, but the pitch feed keeps getting the raw mic signal so
    // scoring and the piano roll survive being mixed through outboard gear.
    #[test]
    // A late poll must be scored against what the singer is doing *now*, not
    // against whatever was sitting at the front of the ring. Before the ring
    // carried headroom, a backlog meant the newest audio was dropped on the
    // producer side and the oldest was analysed on the consumer side -- the
    // worst of both.
    #[test]
    fn test_backlogged_pitch_ring_yields_the_newest_window() -> Result<()> {
        let sample_rate = 44100u32;
        let window = (sample_rate as usize).div_ceil(40);

        let (mut tx, mut rx) = ringbuf::HeapRb::<f32>::new(window * PITCH_RING_WINDOWS).split();

        // Simulate a poll arriving three windows late: an old tone the singer
        // has already moved on from, then the current one.
        let stale = wf!(f32, sample_rate as f32, sine!(220.0))
            .iter()
            .take(window * 2)
            .collect::<Vec<f32>>();
        let fresh = wf!(f32, sample_rate as f32, sine!(440.0))
            .iter()
            .take(window)
            .collect::<Vec<f32>>();

        // Nothing is dropped on the way in -- that is what the headroom buys.
        assert_eq!(tx.push_slice(&stale), stale.len());
        assert_eq!(tx.push_slice(&fresh), fresh.len());

        skip_stale_pitch_samples(&mut rx, window);
        assert_eq!(rx.occupied_len(), window);

        let mut samples = vec![0.0; window];
        let popped = rx.pop_slice(&mut samples);
        assert_eq!(popped, window);

        let mut detector = PitchDetector::new(sample_rate as f32, window);
        let (midi_number, confidence) = detector.detect(samples);
        assert!(
            confidence > 0.5,
            "expected a confident read, got {confidence}"
        );
        assert!(
            (midi_number - freq2midi(440.0)).abs() < 0.5,
            "expected the newest window (440Hz), got midi {midi_number}"
        );
        Ok(())
    }

    fn test_mic_output_disabled_silences_speakers_but_not_pitch() -> Result<()> {
        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: 44100,
            buffer_size: cpal::BufferSize::Fixed(256),
        };

        let (pitch_tx, mut pitch_rx) =
            ringbuf::HeapRb::new((config.sample_rate as usize).div_ceil(40)).split();
        let (output_tx, mut output_rx) = ringbuf::HeapRb::new(8192).split();

        let mic_output_enabled = Arc::new(AtomicBool::new(true));
        let mut input_callback = InputDevice::input_data_callback::<f32>(
            &config,
            &config,
            0,
            pitch_tx,
            output_tx,
            Arc::clone(&mic_output_enabled),
        )?;

        let input_samples = wf!(f32, config.sample_rate as f32, sine!(185.0))
            .iter()
            .take(1024)
            .collect::<Vec<_>>();

        // Baseline: mic output on, so the mic is audible.
        input_callback(&input_samples);
        let output_samples: Vec<f32> = output_rx.pop_iter().collect();
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect();
        let unmuted_peak = output_samples.iter().fold(0.0f32, |a, s| a.max(s.abs()));
        assert!(unmuted_peak > 0.01);
        assert_eq!(input_samples[..pitch_samples.len()], pitch_samples);

        // Muting gates the reverb's input rather than its output, so the dry
        // signal drops out immediately while the tail rings down naturally
        // instead of being chopped off. Both are worth pinning: the first
        // muted buffer is already far below the unmuted level...
        mic_output_enabled.store(false, AtomicOrdering::Relaxed);
        input_callback(&input_samples);
        let first_muted: Vec<f32> = output_rx.pop_iter().collect();
        let first_muted_peak = first_muted.iter().fold(0.0f32, |a, s| a.max(s.abs()));
        pitch_rx.pop_iter().for_each(drop);
        assert!(
            first_muted_peak < unmuted_peak / 10.0,
            "dry signal not gated immediately: {} vs unmuted {}",
            first_muted_peak,
            unmuted_peak
        );

        // ...and the tail decays to true silence rather than settling at some
        // steady-state leak. It measures ~6e-10 by here, so -80dBFS is a
        // generous bound that still fails loudly if the gate ever leaks.
        for _ in 0..160 {
            input_callback(&input_samples);
            output_rx.pop_iter().for_each(drop);
            pitch_rx.pop_iter().for_each(drop);
        }

        input_callback(&input_samples);
        let output_samples: Vec<f32> = output_rx.pop_iter().collect();
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect();
        assert!(!output_samples.is_empty());
        let peak = output_samples.iter().fold(0.0f32, |a, s| a.max(s.abs()));
        assert!(
            peak < 0.0001,
            "speaker path not silent while muted: {}",
            peak
        );
        // The whole point: pitch still sees the mic verbatim while muted.
        assert_eq!(input_samples[..pitch_samples.len()], pitch_samples);
        assert!(pitch_samples.iter().any(|s| s.abs() > 0.01));

        // Unmuting brings the mic straight back.
        mic_output_enabled.store(true, AtomicOrdering::Relaxed);
        input_callback(&input_samples);
        let output_samples: Vec<f32> = output_rx.pop_iter().collect();
        assert!(output_samples.iter().any(|s| s.abs() > 0.01));

        Ok(())
    }

    #[test]
    fn test_rms() {
        assert_eq!(rms(&[]), 0.0);
        assert_eq!(rms(&[0.0; 512]), 0.0);
        // A full-scale sine has an RMS of 1/sqrt(2).
        let sine_samples = wf!(f32, 44100.0, sine!(441.0))
            .iter()
            .take(4410)
            .collect::<Vec<_>>();
        assert!((rms(&sine_samples) - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.001);
    }

    #[test]
    fn test_input_callback_upsampling() -> Result<()> {
        let input_config = cpal::StreamConfig {
            channels: 1,
            sample_rate: 44100,
            buffer_size: cpal::BufferSize::Fixed(256),
        };
        let output_config = cpal::StreamConfig {
            channels: 1,
            sample_rate: 96000,
            buffer_size: cpal::BufferSize::Fixed(256),
        };

        let (pitch_tx, mut pitch_rx) =
            ringbuf::HeapRb::new((input_config.sample_rate as usize).div_ceil(40)).split();
        let (output_tx, mut output_rx) = ringbuf::HeapRb::new(
            (2048.0 * output_config.sample_rate as f32 / input_config.sample_rate as f32) as usize,
        )
        .split();

        let mut input_callback = InputDevice::input_data_callback::<f32>(
            &input_config,
            &output_config,
            0,
            pitch_tx,
            output_tx,
            Arc::new(AtomicBool::new(true)),
        )?;

        let input_samples = wf!(f32, input_config.sample_rate as f32, sine!(185.0))
            .iter()
            .take(2048)
            .collect::<Vec<_>>();
        input_callback(&input_samples);

        // Resampling doesn't preserve phase very well, so use the pitch detector to validate output
        let pitch_sample_count = output_config.sample_rate.div_ceil(40) as usize;
        let pd = PitchDetector::new(output_config.sample_rate as f32, pitch_sample_count);

        let mut output_samples = vec![0.0; pitch_sample_count];
        output_rx.pop_slice(&mut output_samples);
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect::<Vec<_>>();
        let (midi_number, confidence) = pd.detect(output_samples[..pitch_sample_count].to_vec());
        assert!((midi_number - freq2midi(185.0)).abs() < 0.001);
        assert!(confidence > 0.999);
        // Pitch signal does not get resampled
        assert_eq!(input_samples[..pitch_samples.len()], pitch_samples);

        Ok(())
    }

    #[test]
    fn test_input_callback_downsampling() -> Result<()> {
        let input_config = cpal::StreamConfig {
            channels: 1,
            sample_rate: 96000,
            buffer_size: cpal::BufferSize::Fixed(256),
        };
        let output_config = cpal::StreamConfig {
            channels: 1,
            sample_rate: 44100,
            buffer_size: cpal::BufferSize::Fixed(256),
        };

        let (pitch_tx, mut pitch_rx) =
            ringbuf::HeapRb::new((input_config.sample_rate as usize).div_ceil(40)).split();
        let (output_tx, mut output_rx) = ringbuf::HeapRb::new(
            (2048.0 * output_config.sample_rate as f32 / input_config.sample_rate as f32) as usize,
        )
        .split();

        let mut input_callback = InputDevice::input_data_callback::<f32>(
            &input_config,
            &output_config,
            0,
            pitch_tx,
            output_tx,
            Arc::new(AtomicBool::new(true)),
        )?;

        let input_samples = wf!(f32, input_config.sample_rate as f32, sine!(185.0))
            .iter()
            .take(2048)
            .collect::<Vec<_>>();
        input_callback(&input_samples);

        // Resampling doesn't preserve phase very well, so use the pitch detector to validate output
        let pitch_sample_count = output_config.sample_rate.div_ceil(40) as usize;
        let pd = PitchDetector::new(output_config.sample_rate as f32, pitch_sample_count);

        let mut output_samples = vec![0.0; pitch_sample_count];
        output_rx.pop_slice(&mut output_samples);
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect::<Vec<_>>();
        let (midi_number, confidence) = pd.detect(output_samples[..pitch_sample_count].to_vec());
        assert!((midi_number - freq2midi(185.0)).abs() < 0.001);
        assert!(confidence > 0.999);
        // Pitch signal does not get resampled
        assert_eq!(input_samples[..pitch_samples.len()], pitch_samples);

        Ok(())
    }
}
