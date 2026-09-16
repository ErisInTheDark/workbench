# thread rendering checks

Use `/agent/thread-lab` on the running app origin. Configure fixtures through the UI, not source edits. No built-in scenario is required.

- **Thread JSON** accepts a full `ThreadPayload`, `{ thread }`, turn, item array, single item, or command shorthand. Canonical items retain supplied fields. Shorthand uses `cwd: "."`.
- **Canonical SQL projection** accepts `WorkbenchTranscriptProjection`, including `display.segments`, for generic items and reconstructed interactions. Keep segment items consistent with turn items. Its canonical grouping/status comes from JSON.
- **Rendering context** accepts renderer prop JSON. Supported keys are listed beside the editor. Use shared renderer types for nested values.
- **Apply updates** retains mounted identities, open disclosures, and scroll intent. Preserve thread/turn/item ids to exercise updates, completion, insertion and reordering.
- **Remount preview** clears text presentation and local interaction state. **Clear fixture** empties the data.
- Status radios override only the latest payload turn. Checkboxes control filtering and completed-turn presentation; defaults do not flatten or hide content.
- Width/height/font/palette controls configure presentation. Hide controls for larger previews. Pane width does not emulate mobile media queries; use browser device/viewport controls. Light/dark follows browser colour-scheme preference.
- **Streaming text** targets an existing in-progress item by turn/item/field/section. Open its disclosure first. Supply full new text; appended suffixes use the real paced text owner, replacements snap. Publish canonical JSON separately to finish the item.
- Invalid JSON preserves the last preview. A render failure stays inside the preview; correct the fixture and apply again.

`/agent/thread/<threadId>` reads captured SQL history with paging, live activity, and normal bottom-following. It does not send messages or accept proposals. Use the normal app for daemon-backed interactions.

For Browse, take a snapshot, fill the labelled editors, click **Apply updates**, then snapshot again. Use stable identities across updates. BrowseMD parses escapes, so JSON `\n` requires `\\n` in a quoted command argument.

Validation: `wb test -- app/client/components/workbench/thread-view/thread-render-lab-input.test.ts app/client/components/workbench/thread-view/thread-render-lab-options.test.ts`, then `pnpm typecheck`. Browser checks remain necessary for animation, scrolling, selection and layout.
