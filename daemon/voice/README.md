# native voice recognition

Private Rust process for streaming English recognition, connected to Workbench's controlled text editors. No native network listener or external ASR service.

## workbench integration

Build on the daemon machine, then select a harness and model in Settings > Voice input. The settings checkbox card enables voice for this browser; its contained harness/model drag selectors operate independently. Disabling cancels this browser's active session without clearing the shared model selection. Click/tap opens each selector; keyboard navigation also works. The provider must support single-file editing (currently Codex). Voice uses explicit reasoning effort `none`, without an agent persona or configurable effort, context window or service tier. Custom instructions come from voice-filtered instruction packs and the voice workflow. Previous profile selections retain their saved harness/model but no longer follow profile edits.

The microphone is available when this browser enables voice and a harness/model selection is saved and prepared. Its size follows the field's font, and it appears only while the field or button is hovered or focused. Hold to dictate; release captures another 500 ms before flushing. Keyboard Space/Enter also hold, Escape cancels immediately. Local `on.mp3` plays when capture starts; `off.mp3` plays after microphone tracks stop. Sound failures warn without failing dictation. Release before readiness prevents late capture. Preparing, listening and finishing enable the shared spinning-border halo around the stationary microphone and keep the controlled field locked. Settings show inline harness/model selectors, check/X/loader status and a borderless recording checkbox beside the voice toggle; narrow screens wrap. The transformer edits a private scratch document with native tools; speech never appends directly. Already-applied edits remain after cancellation. Independent parent changes, disconnect and unmount cancel and fence late updates.

Browser microphone capture requires secure HTTPS and the microphone API, including for localhost. Audio travels through the existing daemon WebSocket, including private Tailscale connections. The browser and daemon need not share a device. Audio stays on those private machines, in memory unless local recording is explicitly enabled; transcript and current document text reach the selected LLM provider. A cloud transformer therefore exposes **text**, not audio. Native diagnostic output is not forwarded as transcript logs.

One active voice session per daemon avoids queued stale audio. Capture resamples continuously to 16 kHz mono and sends 100 ms PCM16 frames. More than one second of queued audio fails visibly instead of dropping samples or accumulating latency. Model loading has no arbitrary deadline. Prepare warms reusable recognition and provider processes.

The transformer starts one ephemeral native thread/turn immediately. `wait_for_transcript()` takes no arguments and returns pending recognition context, waiting when none is available. Recognition updates coalesce while the model patches; the next wait returns the latest context. Model input contains no revision counters. Release queues an explicit final packet after ASR drain. Completion waits for delivery, edits and journal writes before unlocking. Premature completion resumes the same document/thread; repeated no-progress completion parks until new input rather than spinning paid turns.

The patchable file contains one `<caret />` or `<selection>...</selection>` marking the captured field position. Ordinary dictation inserts there or replaces selected text; explicit edit commands override that default. The model moves the caret after edits. Literal `&`, `<` and `>` are entity-escaped to distinguish content from metadata. Workbench decodes updates before applying them to the controlled editor. Invalid markers fail without overwriting the last valid text.

Session files live under the Workbench repository's `.workbench/voice-sessions/session-*/`, not the edited project's folder. The latest ten sessions retain `document.txt` and `transcript.md`, including failed/cancelled sessions. The journal contains the original document, exact Workbench-supplied instructions/tool definitions and model input, `<vtt>` tool-result payloads, full `<patch-applied>` file snapshots and terminal outcomes. `<agent-output>` retains native item events, including partial messages, exposed reasoning, tool calls, unexpected requests and completion details. Stream deltas and completed items can overlap intentionally; partial evidence survives failure/cancellation. Event bodies are reversibly HTML-escaped. Provider-internal system prompts are not available through this interface. The model cannot write the journal or other sessions. Paths appear in daemon diagnostics; transcript contents do not.

`Save audio locally` retains `audio.wav` beside that session's journal on the daemon machine. It defaults off after browser reload and is sampled once at session start; changing it during capture affects the next session. The WAV contains exactly the admitted 16 kHz mono PCM16 frames, not the original microphone sample rate. Finish, cancellation, disconnect and reload drain writes and finalise the WAV before retiring its directory. It shares ten-session retention. Recording errors fail visibly. An older daemon rejects an opted-in request before microphone capture; recording-off requests remain compatible.

