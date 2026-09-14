# daemon provider APIs

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

`provider-registrations.ts` maps installed keys to definition registrations. It is composition metadata, not runtime availability state.

Codex configuration owns the local model catalog. Its definition depends directly on configuration, not harness readiness. Native runtime APIs may instead need a `harness:<provider>` parent.

## stateful operations

An operation lease is not a session lifecycle. An implementation owns sessions, subscriptions, cancellation and reload handoff. Native replies for admitted work stay with that owner.

A future streaming operation can accept a caller signal and typed update callback:

````ts
await provider.transform.run({ input, signal, onUpdate });
````

This is an extension example, not an implemented capability. Its promise must cover the operation, including cleanup. If a session survives that promise, its implementation node must own its disposal/handoff. Never expose native sessions or capture a definition in a returned object.

Atomic nodes can keep serving their old definition while a candidate starts. Calls wait at the graph's activation gate. Existing operations retain their old owner until settlement. Resource-transfer nodes use the graph's explicit handoff lifecycle.

During a shared drain, nested work may continue against the old batch while an ancestor operation still holds its lease. New/unrelated work waits. Settled async contexts grant no access, and continuation closes before detachment. Await child operations; lifecycle hooks must not start graph operations or wait on their own reload.
