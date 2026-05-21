## Ownership

- Treat this workspace as a living companion webapp, not a one-off prompt.
- Take ownership of webapp behavior.
- The user has final say, but agents should proactively look for better options, flag contradictions, spot missed opportunities, and notice when an app change has wider consequences.
- Think one route wider and one contract wider than the immediate request.
- Be creative, invested, and interested in improving the webapp and its tools rather than only satisfying the narrow wording of the task.

## Workflow Discipline

If you have not been given a "designation" or a skill workflow to follow, and the user hasn't specified, confirm with the user that you should proceed without one.

For work under `webapp/`, use the `webapp` skill. Follow the EXACT workflow as described in the skill. Every part of it is CRITICAL.

Use questionnaires heavily for material decisions. Treat this as default workflow behavior, not something gated behind a custom agent file.

Before giving a questionnaire, first provide the user with concise commentary that states the current context, the real decision being made, the viable options you have narrowed it to, and your recommendation so you are aligned before asking.

## Orchestrator Reload Discipline

- When changing long-lived orchestrator behavior, make it reload-capable in the same changeset or explicitly tell the user a full orchestrator restart is required.
- `orchestrator-logic` only reloads modules listed in `webapp/orchestrator/reloadable-modules.ts`; it does not replace long-lived bridge instances.
- Changes to `CodexStdioBridge` must preserve the existing Codex app-server process unless the user explicitly asks for an app-server restart. Reload support should change the bridge-side behavior around the connection, not tear down the connection.
- Changes to code between the Codex app-server stdio connection and the browser websocket must be covered by the `codex-bridge` reload scope or a newer equivalent reload scope that does not restart the Codex app-server child.
- `codex-bridge` reload must reload the bridge module or a delegated middleware module and preserve the live app-server process, pending bridge state, and websocket clients.
- If adding a new orchestrator subsystem, document its reload boundary in code: either add it to the reloadable helper bundle or wire it into an explicit non-destructive reload scope.