Tool write access is restricted to the owned scratch file, with no escalation, shell tools, tool network or inherited MCP servers. Keep Codex's default local environment: an empty environment list hides native `apply_patch` even when file permission exists. Resolved role-filtered `AGENTS.md` is the sole instruction payload. Unsupported permission configuration fails closed.

## dependencies

- Rust/Cargo, Node.js, Git, CMake and a C++17 compiler.
- Windows defaults to Visual Studio 2022 Build Tools with the Windows SDK, matching Rust's MSVC target. macOS/Linux default to Unix Makefiles. `CMAKE_GENERATOR` can select another installed generator.
- Published `sherpa-onnx-sys = 1.13.7`, locked by Cargo. No Rust fork.
- `native-dependencies.json` pins upstream source commit/archive SHA-256 and model repository revision/per-file SHA-256. First acquisition trusts upstream HTTPS; subsequent acquisitions verify recorded digests.
- Native-only patch exposes retained modified-beam-search paths through the existing C JSON API. Existing best-result fields and decoding remain unchanged.
- Upstream CMake owns its pinned native dependency downloads. Preinstalled ONNX Runtime discovery is disabled.
- Kroko English streaming Zipformer export `sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06`, CPU provider, eight active paths, one inference thread. Model files total roughly 71 MB; this export is not labelled int8.
- Model licence is separate from the engine: the [export](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06) points to [Kroko's community-model terms](https://huggingface.co/Banafo/Kroko-ASR), described as CC-BY-SA. Preserve provenance and review those terms before redistribution.

## commands

Run from repository root:

````sh
node scripts/build-voice.mjs --prepare
node scripts/build-voice.mjs --build
node scripts/build-voice.mjs --test
pnpm typecheck
````

Build/test modes prepare dependencies automatically. Dependencies live in `.workbench/native-voice/`; Cargo outputs live in `daemon/voice/target/`. Build stages and smoke-tests the executable and libraries, then publishes them to ignored `daemon/voice/bin/<platform>/`. Like tray/network builds, it renames previous artifacts aside, publishes candidates and rolls back on failure. Locked retired images remain in the cache. Successful publication atomically replaces `.workbench/native-voice/runtime.json` with matching executable/model paths and machine identity. The daemon never launches Cargo output. Missing assets produce a setup error, never automatic downloads. Source/fixture extraction uses CMake; incomplete extraction remains for inspection. No toolchain installation.

The build owner supplies `SHERPA_ONNX_LIB_DIR` to the official sys crate, copies runtime libraries beside normal and test executables, and sets executable-relative library lookup on macOS/Linux. Deploy those libraries with the executable, not the executable alone. A stock top-1-only library is rejected during startup.

`--test` executes pure alignment tests plus native fixture recognition, live competing paths, trailing-word drain and repeated stream disposal. Its independent, pinned LibriSpeech fixture archive is acquired only for tests and reuses the old model cache. It prints model load time, decode wall time, maximum chunk processing time and real-time factor. These are fixture measurements, not browser end-to-end latency or peak RAM.

For alignment-only work, without building native libraries:

````sh
cargo test --manifest-path daemon/voice/Cargo.toml --lib --locked
````

`--pin` bootstraps unpinned source and model identities. `--pin-model` records model file digests for an explicitly reviewed repository revision without changing the sherpa pin. Both refuse existing digests; neither is a normal build step. Dependency upgrades require reviewing versions, native patch and artifact identities.

## process protocol

Use the executable and model paths from `.workbench/native-voice/runtime.json`, setting `WORKBENCH_VOICE_MODEL_DIR` for direct invocation. Requests/events are newline-delimited JSON over stdin/stdout. Diagnostics use stderr.

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

The original browser enablement preference requires app schema release 13. Inline controls, native patch access and opt-in audio recording require user-owned frontend and `server:codex/def` reloads, including its dependent `server:voice` scope. Reload cancels active voice sessions. No new database migration or full-process restart is needed.

Replay a retained recording without the browser, live daemon or a paid transformer turn:

````sh
node scripts/replay-voice.mjs .workbench/voice-sessions/session-EXAMPLE/audio.wav
````

The command reads a finalised 16 kHz mono PCM16 WAV, starts the installed recogniser in isolation, prints every retained hypothesis/score and final inline alternatives, then exits. Metrics include model load time, decode time, first-text wall time and real-time factor. Replay feeds samples as fast as decoding permits: these are throughput measurements, not microphone-to-document latency or peak RAM. It writes no files, downloads nothing and sends no audio to the LLM. Compare the audible sample with the transcript before attributing poor recognition solely to the model.
