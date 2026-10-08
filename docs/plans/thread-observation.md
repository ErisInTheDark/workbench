# Thread feed: one store, two daemon channels

Status: approved by user. Direct replacement, hooks all the way, in two passes; work through fallout without pre-mapping. Workflow: /auto with /browse validation, iterative; user owns reloads.

## Passes
- Pass 1 (additive): daemon/app support (done) + browser `ThreadStore`, `useThread` hooks and the new thread view wired to them, behind a switch so the old document UI keeps working (user keeps chatting in the old UI). Daemon keeps old feeds (page reads, side reads, provider notifications, auto-compact broadcast).
- Pass 2: delete old feeds and the old UI path: browser page reads, side `*/read`, notification merge, documents / `WorkbenchThreadController` pipeline, `subagentBackground`, auto-compact broadcast; `wantsProviderEvent` thread-less only; switch removed.
- Proof per pass: claimed `wb test`, `pnpm typecheck`, `pnpm test:thread --codex=fake` (plus other fake providers); browse open / reopen / older turns / send / steer / questionnaire / approval / subagent board on the new view.
- Pass 1 switch shape: consumers move once, to `useThread` hooks over a `ThreadStore` slice contract. The store has two sources: `legacy` (adapts today's `WorkbenchThreadController` snapshot and actions) and `observed` (new channels: thread observation entry + runtime, transcript projection by `turnLimit`, store-local optimistic overlay, id-based actions). The switch picks the source (app preference / URL flag); default `legacy` until browse validation passes. Pass 2 deletes `legacy` and everything only it used.

Goal: each browser thread consumer reads `useThread(id)` / slice hooks over one `ThreadStore`. Browser page reads, side-history reads, thread-scoped provider notifications and the document pipeline are deleted. Turn content ships once.

## Daemon

### `thread` workspace observation (everything *about* a family's threads)
- Keep entries as today.
- Add keyed `runtime` per thread: `tokenUsage`, `contextUsage`, `willAutoCompact`, live `status`, resolved `settings` (model, reasoningEffort, serviceTier, agentPath).
- Observation owner recomputes `runtime` when provider observations land for a family thread (today scraped by browsers from provider notifications and `thread/metadata/read`).
- Keyed deltas, both hops; shapes in `shared/workbench/workspace/workspace-observation.ts`.

### Transcript subscription (everything *in* a thread)
- Window requested as `{ turnLimit }`; load-older raises `turnLimit`. Browser never picks turn ids from page reads.
- Stream adds side entries beside `browseResultEntries`: `steerEntries`, `questionnaireEntries`, `approvalEntries`, computed by the `content(snapshot)` path `WorkbenchTranscriptReader.history` uses; published with structure updates when changed.
- Text/toolPatch streaming unchanged (thread-view-parity leaf-update invariant).

### Provider events
- `wantsProviderEvent` forwards only thread-less events (account, models). Thread-scoped events stop reaching browsers.

## Browser

`ThreadStore` per thread replaces `WorkbenchThreadController` and the document pipeline.

```ts
const thread = useThread(threadId);        // entry, runtime, window, actions, status
const turns = useThread.turns(threadId);   // projected turns + optimistic overlay
const steers = useThread.steers(threadId);
const questionnaires = useThread.questionnaires(threadId); // history + pending
const approvals = useThread.approvals(threadId);
const browse = useThread.browse(threadId);
thread.actions.send(input, options);       // id-based, no ThreadPayload
thread.actions.loadOlder();                // raises turnLimit
```

- Holds one shared `thread` observation per family and one transcript subscription per thread; slice hooks subscribe only their slice.
- Optimistic overlay (pending initial input, pending steers) is store state over `turns`, confirmed by projected items' `clientUserMessageId` (moves projection controller `localInitials`/`localSteers` logic into the store).
- Drafts: store without daemon channels, overlay only, until first send binds the real thread id.
- Subagent boards use child stores (`useThread.turns(childId)`).
- Entry motion seeds from the `turns` slice the first time it is ready (today `ThreadViewContent` seeds from document item ids).

## Implementation notes (from inspection)
- Side entries already derive from the transcript snapshot: `WorkbenchTranscriptReader.content()` builds `questionnaireEntries` (projected items with `requestKey`), `steerEntries` (`generic` items with `nativeType: "workbenchSteer"`, steer-kind `threadItemUserMessages`, plus `rows.threadHeldSteers`/`threadHeldSteerParts`) and `browseResultEntries` (projection). Move that derivation into shared transcript projection code so the daemon reader and the browser store share it; the browser derives side entries from the stream snapshot it already receives.
- Approval outcomes are not in the snapshot: `database.readApprovalOutcomes(threadId, turnIds)` (approval store). Add them to the transcript subscription read (`WorkbenchTranscriptSubscriptionController` read port) and settle subscriptions when an outcome is recorded.
- Subscription window today: browser passes `turnIds` from document turns (`ThreadTranscriptProjectionController.select` → `durableTurnIds`). Switch the request to `turnLimit` only; live controller (`WorkbenchTranscriptLiveController`) already handles latest-window settlements.
- Live stream: `WorkbenchTranscriptSubscriptionController` + `WorkbenchTranscriptLiveController`; browser side `WorkbenchTranscriptClient` → `ThreadTranscriptProjectionController` (keeps text/toolPatch leaf updates; its `localInitials`/`localSteers` overlay moves into the store).
- Projection shape (`shared/workbench/transcript/workbench-transcript-projection.ts` `WorkbenchTranscriptProjection`) gains `steerEntries`, `questionnaireEntries`, `approvalEntries` beside `browseResultEntries`; `projectWorkbenchTranscript` derives them from rows; `applyTranscriptStructure` (`thread-transcript-stream.ts`) merges them by key like browse entries (drop entries whose item was touched/removed, then add incoming). Approval outcomes enter the snapshot as an extra rows-like field supplied by the subscription read.

- Live settlements (`WorkbenchTranscriptLiveController.#settleView`) publish partial snapshots: only changed `threadItems`/turns. Merge rule for side entries: entries derived from items replace by item id when that item is touched or removed; held steers replace by `entryKey` when their rows appear, `dismissed` removes. Held-steer writes do not settle transcript subscriptions today (browsers learn via `steer/history/changed`): make held-steer mutations settle the thread with the changed steer rows. Same for approval outcome records.

## Work checklist
1. DONE shared projection: side entries in `WorkbenchTranscriptProjection` (`shared/workbench/transcript/transcript-side-entries.ts`) + structure merge; daemon reader `content()` reuses it
2. daemon: approval outcomes into subscription snapshot + settle on record; subscription request by `turnLimit`
   - DONE held steers: `WorkbenchTranscriptRepository.settle` tracks `heldSteerTurnIds` (hold, interrupt) and ships those turns' held-steer rows in live changes; delivery deletion adds the held public id to `removedItems`. Questionnaires are items, already in settlements
   - DONE approvals: snapshot `approvalOutcomes` (repository read; contract conformed; `emptyTranscriptSnapshotRows`), projection `approvalEntries` merged by item id, `WorkbenchTranscriptLiveController.acceptApprovalOutcome` publishes on core `recordOutcome`
   - TODO window: browser requests `{ turnLimit }` only (client change in step 4)
   - (old note) approval outcomes live in the same SQLite DB (`WorkbenchApprovalOutcomeRepository`, worker `recordApprovalOutcome`/`readApprovalOutcomes`): add `approvalOutcomes` to `WorkbenchTranscriptSnapshot` (worker `readTranscript` reads them for loaded turns), project them as `approvalEntries`, and after `recordApprovalOutcome` publish a live structure update for that thread carrying just the new outcome (merge by item id)
3. daemon: `thread` observation `runtime` per thread; `wantsProviderEvent` thread-less only
   - DONE runtime: `ThreadRuntimeSchema` + `runtime` record on daemon/app `thread` observations (record shape), core `threadRuntime` registration (autoCompact `publish` pushes values instead of broadcasting; transcript `subscribeSettled` triggers token-usage reread), observation controller `familyRuntime`/`runtimeChanged`
   - TODO with step 5: `wantsProviderEvent` thread-less only (browser still uses notifications until the store lands)
   - status and settings already ride the entry (`lifecycle`, `profile.settings`); `runtime` = `{ tokenUsage, willAutoCompact }` keyed by thread id, as a sibling of `data` on daemon and app `thread` observations
   - core registers `threadRuntime`: `read(threadId, harness)` (transcript `readContextUsage` + `autoCompact.observe`) and `subscribe(listener)` fed by autoCompact `publish` (replace its browser broadcast) and transcript `subscribeSettled` (token usage commits)
   - observation controller reads runtime for family entries in `readThread`, re-reads `tokenUsage` on settled family threads, applies autoCompact changes directly
4. browser: `ThreadStore` + `useThread` hooks; overlay from projection controller; drafts; child stores
   - `app/client/workbench/thread/ThreadStore.ts` (default class): per thread target; holds a `ThreadObservationController` lease (entry + runtime, family-shared) and a `ThreadTranscriptProjectionController` (turns, window, side entries); `select` no longer takes a document: subscribe with `turnLimit` and the thread id; optimistic overlay state (pending initial input / steers keyed by `clientUserMessageId`) lives in the store and is applied over projected turns; `loadOlder()` raises `turnLimit`
   - slices: `summary` (entry, runtime, status), `turns` (projection turns + overlay + window/hasPrevious), `steers`, `questionnaires` (history + pending from entry), `approvals`, `browse`; `getSnapshot(slice)` / `subscribe(slice, listener)` with identity-stable slice values
   - actions (id-based): send, steer resend/dismiss, stop, compact, stopShell, questionnaire submit/snooze, settings changes; reuse the daemon client calls `WorkbenchThreadClient` makes today, minus document mutation
   - `app/client/components/workbench/use-thread.ts`: `useThread(id)` + `useThread.turns/steers/questionnaires/approvals/browse` over a client-owned store registry (replaces `useWorkbenchThread` / `getThreadController`)
   - entry motion seeds from the `turns` slice when first ready
   - `ThreadTranscriptProjectionController.select` today takes `{ thread: ThreadPayload }` and derives: window (`durableTurnIds(thread.turns)` → subscription `turnIds`), `localInitials` (undelivered optimistic user messages + `readOptimisticInitials`), `localSteers` (synthetic steer user messages), `liveItemTimelines` (document `turnHistory` timing overlay), locally projected pending turns (`connecting`/`providerPending` admission). Replace the selection with `{ threadId, turnLimit, initials, steers }` supplied by the store; window comes from `turnLimit`; drop the document timeline overlay (stream settlements carry `itemTimeline`) and note any live-duration regression found during the live check
5. cut consumers, delete document pipeline and browser page/side reads
6. typecheck, `wb test`, fake thread scenarios, live check

## Progress log
- DONE projection controller: `ThreadTranscriptProjectionSelection.turnLimit`; subscription omits `turnIds` when the selection names no durable turns (daemon latest window), and a `turnLimit` change resubscribes
- DONE pass 1 browser: `ThreadStore` (slices `summary`/`turns`/`questionnaire`/`approvals`; `createThreadTurnsSlice` derives provider-item turns once per projection), `LegacyThreadSource` (mirrors `WorkbenchThreadController`), `ObservedThreadSource` (family observation entry + `runtime`, transcript by `turnLimit`, overlay keyed by client message id, id-based actions), registry `getThreadStore` (feed from `readThreadFeed`: `?threadFeed=observed|legacy`, remembered in localStorage; drafts always legacy), hooks `use-thread.ts`; every `useWorkbenchThread` consumer moved, hook deleted; `ThreadGitArcProposalObserver` extracted from the controller; projection `thread.cwd`; browser observation snapshot carries `runtime`
- Pass-1 bridges deleted in pass 2: `ThreadSummarySlice.legacyDocument` (legacy send + panel title), `ThreadStoreSource.legacyOwner` (child hydration, history retention)
- KNOWN GAPS (observed feed): approval prompts are broadcast-only (`WorkbenchApprovalController.show`, not durable on the entry) so observed views do not see them; needs `runtime.pendingApproval` (or durable approval questionnaire) before pass 2 drops provider notifications. Thread `systemError` status has no entry equivalent (error card legacy-only). Older-turn paging resubscribes the whole window (resends loaded turns); consider an incremental `beforeTurnIndex` page. Drafts stay legacy until draft binding moves into the store.
- NEXT: user reloads; browse-validate `?threadFeed=observed` (open/reopen/older/send/steer/questionnaire/subagent board); fix findings; then pass 2
- Claim rule: claim each file in its own call before editing it (hook rejects unclaimed edits; folder claims are forbidden, they lock hundreds of files)

## Deleted in the same change
- Browser use of `thread/page/read`, `thread/{steers,questionnaires,browse,approvals}/read`, `thread/metadata/read` (daemon methods remain only for non-browser callers such as scenarios).
- Document pipeline: `WorkbenchThreadClient` documents, `threadSources`, side state maps, notification merge, `ThreadDocumentController`, `ThreadDocumentStore`, `ThreadSourceStore`, canonical/visible/overlay layers, `ThreadRenderPipeline`, `ThreadHistoryRetentionController`, `subagentBackground`, `ThreadPayload`-taking action signatures.

## Fallout
Consumers move to hooks as encountered: composer, context status, goal control, agent tabs, error card, render surfaces, workspace layout, composer profiles, message board, render lab, standalone transcript view. Mostly prop deletion.

## Proof
Claimed `wb test`, `pnpm typecheck`, `pnpm test:thread --codex=fake` (plus other fake providers); live open / reopen / older turns / send / steer / questionnaire / approval / subagent board; `wb debug socket` shows one copy of turn content and no thread-scoped provider events reaching tabs.

## Reload
All three hops change: daemon (`server:core` + `server:websocket`, or full restart), app (`client:workspace` + `client:http`), every tab refreshed. Confirm exact set when built.
