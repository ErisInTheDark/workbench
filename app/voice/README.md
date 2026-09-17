# native voice recognition

Private Rust process for streaming English recognition, connected to Workbench's controlled text editors. No native network listener or external ASR service.

## workbench integration

Build on the daemon machine, then select a global profile or Custom in Settings > Voice input. This reuses the composer profile picker/editor. The selected provider must support single-file editing (currently Codex) and the profile must explicitly select reasoning effort `none`. The selected agent supplies custom instructions. Named profile edits apply to the next session; deletion retains the saved Custom fallback. Disable clears selection and cancels active voice.

Hold an editor's microphone button to dictate; release to flush and finish. Keyboard Space/Enter also hold, Escape cancels. Preparing, listening and finishing keep the controlled field locked. The transformer edits a private scratch document with native tools; speech never appends directly. Already-applied edits remain after cancellation. Independent parent changes, disconnect and unmount cancel and fence late updates.

Browser microphone capture requires a secure origin (HTTPS or localhost). Audio travels through the existing daemon WebSocket, including private Tailscale connections. The browser and daemon need not share a device. Audio stays on those private machines, in memory; transcript and current document text reach the selected LLM provider. A cloud transformer therefore exposes **text**, not audio. Native diagnostic output is not forwarded as transcript logs.

One active voice session per daemon avoids queued stale audio. Capture resamples continuously to 16 kHz mono and sends 100 ms PCM16 frames. More than one second of queued audio fails visibly instead of dropping samples or accumulating latency. Model loading has no arbitrary deadline. Prepare warms reusable recognition and provider processes.

The transformer starts one ephemeral native thread/turn immediately, receives revisioned transcript snapshots as steers, and waits with `wait_for_transcript` between updates. Release sends an explicit final packet only after ASR drain. Completion waits for actual file reads before unlocking. Premature model completion resumes the same document/thread in the background; repeated no-progress completion parks until new input rather than spinning paid turns.

Tool access is restricted to the owned scratch file, with no escalation, tool network or inherited MCP servers. Resolved role-filtered `AGENTS.md` is the sole instruction payload. Unsupported permission configuration fails closed.

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

Build/test modes prepare dependencies automatically. Downloads/builds live in `.workbench/native-voice/`; Cargo outputs live in `app/voice/target/`. Successful build publishes `.workbench/native-voice/runtime.json` with matching executable/model paths and machine identity. The daemon reads this descriptor; missing assets produce a setup error, never automatic downloads. Extraction uses CMake's archive support. Incomplete extraction fails visibly and is retained for inspection. No automatic cleanup or toolchain installation.

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

## validation and reloads

From the repository root, `wb test` exercises TypeScript owners and `pnpm typecheck` checks all project targets. `node scripts/build-voice.mjs --test` adds native fixture validation. Browser/microphone and paid transformer checks are separate, explicitly authorised validation; unit tests do not establish microphone-to-document latency or cross-platform permission enforcement.

Changes require user-owned scoped reloads of daemon database/core/provider/instructions and app compiler. Reload cancels active voice sessions. No full-process restart is intended.
