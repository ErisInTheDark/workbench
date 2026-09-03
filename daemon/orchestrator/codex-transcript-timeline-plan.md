# Codex Transcript Timeline Plan

## Problem

The current transcript persistence work has two coupled regressions:

- Thread reads became slow when persistence and recovery logic moved into the `thread/read` hot path.
- Extended history items such as subagents, command executions, file changes, MCP calls, and dynamic tool calls are either missing after refresh or appear out of order.

The ordering failure comes from treating stored-only items as an append-only fallback during hydration. That loses their narrative position. The better ordering source is the saved event order, but raw NDJSON replay must not happen while opening a thread.

## Target Architecture

Use three separate paths with different latency budgets:

1. Streaming path: app-server message -> bridge -> browser immediately.
2. Transcript write path: ordered asynchronous writes to compact JSON sidecars plus raw NDJSON audit journals.
3. Read hydration path: `thread/read` and `thread/resume` merge compact JSON sidecars into the app-server snapshot before returning, without replaying NDJSON.

## Timeline Model

Add compact per-turn ordering metadata to `CodexTranscriptTurnFile`:

```ts
interface CodexTranscriptTurnTimelineEntry {
  itemId: string;
  anchorItemId: string | null;
  sequence: number;
}

interface CodexTranscriptTurnFile {
  itemTimeline: CodexTranscriptTurnTimelineEntry[];
}
```

Keep `itemOrder` as a legacy compatibility field for already-written files, but new ordering uses `itemTimeline`.

Legacy conversion rule:

- When reading a turn file with no `itemTimeline`, synthesize `itemTimeline` from `itemOrder`.
- When reading a turn file with a partial `itemTimeline`, synthesize entries only for `itemOrder` ids missing from `itemTimeline`; never rewrite existing timeline entries.
- Each synthesized entry uses `anchorItemId: itemId` if the item is an anchor, otherwise the most recent previous anchor from the normalized combined timeline/order view.
- Synthesized `sequence` values are 1-based positions from `itemOrder`.
- For partial timelines, synthesized entries must allocate after `max(existingTimeline.sequence)`, in `itemOrder` order, so they never collide with existing sequences.
- The normalized combined timeline/order view is built from existing `itemTimeline` entries plus missing `itemOrder` entries in `itemOrder` position order. Anchor lookup for synthesized entries must consider existing timeline anchors as well as newly synthesized anchors.
- If `itemOrder` references an id not present in `turn.items`, do not create an emitted timeline entry for that missing item. Missing ids may still contribute ordering position while synthesizing later known items, but only known items can be emitted.
- This can be done lazily in `normalizeTurnFile(...)`; no migration is required for this pass.

## Anchors

Anchor items are the narrative text/keyframe items:

- `userMessage`
- `hookPrompt`
- `agentMessage`
- `reasoning`
- `plan`

Non-anchor items are positioned after the most recent anchor observed in the same turn:

- `commandExecution`
- `fileChange`
- `mcpToolCall`
- `dynamicToolCall`
- `collabAgentToolCall`
- `webSearch`
- `imageView`
- `imageGeneration`
- `enteredReviewMode`
- `exitedReviewMode`
- `contextCompaction`

When an anchor item is first observed, its timeline entry has `anchorItemId` equal to its own `itemId`. Later non-anchor items use that anchor id. If no anchor has been observed yet, `anchorItemId` is `null`.

The first observed `sequence` for an item is stable and must not be rewritten by later deltas, completion events, or thread snapshots.

## Write Path Changes

### Helper Modules

Split pure helpers out of the store before implementation:

- `webapp/orchestrator/codex-transcript-timeline.ts`
  - timeline entry types
  - anchor classification
  - item key extraction
  - legacy `itemOrder` -> `itemTimeline` normalization
  - `orderMergedItemsByTimeline(...)`
- `webapp/orchestrator/codex-transcript-item-merge.ts`
  - `mergeThreadItem(...)`
  - generated status precedence helpers
  - richer field preservation
- `webapp/orchestrator/codex-transcript-event-routing.ts`
  - raw response journal destination decisions
  - thread snapshot vs request journal routing helpers
  - method-level event classification for timeline allocation

### `webapp/orchestrator/CodexTranscriptStore.ts`

Every transcript event that identifies a `threadId`, `turnId`, and item key updates the target turn file's `itemTimeline` before or together with updating the item body. The item key is extracted from `params.item.id`, `params.itemId`, or method-specific fields such as `params.callId`.

Sequence allocation is file-local, not process-local:

```ts
function nextTurnTimelineSequence(file: CodexTranscriptTurnFile) {
  return Math.max(0, ...normalizeTurnTimeline(file).map((entry) => entry.sequence)) + 1;
}
```

This avoids collisions after orchestrator reloads or restarts.

Rules:

- If an item already has a timeline entry, keep its original `anchorItemId` and `sequence`.
- If a new item is an anchor, add `{ itemId, anchorItemId: itemId, sequence }`.
- If a new item is not an anchor, add `{ itemId, anchorItemId: latestAnchorItemId, sequence }`.
- On full app-server thread/turn snapshots, add missing snapshot items in snapshot order, but never move existing timeline entries.
- Do not append full `thread/read` or `thread/resume` response payloads to every turn journal.
- Do not call raw NDJSON replay during `thread/read`.

