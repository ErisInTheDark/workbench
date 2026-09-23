# project identity and locations

## result

- One project entry per network remote across connected daemons. Path fallback for no remote. Existing project, home and pinned lists combine threads without daemon grouping.
- New drafts select daemon and concrete folder. Created threads remain bound and show daemon plus recorded cwd.
- Preserve multi-root workspaces, existing thread/subagent behaviour, provider configuration, accounts and permissions. No cross-daemon execution-state synchronisation.
- Auto-connect accessible peers through host-owned wake. Connected apps keep daemons awake. Respect stop, disabled wake, startup failure and grants.

## owners

- Daemon project UUID identifies one concrete checkout or workspace root set. Existing foreign keys, thread identity and recorded cwd remain daemon-bound.
- `identity_key` is non-unique matching metadata. Network remotes match across daemons; local paths and file remotes remain daemon-scoped. Linked worktrees share the common repository identity. Workspace matching uses member identities and preserves ordered roots.
- App logical-project UUID owns combined presentation. `{ daemonId, projectId }` addresses execution; a remote key never selects a cwd.
- App installation owns unsent drafts, attachments, target, per-location new-thread selection defaults, and project/home/pinned layout. Daemon owns created-thread lifecycle, profile definitions, execution configuration, transcript and provider state. Browser-private file, questionnaire and existing-thread composer drafts stay private and daemon-qualified.
- One browser session owner maintains one persistent socket per durable daemon ID. Existing socket owner handles reconnection. Host owns wake and access. Native network owner publishes actual browser-safe endpoints. No guessed HTTPS/port.

## slice 1: backing owners and compatible APIs

1. Admit independent clones and registered worktrees, including registered roots outside configured scan folders. Deduplicate canonical concrete locations, not remotes. Preserve IDs at the same location through remote changes. Never infer a move from equal remotes. Retain missing owners, aliases and icon fences; incomplete scans cannot erase ownership.
2. Expose `project/locations/read` with identity metadata. Keep `project/catalog/read` shape unchanged and return every concrete row. Do not choose an execution representative.
3. Add durable `thread/launch` and `thread/launch/read`. Persist captured target, selection, first input and message ID before provider dispatch. Distinguish prepared, creation dispatched, created, first input dispatched, accepted, definitely failed and unknown. Repeated launch ID returns the same operation; changed input rejects. Unknown is not a safe resend.
4. Carry internal resolved-location context through Codex/OpenCode creation and identity admission. Defer early Codex `thread/started` until native response correlation without blocking response handling. Persist native binding with launch ownership; later observations prefer retained binding. Agent ingress continues deriving ownership from validated cwd.
5. Publish negotiated endpoint descriptors at the existing non-waking identity URL. Native discovery forwards actual authorised endpoints. Host forwarding checks expected daemon ID. Never downgrade an HTTPS app.
6. Add shared `presentation-state.sqlite3` under app reload ownership. Relational data covers logical projects, locations, app drafts/attachment content, defaults, layouts, import receipts and draft-to-launch promotion. App HTTP admits typed app-local state only.
7. Export legacy daemon drafts in bounded pages, layout and inline assets in revision-fenced chunks. Import content and source mappings/receipts transactionally, then layout after member mapping. Preserve source data for old clients. No fallback overwrite or resurrected deleted/submitted drafts.
8. Map browser-private legacy registration to the verified attached daemon once; preserve already-qualified remote records.

Slice 1 includes daemon/app schema releases, network-native Windows binary plus manifest, source-owner tests and lifecycle migration fixture. Keep app UI on old contracts until slice 2.

## slice 2: existing-app cutover

1. Extract one daemon session from `WorkbenchClient`; keep one app coordinator, navigation and app lifetime. Move network subscription from settings to app lifetime. Auto-connect authorised peers; one failure cannot reset others.
2. Derive combined projects and source-qualified thread entries from sessions. App-owned layout drives existing lists. No replacement/grouping UI. Disconnected owners stay labelled and unavailable.
3. Move modern unsent draft writes to app owner. Initial target uses explicit route, saved target, then unambiguous attached/sole location; otherwise require choice. Retarget saves one complete location tuple, preserves content, detaches inapplicable linked profiles to Custom, and blocks unsupported destination configuration.
4. Reserve launch against draft revision, submit recorded intent, reconcile only original daemon. Acceptance promotes layout and marks draft complete transactionally. Failed promotion retries without resending. First-input uncertainty stays explicit.
5. Add qualified routes, back/forward, mosaic pane targets and panel-scoped daemon contexts. Legacy location links resolve only against verified attached daemon.
6. Source-qualify file/edit state, icons, transcript assets, git/checkpoint actions, questionnaire replies, settings and search. Search deduplicates projects, retains thread owner, scopes file results to selected location and exposes partial failures. Statistics remain daemon-scoped with explicit selection.
7. Use existing project/home/pinned/mosaic/subagent surfaces, flush/zen styling, both themes and deliberate mobile layout. Preserve subagent lifecycle; no cross-daemon subagent feature.

## failure rules

- A missing location is not a deleted thread. A changed remote changes display membership, not thread/configuration ownership.
- Explicit target reselect is a no-op. Closing/reopening a picker cannot commit an incomplete daemon/folder tuple. Leaving before async completion fences old preview, voice, profile, search and file results.
- App draft revisions prevent two tabs silently overwriting or launching the same revision twice.
- Old daemon snapshots are import sources, never a live modern draft/layout owner. Import receipts stop resurrection. Source divergence is visible, not synchronised.
- Socket loss after dispatch never causes blind recreate or resend. Unknowable provider outcomes remain unknown.
- Revoked peer access retires live session data. Other sessions remain active.

## checks and reload

- Run new semantic owner assertions red first. Validate with `wb test`, focused `wb test -- <files>`, `pnpm typecheck`, `pnpm test:network`, `pnpm build:network`, and final `pnpm test:lifecycle`. Lifecycle checks clone the real database and replace a host-owned daemon process before app/cold-reopen checks. No paid provider turn or browser automation.
- Slice 1 needs a user-owned full daemon-process restart for startup phase logging and database reload, plus `client:database` and `host:network` reloads with dependant closures, including the rebuilt native network process. Slice 2 also needs the updated frontend loaded.
- Completion requires both slices and changed-set review. Slice 1 alone does not satisfy the user-visible request.
