# daemon provider APIs

Browser code uses WB actions on its existing `WorkbenchSocketClient`. No native handshake, provider packets or provider selection for existing threads:

````ts
await daemon.threads.message({ threadId, input, clientMessageId, intent: "continue" });
await daemon.threads.page({ threadId, cursor: null });
````

`WorkbenchThreadActionController` resolves WB identity and creation profiles. `continue` preserves start-versus-steer admission; explicit `steer` requires its expected turn and never starts another. Fresh creation precedes first submission. Stop/snooze and questionnaire settlement remain shared policy.

Get an installed provider handle. Saved handles remain valid across scoped reloads.

````ts
const provider = providers.get("codex");
const capabilities = await provider.configuration.modelContext.read();
````

`get` accepts installed provider keys, not arbitrary external input. A handle stores routing and identity, never an implementation instance. Each method enters `ReloadableNodeHost.run`, leases the current definition and its dependencies, and propagates its result or failure. Reload gates belong to the graph host.

Construct the dispatcher from the shared node-build operation port, not process context:

````ts
create: (context, { run }) => {
  const providers = new WorkbenchProviderDispatcher(run);
  // Inject into the consumer. Do not run operations during construction.
}
````

Both daemon and app-server graphs expose this generic port. Construction `get` remains direct-parent-only; `run` invokes operations without retaining cross-branch implementation instances.

## add a capability

1. Add Workbench inputs/results to `WorkbenchProvider.ts`. Keep native types inside provider implementations.
2. Add explicit forwarding in `WorkbenchProviderHandle.ts`. Await the complete operation through the injected graph entry.
3. Bind each installed provider in its definition node. Add implementation nodes at their real dependency owner.
4. Use the handle from daemon consumers. Do not retain raw graph registrations.
5. Test replacement, operation failure and any cancellation/lifecycle behaviour at the owning boundary.

`shared/workbench/provider/provider-registrations.ts` maps installed keys to definition registrations. It is composition metadata, not runtime availability state. Only Codex is installed.

Stored keys use `provider-key.ts`, independently of installed definitions. Daemon `workbench_harnesses` and its app-local equivalent retain provider identity through foreign keys. Uninstalling an implementation never deletes its rows, profiles or favourites. Dependent writes admit provider keys in their own transaction. A stored row grants no execution capability; unavailable-provider operations fail locally without dispatching or replacing their identity with Codex.

Codex's definition has direct configuration and bridge parents. Configuration owns local model context and global guidance. The bridge supplies native model/account operations and `CodexThreadOperations`. Native operations share the bridge's initialisation gate; local reads do not initialise Codex.

Thread operations translate WB identities, inputs and results. Existing admission retains unsubscribe/resume, instruction/profile/MCP preparation, then start. SQL paging/recording and subscriptions keep their owners. Historical materialisation groups native executions at the edge, not in WebSocket ingress.

Provider callbacks already inside admitted work use that owner's translated WB descriptors. Do not reacquire a provider handle from profile/MCP callbacks while the admitted owner is draining.

The app and daemon adopt these actions together. Native browser forwarding and `/daemon/bridge-request` are removed. Unknown socket requests fail individually; provider replacement never closes the shared WB socket.

`server:codex/lifecycle` supervises its `harness:codex` child, surviving the restart it requests. The bridge owns native readiness, health probes, ingress and admitted reply drain. Retired probes cannot request recovery. Failed lifecycle replacement resumes the previous supervisor.

The bridge translates native events into WB observations. Shared core settles those observations and returns WB lifecycle state; Codex decides native continuation afterwards. This work drains with the bridge's existing persistence work, without reacquiring a provider-definition lease.

Transcript assets remain SQLite-owned and readable without a running provider. New URLs use `/api/transcript-assets/<wb-thread-id>/<asset>`; retained Codex-shaped URLs and stored aliases remain readable. No schema change or asset rewrite is required.

## stateful operations

`thread/provider/delete` (`daemon.threads.deleteProvider`) deletes one backing provider session through optional `threads.delete`. WB identity, state, drafts and SQL history remain. Multiple bindings require explicit selection before deletion; this API does not guess or purge WB data.

An operation lease is not a session lifecycle. An implementation owns sessions, subscriptions, cancellation and reload handoff. Native replies for admitted work stay with that owner.

A future streaming operation can accept a caller signal and typed update callback:

````ts
await provider.transform.run({ input, signal, onUpdate });
````

This is an extension example, not an implemented capability. Its promise must cover the operation, including cleanup. If a session survives that promise, its implementation node must own its disposal/handoff. Never expose native sessions or capture a definition in a returned object.

Atomic nodes can keep serving their old definition while a candidate starts. Calls wait at the graph's activation gate. Existing operations retain their old owner until settlement. Resource-transfer nodes use the graph's explicit handoff lifecycle.

During a shared drain, nested work may continue against the old batch while an ancestor operation still holds its lease. New/unrelated work waits. Settled async contexts grant no access, and continuation closes before detachment. Await child operations; lifecycle hooks must not start graph operations or wait on their own reload.