Item classification:

- `item/started` and `item/completed` classify from `params.item.type`.
- `item/agentMessage/delta` and `item/plan/delta` are anchors.
- `item/reasoning/summaryPartAdded`, `item/reasoning/summaryTextDelta`, and `item/reasoning/textDelta` are anchors.
- `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`, and `item/mcpToolCall/progress` are non-anchors.
- `item/tool/call` server requests are non-anchor dynamic-tool timeline entries keyed by `params.callId`, not `params.itemId`.
  - If no compact `dynamicToolCall` item exists yet, create this minimal in-progress item from `DynamicToolCallParams`:
    ```ts
    {
      id: params.callId,
      type: "dynamicToolCall",
      namespace: params.namespace ?? null,
      tool: params.tool,
      arguments: params.arguments,
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
    }
    ```
  - Later `item/started` or `item/completed` events with the same id merge into that compact item.
- Unknown item-id-only events do not allocate timeline entries until a later event provides either a full item type or a known method classifier.

## Hydration Changes

### `webapp/orchestrator/codex-transcript-hydration.ts`

Hydration should:

1. Merge same-id items using a richer item merge.
2. Order merged items using `itemTimeline`.
3. Keep source order only for items that have no timeline entry.

Change the hydration API from:

```ts
hydrateThreadWithStoredTurns(thread: Thread, storedTurns: Turn[])
```

to:

```ts
interface StoredTurnWithTimeline {
  itemTimeline: CodexTranscriptTurnTimelineEntry[];
  turn: Turn;
}

hydrateThreadWithStoredTurns(thread: Thread, storedTurns: StoredTurnWithTimeline[])
```

`CodexTranscriptStore.readTurnFiles(...)` must pass the whole normalized sidecar shape, not just `file.turn`, so hydration does not lose ordering metadata.

Ordering algorithm:

1. Build `itemsById` from merged upstream and stored items.
2. Sort timeline entries by `sequence`.
3. Emit anchor groups in timeline order:
   - anchor item
   - non-anchor items whose `anchorItemId` equals that anchor, sorted by `sequence`
4. Emit `anchorItemId: null` items in sequence order before the first anchor group.
5. If a timeline item points to an anchor that is absent or was deduped, still emit that item in a final remaining-timeline pass sorted by `sequence`.
6. Emit items with no timeline entry at the end in original source order, and treat this as a fallback path to minimize.

Exactly-once rule:

- Track emitted item ids.
- Every item in `itemsById` must be emitted at most once.
- Every timeline entry whose item exists in `itemsById` must be emitted at least once, even when its anchor is missing.

This means command/tool/subagent items are placed after the nearest saved text/reasoning/plan anchor they originally followed, instead of clustering at the end.

## Richer Item Merge

Use a type-aware merge for same-id items in both store updates and hydration.

Status merge rule:

- Preserve data fields field-by-field.
- Prefer any terminal/non-`inProgress` status over `inProgress`.
- If both sides are terminal and conflict, use deterministic status precedence instead of event recency:
  - for command/file statuses, use `failed > declined > completed > inProgress`
  - generated `completed` outranks `inProgress`
  - for MCP, dynamic-tool, and collab-agent items, use only `failed > completed > inProgress`
  - unknown statuses fall back to the incoming app-server value
- Preserve stored terminal-only data fields even when incoming status wins.

Required preservation:

- `collabAgentToolCall`: preserve non-empty `receiverThreadIds`, `agentsStates`, `prompt`, `model`, `reasoningEffort`, `senderThreadId`, and more terminal `status`.
- `commandExecution`: preserve non-empty `aggregatedOutput`, `exitCode`, `durationMs`, `commandActions`, and more terminal `status`.
- `fileChange`: preserve non-empty `changes` and more terminal `status`.
- `mcpToolCall`: preserve non-null `result`, `error`, `durationMs`, and more terminal `status`.
- `dynamicToolCall`: preserve non-null `contentItems`, `success`, `durationMs`, and more terminal `status`.
- Text items: preserve the longer compatible text/summary/content when one side is obviously richer.

## Bridge Changes

### `webapp/orchestrator/CodexStdioBridge.ts`

Restore successful hydration:

- Call `transcriptStore.hydrateThreadResponse(pending.upstreamRequest, message)` for successful `thread/read`, `thread/resume`, `thread/start`, and `thread/fork`.
- Error fallback is only allowed for errored `thread/read` with a known `threadId`.
- Keep hydration errors non-fatal and logged.
- Keep raw transcript writes asynchronous and ordered through `transcriptQueue`.
- Preserve audit semantics:
  - `recordUpstreamResponse(...)` records the raw upstream response to NDJSON.
  - Raw full `thread/read`, `thread/resume`, `thread/start`, and `thread/fork` responses must go to the request journal keyed by JSON-RPC request id, never to every turn journal.
  - Add a separate compact-sidecar method such as `recordHydratedThreadSnapshot(...)` for the hydrated/richer response.
  - Use that method to update compact sidecars without pretending the hydrated response was raw upstream traffic.

