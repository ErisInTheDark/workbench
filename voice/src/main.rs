//! No exports. Own the private JSON-line protocol and one active speech session.

mod recognizer;

use base64::Engine;
use recognizer::{Recognizer, Stream};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Read, Write};
use workbench_voice::{Transcript, TranscriptState};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Start { #[serde(rename = "sessionId")] session_id: String },
    Audio { #[serde(rename = "sessionId")] session_id: String, pcm: String },
    Finish { #[serde(rename = "sessionId")] session_id: String },
    Cancel { #[serde(rename = "sessionId")] session_id: String },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Event<'a> {
    Ready { version: u8 },
    Started { #[serde(rename = "sessionId")] session_id: &'a str },
    Transcript { delta: Transcript },
    Finished { #[serde(rename = "sessionId")] session_id: &'a str },
    Cancelled { #[serde(rename = "sessionId")] session_id: &'a str },
    Error { #[serde(rename = "sessionId")] session_id: Option<&'a str>, message: &'a str },
}

struct Session<'a> {
    id: String,
    stream: Stream<'a>,
    transcript: TranscriptState,
}

fn emit(output: &mut impl Write, event: Event<'_>) -> Result<(), String> {
    serde_json::to_writer(&mut *output, &event).map_err(|_| "Protocol output failed")?;
    output.write_all(b"\n").and_then(|_| output.flush()).map_err(|_| "Protocol output failed".into())
}

impl Session<'_> {
    fn publish(&mut self, output: &mut impl Write, final_segment: bool) -> Result<(), String> {
        let result = self.stream.result()?;
        let delta = self.transcript.update(&self.id, result.hypotheses, final_segment)?;
        emit(output, Event::Transcript { delta })
    }

    fn decode(&mut self, output: &mut impl Write, finishing: bool) -> Result<(), String> {
        while self.stream.decode() {
            let endpoint = !finishing && self.stream.endpoint();
            self.publish(output, endpoint)?;
            if endpoint { self.stream.reset(); }
        }
        if finishing { self.publish(output, true)?; }
        Ok(())
    }
}

fn run() -> Result<(), String> {
    let directory = std::env::var_os("WORKBENCH_VOICE_MODEL_DIR")
        .ok_or("WORKBENCH_VOICE_MODEL_DIR is required")?;
    let recognizer = Recognizer::load(std::path::Path::new(&directory))?;
    let mut active: Option<Session<'_>> = None;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    emit(&mut output, Event::Ready { version: 1 })?;
    loop {
        // Bound a single line before allocating an untrusted PCM payload.
        let mut line = Vec::new();
        let size = (&mut input).take(65537).read_until(b'\n', &mut line)
            .map_err(|_| "Protocol input failed")?;
        if size == 0 { return Ok(()); }
        if line.len() > 65536 { return Err("Protocol line exceeds 64 KiB".into()); }
        let request = match serde_json::from_slice::<Request>(&line) {
            Ok(request) => request,
            Err(_) => {
                emit(&mut output, Event::Error { session_id: None, message: "Invalid voice request" })?;
                continue;
            }
        };
        let id = match &request {
            Request::Start { session_id } | Request::Audio { session_id, .. }
                | Request::Finish { session_id } | Request::Cancel { session_id } => session_id,
        };
        if id.is_empty() || id.encode_utf16().count() > 128 {
            emit(&mut output, Event::Error { session_id: None, message: "Invalid session identity" })?;
            continue;
        }
        if let Request::Start { .. } = request {
            if active.is_some() {
                emit(&mut output, Event::Error { session_id: Some(id), message: "A speech session is already active" })?;
            } else {
                active = Some(Session { id: id.clone(), stream: recognizer.stream()?, transcript: TranscriptState::default() });
                emit(&mut output, Event::Started { session_id: id })?;
            }
            continue;
        }
        let Some(session) = active.as_mut().filter(|session| session.id == *id) else {
            emit(&mut output, Event::Error { session_id: Some(id), message: "Speech session is not active" })?;
            continue;
        };
        let outcome = match &request {
            Request::Audio { pcm, .. } => {
                match base64::engine::general_purpose::STANDARD.decode(pcm) {
                    Ok(bytes) if !bytes.is_empty() && bytes.len() <= 32000 && bytes.len() % 2 == 0 => {
                        let samples: Vec<f32> = bytes.chunks_exact(2)
                            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
                        session.stream.accept(&samples).and_then(|()| session.decode(&mut output, false))
                    }
                    _ => Err("Invalid signed 16-bit little-endian PCM".into()),
                }
            }
            Request::Finish { .. } => session.stream.finish_input()
                .and_then(|()| session.decode(&mut output, true)),
            Request::Cancel { .. } => Ok(()),
            Request::Start { .. } => unreachable!(),
        };
        match outcome {
            Err(message) => {
                active = None;
                emit(&mut output, Event::Error { session_id: Some(id), message: &message })?;
            }
            Ok(()) => match request {
                Request::Finish { .. } => {
                    active = None;
                    emit(&mut output, Event::Finished { session_id: id })?;
                }
                Request::Cancel { .. } => {
                    active = None;
                    emit(&mut output, Event::Cancelled { session_id: id })?;
                }
                _ => {}
            }
        }
    }
}

fn main() {
    if let Err(message) = run() {
        eprintln!("workbench-voice: {message}");
        std::process::exit(1);
    }
}
