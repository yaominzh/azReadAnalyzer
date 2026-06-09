use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use tauri::AppHandle;
use tempfile::NamedTempFile;

pub struct Recorder {
    _stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    stop_flag: Arc<AtomicBool>,
    channels: u16,
    sample_rate: u32,
}

impl Recorder {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or("No microphone found")?;
        let config = device.default_input_config().map_err(|e| e.to_string())?;

        let channels = config.channels();
        let sample_rate = config.sample_rate().0;
        let sample_format = config.sample_format();
        let stream_config: cpal::StreamConfig = config.into();

        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let stop_flag = Arc::new(AtomicBool::new(false));

        // Tier-B B3: branch on the device's sample format instead of assuming f32.
        let stream = match sample_format {
            SampleFormat::F32 => build_stream::<f32>(
                &device, &stream_config, samples.clone(), stop_flag.clone(), app,
            )?,
            SampleFormat::I16 => build_stream::<i16>(
                &device, &stream_config, samples.clone(), stop_flag.clone(), app,
            )?,
            SampleFormat::U16 => build_stream::<u16>(
                &device, &stream_config, samples.clone(), stop_flag.clone(), app,
            )?,
            other => return Err(format!("Unsupported sample format: {other:?}")),
        };

        stream.play().map_err(|e| e.to_string())?;

        Ok(Self { _stream: stream, samples, stop_flag, channels, sample_rate })
    }

    pub fn stop(self) -> Result<NamedTempFile, String> {
        self.stop_flag.store(true, Ordering::Relaxed);
        // _stream is dropped here, stopping the stream.

        let raw = self.samples.lock().map_err(|e| e.to_string())?;

        // Mix down to mono if stereo.
        let mono: Vec<f32> = if self.channels > 1 {
            raw.chunks(self.channels as usize)
                .map(|ch| ch.iter().sum::<f32>() / self.channels as f32)
                .collect()
        } else {
            raw.clone()
        };

        // Unique temp WAV; auto-deleted when the caller drops the handle (after STT).
        let temp = tempfile::Builder::new()
            .prefix("az_recording_")
            .suffix(".wav")
            .tempfile()
            .map_err(|e| format!("temp file: {e}"))?;

        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: self.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(temp.path(), spec).map_err(|e| e.to_string())?;
        for sample in mono {
            let s = (sample * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            writer.write_sample(s).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;

        Ok(temp)
    }
}

/// Build a cpal input stream for sample type `T`, converting each sample to f32,
/// emitting RMS audio-level events, and accumulating into `samples`.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    samples: Arc<Mutex<Vec<f32>>>,
    stop_flag: Arc<AtomicBool>,
    app: AppHandle,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if stop_flag.load(Ordering::Relaxed) {
                    return;
                }
                let buf: Vec<f32> = data.iter().map(|&s| f32::from_sample(s)).collect();

                // RMS for the waveform display.
                let rms = (buf.iter().map(|s| s * s).sum::<f32>() / buf.len().max(1) as f32)
                    .sqrt()
                    .min(1.0);
                // Typed helper → payload {level: f32}; Emitter trait already in scope there.
                crate::events::emit_audio_level(&app, rms);

                if let Ok(mut guard) = samples.lock() {
                    guard.extend_from_slice(&buf);
                }
            },
            |err| eprintln!("Audio stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn recorder_compiles() {
        let _ = std::mem::size_of::<super::Recorder>();
    }
}