## Client Equality Changes

### `webapp/lib/workbench/WorkbenchThreadClient.ts`
### `webapp/lib/WorkbenchClient.ts`

Replace item-id-only equivalence with cheap rendering signatures from one shared helper:

```ts
webapp/lib/workbench/thread/thread-item-signature.ts
```

The helper should export:

- `getThreadItemRenderSignature(item: ThreadItem): string`
- `getTurnRenderSignature(turn: Turn): string`

Use `getTurnRenderSignature(...)` in both `WorkbenchThreadClient.ts` and `WorkbenchClient.ts`.

The turn signature must include:

- `id`
- `status`
- `itemsView`
- `startedAt`
- `completedAt`
- `durationMs`
- error presence/message/code if rendered
- item id order
- every item render signature

The signature must include every field rendered by the item component, by item type. Implement this as a bounded render-projection hash per item type rather than a generic full-object stringify.

Minimum render projections:

- common: `id`, `type`
- `agentMessage`: `text.length`, `phase`, `memoryCitation`
- `reasoning`: summary/content segment counts and text lengths/hashes
- `plan`: `text.length`
- `userMessage`: bounded hash of rendered content
- `hookPrompt`: bounded hash of rendered fragments
- `commandExecution`: `command`, `cwd`, `status`, `aggregatedOutput.length/hash`, `exitCode`, `durationMs`, rendered command action content hash
- `fileChange`: `status`, `changes.length/hash`
- `mcpToolCall`: `server`, `tool`, `status`, bounded hash of `arguments`, `result`, and `error`, `durationMs`
- `dynamicToolCall`: `namespace`, `tool`, bounded hash of `arguments` and `contentItems`, `status`, `success`, `durationMs`
- `collabAgentToolCall`: `tool`, `status`, `senderThreadId`, `receiverThreadIds.join(",")`, `prompt.length/hash`, `model`, `reasoningEffort`, `agentsStates` keys/statuses
- `webSearch`: `query`, `action`
- `imageView`: `path`
- `imageGeneration`: `status`, `revisedPrompt`, `result`, `savedPath`
- `enteredReviewMode`/`exitedReviewMode`: `review`
- `contextCompaction`: `id`

This ensures restored subagent IDs, command output, statuses, and order changes actually re-render.

Signature cost bound:

- Do not deep `JSON.stringify` arbitrary result/error payloads on every comparison.
- Use a shared helper with a `WeakMap<ThreadItem, string>` cache.
- For unknown object payloads, include presence plus a bounded stable hash from a capped traversal/stringifier. Equal length alone is not sufficient.

## Explicit Non-Goals For This Pass

- Do not add raw NDJSON replay to thread open.
- Do not migrate old questionnaire files unless separately approved.
- Do not add all missing delta reducers yet. First restore hydrated compact sidecars; add reducers only if completed snapshots do not cover a specific visible case.
- Do not block streaming notifications on disk writes.

## Verification

Run:

```powershell
pnpm typecheck
git diff --check
```

Targeted checks:

- Successful `thread/read` and `thread/resume` responses call hydration.
- Successful `thread/start` and `thread/fork` responses call hydration.
- Thread open does not read raw `.ndjson` journals.
- Full `thread/read` snapshots are not appended to every turn journal.
- Full `thread/read`, `thread/resume`, `thread/start`, and `thread/fork` raw responses route to request journals.
- `collabAgentToolCall.receiverThreadIds` survives a thin successful read.
- `commandExecution` with stored output survives a thin successful read.
- Ordering follows `itemTimeline` groups rather than append-at-end behavior.

Add a manual fixture checklist backed by typechecked fixture data, because this workflow allows `pnpm typecheck` but not arbitrary test scripts:

- Put helper fixtures in `webapp/orchestrator/codex-transcript-timeline-fixtures.ts`.
- Export no runtime production API from the fixture file; it should import the pure helpers and use typed `const` cases that fail TypeScript if helper return shapes drift.
- Keep behavioral expected outputs as manual checklist comments next to each fixture until a test runner is approved.
- Do not claim these are executable tests in this pass.

Manual fixture checklist cases must cover:

- restart-safe sequence allocation from existing sidecar timeline
- `itemOrder` legacy fallback to synthesized `itemTimeline`
- raw upstream response recording kept separate from hydrated compact-sidecar recording
- errored fallback only for `thread/read`
- field-wise merge for `commandExecution`, `collabAgentToolCall`, `mcpToolCall`, and `dynamicToolCall`
- timeline ordering: command/tool items between two anchor messages stay between those anchors after hydration
- delta-before-full-item classification
- partial `itemTimeline` plus legacy `itemOrder` fill
- missing/deduped anchor fallback emits anchored children exactly once
- raw full-response journal destination is request-scoped, not turn-scoped
- `item/tool/call` `callId` dynamic-tool timeline allocation
- generated status precedence: `failed`/`declined > completed > inProgress`
- bounded stable hash signatures catching equal-length result/error changes
