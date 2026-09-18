//! Exports:
//! - Recognizer: CPU model owner, creating independently owned decoding streams.
//! - Stream: recogniser-borrowing audio, endpoint and result lifecycle.
//! - ResultSnapshot: original best result alongside the entire retained beam.

use serde::Deserialize;
use sherpa_onnx_sys as ffi;
use std::ffi::{CStr, CString};
use std::path::Path;
use std::ptr::NonNull;
use workbench_voice::Hypothesis;

#[derive(Debug, Deserialize)]
pub struct ResultSnapshot {
    pub text: String,
    pub hypotheses: Vec<Hypothesis>,
}

pub struct Recognizer(NonNull<ffi::OnlineRecognizer>);

pub struct Stream<'a> {
    recognizer: &'a Recognizer,
    pointer: NonNull<ffi::OnlineStream>,
}

impl Recognizer {
    pub fn load(directory: &Path) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Model { encoder: String, decoder: String, joiner: String, tokens: String }
        #[derive(Deserialize)]
        struct Dependencies { model: Model }
        let dependencies: Dependencies = serde_json::from_str(include_str!("../native-dependencies.json"))
            .map_err(|_| "Invalid embedded model manifest")?;
        let model = dependencies.model;
        let paths = [model.encoder, model.decoder, model.joiner, model.tokens]
            .into_iter().map(|name| {
                let path = directory.join(name);
                if !path.is_file() { return Err("Required model file is missing".to_owned()); }
                CString::new(path.to_str().ok_or("Model path is not UTF-8")?)
                    .map_err(|_| "Model path contains NUL".to_owned())
            }).collect::<Result<Vec<_>, _>>()?;
        let cpu = CString::new("cpu").unwrap();
        let decoding = CString::new("modified_beam_search").unwrap();
        // The C config contains only numeric scalars and nullable pointers.
        // Strings remain alive until Create has copied the configuration.
        let mut config: ffi::OnlineRecognizerConfig = unsafe { std::mem::zeroed() };
        config.feat_config.sample_rate = 16000;
        config.feat_config.feature_dim = 80;
        config.model_config.transducer.encoder = paths[0].as_ptr();
        config.model_config.transducer.decoder = paths[1].as_ptr();
        config.model_config.transducer.joiner = paths[2].as_ptr();
        config.model_config.tokens = paths[3].as_ptr();
        config.model_config.num_threads = 1;
        config.model_config.provider = cpu.as_ptr();
        config.decoding_method = decoding.as_ptr();
        config.max_active_paths = 8;
        config.enable_endpoint = 1;
        config.rule1_min_trailing_silence = 2.4;
        config.rule2_min_trailing_silence = 1.2;
        config.rule3_min_utterance_length = 20.0;
        let pointer = unsafe { ffi::SherpaOnnxCreateOnlineRecognizer(&config) };
        let recognizer = Self(NonNull::new(pointer.cast_mut()).ok_or("Native model creation failed")?);
        // Stock binaries must fail immediately, before accepting user audio.
        recognizer.stream()?.result()?;
        Ok(recognizer)
    }

    pub fn stream(&self) -> Result<Stream<'_>, String> {
        let pointer = unsafe { ffi::SherpaOnnxCreateOnlineStream(self.0.as_ptr()) };
        Ok(Stream {
            recognizer: self,
            pointer: NonNull::new(pointer.cast_mut()).ok_or("Native stream creation failed")?,
        })
    }
}

impl Drop for Recognizer {
    fn drop(&mut self) {
        unsafe { ffi::SherpaOnnxDestroyOnlineRecognizer(self.0.as_ptr()) };
    }
}

impl Stream<'_> {
    pub fn accept(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.len() > 16000 || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0) {
            return Err("Invalid PCM chunk".into());
        }
        unsafe {
            ffi::SherpaOnnxOnlineStreamAcceptWaveform(
                self.pointer.as_ptr(), 16000, samples.as_ptr(), samples.len() as i32,
            );
        }
        Ok(())
    }

    pub fn decode(&mut self) -> bool {
        unsafe {
            if ffi::SherpaOnnxIsOnlineStreamReady(self.recognizer.0.as_ptr(), self.pointer.as_ptr()) == 0 {
                return false;
            }
            ffi::SherpaOnnxDecodeOnlineStream(self.recognizer.0.as_ptr(), self.pointer.as_ptr());
        }
        true
    }

    pub fn result(&self) -> Result<ResultSnapshot, String> {
        struct Json(*const std::ffi::c_char);
        impl Drop for Json {
            fn drop(&mut self) { unsafe { ffi::SherpaOnnxDestroyOnlineStreamResultJson(self.0) }; }
        }
        let pointer = unsafe {
            ffi::SherpaOnnxGetOnlineStreamResultAsJson(self.recognizer.0.as_ptr(), self.pointer.as_ptr())
        };
        if pointer.is_null() { return Err("Native result allocation failed".into()); }
        let buffer = Json(pointer);
        let bytes = unsafe { CStr::from_ptr(buffer.0) }.to_bytes();
        let result: ResultSnapshot = serde_json::from_slice(bytes)
            .map_err(|_| "Native result lacks valid retained hypotheses; patched library required")?;
        // The public best result strips leading spaces; retained paths are raw.
        if result.hypotheses.is_empty() || result.hypotheses.len() > 64
            || !result.hypotheses.iter().any(|h| h.text.trim_start() == result.text)
            || result.hypotheses.iter().any(|h| !h.score.is_finite()
                || h.timestamps.iter().any(|t| !t.is_finite() || *t < 0.0))
        {
            return Err("Native beam evidence is invalid".into());
        }
        Ok(result)
    }

    pub fn endpoint(&self) -> bool {
        unsafe {
            ffi::SherpaOnnxOnlineStreamIsEndpoint(self.recognizer.0.as_ptr(), self.pointer.as_ptr()) != 0
        }
    }

    pub fn reset(&mut self) {
        unsafe { ffi::SherpaOnnxOnlineStreamReset(self.recognizer.0.as_ptr(), self.pointer.as_ptr()) };
    }

    pub fn finish_input(&mut self) -> Result<(), String> {
        // Supply acoustic right context, matching upstream streaming examples.
        self.accept(&[0.0; 4800])?;
        unsafe { ffi::SherpaOnnxOnlineStreamInputFinished(self.pointer.as_ptr()) };
        Ok(())
    }
}

