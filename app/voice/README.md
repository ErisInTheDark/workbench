# native voice recognition

Private Rust process for streaming English recognition. No network listener or external ASR service. Workbench browser/transformer integration is separate and not implemented here yet.

## dependencies

- Rust/Cargo, Node.js, Git, CMake and a C++17 compiler.
- Windows defaults to Visual Studio 2022 Build Tools with the Windows SDK, matching Rust's MSVC target. macOS/Linux default to Unix Makefiles. `CMAKE_GENERATOR` can select another installed generator.
- Published `sherpa-onnx-sys = 1.13.7`, locked by Cargo. No Rust fork.
- `native-dependencies.json` pins upstream source commit, archive SHA-256 and model provenance. First acquisition trusts the upstream HTTPS release. Subsequent acquisitions verify recorded digests.
- Native-only patch exposes retained modified-beam-search paths through the existing C JSON API. Existing best-result fields and decoding remain unchanged.
- Upstream CMake owns its pinned native dependency downloads. Preinstalled ONNX Runtime discovery is disabled.
- English streaming Zipformer, int8 encoder/joiner, floating-point decoder, CPU provider, eight active paths, one inference thread.

## commands

Run from repository root:

````sh
node scripts/build-voice.mjs --prepare
node scripts/build-voice.mjs --build
node scripts/build-voice.mjs --test
pnpm typecheck
````

Build/test modes prepare dependencies automatically. Downloads/builds live in `.workbench/native-voice/`; Cargo outputs live in `app/voice/target/`. Extraction uses CMake's archive support. Incomplete extraction fails visibly and is retained for inspection. No automatic cleanup or toolchain installation.

The build owner supplies `SHERPA_ONNX_LIB_DIR` to the official sys crate, copies runtime libraries beside normal and test executables, and sets executable-relative library lookup on macOS/Linux. Deploy those libraries with the executable, not the executable alone. A stock top-1-only library is rejected during startup.

`--test` executes pure alignment tests plus native fixture recognition, live competing paths, trailing-word drain and repeated stream disposal. It prints model load time, decode wall time, maximum chunk processing time and real-time factor. These are fixture measurements, not browser end-to-end latency or peak RAM.

For alignment-only work, without building native libraries:

````sh
cargo test --manifest-path app/voice/Cargo.toml --lib --locked
````

`--pin` is a maintainer bootstrap operation, not a normal build step. It refuses an already-pinned manifest. Dependency upgrades require reviewing the version, native patch and new artifact identities together.

## process protocol

Set `WORKBENCH_VOICE_MODEL_DIR` to the model directory printed by `--prepare`. Run `app/voice/target/release/workbench-voice` (`.exe` on Windows). Requests/events are newline-delimited JSON over stdin/stdout. Diagnostics use stderr.

````json
{"type":"start","sessionId":"example"}
{"type":"audio","sessionId":"example","pcm":"BASE64_PCM"}
{"type":"finish","sessionId":"example"}
````

- `ready` carries protocol version 1 after model load and patched-API validation.
- `started` acknowledges a new session. Only one session is active per process.
- `audio` carries signed PCM16 little-endian, 16 kHz mono, at most one second per chunk. Small chunks enable live output. Audio remains in memory.
- `transcript` carries a full revisioned transcript snapshot, not an append operation.
- `finish` supplies acoustic right context, drains decoding, emits final transcript then `finished`.
- `cancel` discards the stream without draining and emits `cancelled`.
- EOF disposes the stream and model. Invalid audio ends its session with `error`; invalid identities cannot cancel another session.
- Each input line is bounded to 64 KiB. The caller owns audio backpressure and process cancellation.

The shared TypeScript/Zod contract lives in `shared/workbench/voice/voice-contract.ts`.

## uncertainty

`hypotheses` retains every surviving beam path with native text, tokens, timestamps and sequence score. Scores are not calibrated confidence.

Alignment normalises surviving sequence scores, combines support for identical text options and displays up to three options with at least 10% beam-relative support. Phrase alternatives preserve correlated differences; insertions/deletions use an empty option. No dictionary expansion or profanity filter.

`stableText + unstableText` is the current transcript. While decoding, only complete words shared by every retained path enter the stable prefix; the final word remains mutable. Endpointed segments become immutable history, including their alternatives. `isFinal` finalises a segment, not the session. `finished` ends ASR drain only; the caller must also await transformer patches before unlocking the editable.

Alternative offsets are UTF-16 positions in the combined text. `inlineText` renders bracket alternatives for a transformer. The transformer, not speech recognition, owns the final editable document.

Windows, macOS and Linux are deployment targets. Runtime performance and packaging must be validated per target; model file size is not a RAM estimate.