impl Drop for Stream<'_> {
    fn drop(&mut self) { unsafe { ffi::SherpaOnnxDestroyOnlineStream(self.pointer.as_ptr()) }; }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::time::Instant;

    #[test]
    fn fixture_retains_live_evidence_and_drains_across_stream_lifetimes() {
        let directory = std::env::var_os("WORKBENCH_VOICE_MODEL_DIR")
            .expect("Use node scripts/build-voice.mjs --test");
        let directory = Path::new(&directory);
        let started = Instant::now();
        let recognizer = Recognizer::load(directory).unwrap();
        let load_time = started.elapsed();
        let fixture = std::env::var_os("WORKBENCH_VOICE_TEST_DIR")
            .expect("Use node scripts/build-voice.mjs --test");
        let fixture = Path::new(&fixture);
        let mut reader = hound::WavReader::open(fixture.join("test_wavs/0.wav")).unwrap();
        assert_eq!(reader.spec().sample_rate, 16000);
        assert_eq!(reader.spec().channels, 1);
        let samples: Vec<f32> = reader.samples::<i16>()
            .map(|sample| sample.unwrap() as f32 / 32768.0).collect();
        let reference = std::fs::read_to_string(fixture.join("test_wavs/trans.txt")).unwrap();
        let reference = reference.lines().find(|line| line.starts_with("0.wav ")).unwrap();
        let last_word = reference.split_whitespace().last().unwrap().to_lowercase();
        let mut stream = recognizer.stream().unwrap();
        let started = Instant::now();
        let mut saw_competition = false;
        let mut longest_decode = std::time::Duration::ZERO;
        let mut first_text_at = None;
        for (index, chunk) in samples.chunks(1600).enumerate() {
            let tick = Instant::now();
            stream.accept(chunk).unwrap();
            while stream.decode() {
                let result = stream.result().unwrap();
                if !result.text.trim().is_empty() && first_text_at.is_none() {
                    first_text_at = Some(((index + 1) * 1600).min(samples.len()) as f64 / 16000.0);
                }
                assert!(result.hypotheses.iter().any(|h| h.text.trim_start() == result.text),
                    "Original best result disappeared from exposed evidence");
                let texts: BTreeSet<_> = result.hypotheses.iter().map(|h| &h.text).collect();
                saw_competition |= texts.len() > 1;
            }
            longest_decode = longest_decode.max(tick.elapsed());
        }
        assert!(saw_competition, "No competing hypotheses before end-of-input");
        stream.finish_input().unwrap();
        while stream.decode() {}
        let final_result = stream.result().unwrap();
        assert!(final_result.hypotheses.iter().any(|h|
            h.text.to_lowercase().split_whitespace().last() == Some(last_word.as_str())),
            "Trailing reference word did not survive final drain");
        let decode_time = started.elapsed();
        let audio_seconds = samples.len() as f64 / 16000.0;
        eprintln!("fixture metrics: load={load_time:?} decode={decode_time:?} audio={audio_seconds:.2}s first_text_audio_seconds={first_text_at:?} max_chunk={longest_decode:?} rtf={:.3}",
            decode_time.as_secs_f64() / audio_seconds);

        drop(stream);
        let mut cancelled = recognizer.stream().unwrap();
        for chunk in samples.chunks(1600) {
            cancelled.accept(chunk).unwrap();
            while cancelled.decode() {}
        }
        cancelled.reset();
        assert!(cancelled.result().unwrap().text.trim().is_empty());
        cancelled.accept(&samples[..1600]).unwrap();
        while cancelled.decode() {}
        drop(cancelled); // Cancellation discards a partial stream, not the model.
        for _ in 0..3 {
            let mut fresh = recognizer.stream().unwrap();
            assert!(fresh.result().unwrap().text.trim().is_empty());
            for chunk in samples.chunks(1600) {
                fresh.accept(chunk).unwrap();
                while fresh.decode() {}
            }
            fresh.finish_input().unwrap();
            while fresh.decode() {}
            assert_eq!(fresh.result().unwrap().text, final_result.text,
                "Disposed stream state leaked into the next utterance");
        }
    }
}
