---

name: webapp
description: "When the author asks for webapp work, including Next.js page work, UI polish, workbench or editor changes, API route changes, Codex app-server integration, or any other task that primarily changes code under `webapp/`, follow this workflow."

---

## Scope

- Treat `webapp/` as the companion application for the book project, not a throwaway prompt target.
- Take ownership of webapp behavior, operator workflow, architecture, and note hygiene where the app depends on project structure.
- Think one route wider and one contract wider than the immediate request whenever relevant.

## Required Reading

- Read `webapp/package.json` first to understand the stack, scripts, and runtime expectations.
- Read the relevant route entry files under `webapp/app/`, the rendered component files under `webapp/components/`, and the relevant helpers and types under `webapp/lib/` before editing.
- Search `webapp/components/` and `webapp/lib/` for existing or similar components, utilities, and types before creating new ones.
- When reading or creating utility files, look for a top-of-file export manifest first and keep that manifest accurate if you change exports.
- Read `webapp/app/layout.tsx` and `webapp/app/globals.css` when changing page structure, shared UI, or visual language.
- If the task touches the markdown workbench or editor UX, read `webapp/components/workbench.tsx`, `webapp/lib/WorkbenchClient.ts`, and `webapp/lib/types.ts`.
- If the task touches project file IO, tree or thread state, or save or reset flows, read the matching route handlers under `webapp/app/api/` plus `webapp/lib/project.ts` and `webapp/lib/git.ts`.
- If the task touches Codex integration, read `webapp/orchestrator/index.ts`, `webapp/orchestrator/copilot-bridge.ts`, `webapp/lib/codex/*`, and the related files under `webapp/app/codex/` and `webapp/app/api/codex/`.

Minimum expectation by task:

- UI polish or layout work: read the route, the rendered component tree, and `webapp/app/globals.css`.
- Shared component change: read every route or shell that renders it, not just the component file.
- Client/server contract change: read both the caller and the handler, plus `webapp/lib/types.ts`, before editing.
- New component, utility, or type: check for an existing shared home or near-match before adding a file-local version.
- Build, startup, or Codex app-server issues: read `webapp/package.json`, `webapp/orchestrator/index.ts`, and the affected integration files before changing code.

## Webapp Orientation

- `webapp/` is a Next.js App Router app using React 19, Tailwind 4, and a custom markdown workbench and editor.
- `webapp/components/workbench.tsx` owns the React shell, responsive explorer and editor layout, and UI chrome; `webapp/lib/WorkbenchClient.ts` owns imperative editor behavior, persistence, polling, and most client-side file and thread interactions.
- `webapp/lib/workbench/` uses layered ownership: public client surfaces stay at the folder root, editor-private controllers live under `editor/`, reusable DOM helpers live under `dom/`, state owners live under `state/`, markdown helpers live under `markdown/`, project helpers live under `project/`, and thread helpers live under `thread/`.
- `webapp/app/api/` contains server routes for tree, file, and Codex operations; keep their contracts aligned with `webapp/lib/types.ts`.
- `webapp/orchestrator/index.ts` coordinates local Next.js development together with the Codex and Copilot bridge paths.
- Prefer smaller components and reusable, testable utilities over growing already-large files. Prefer extending or relocating shared logic over adding file-specific helpers or duplicate types.
- Every shared utility file should start with a short manifest comment that lists every exported function, a one-line summary of what it is for, and high-signal keywords so future agents can find the right helper quickly.

## Update Discipline

- If you change API contracts, shared types, route structure, editor interaction rules, or Codex connection behavior, update the corresponding callers, handlers, and shared types in the same pass.
- If webapp architecture, startup flow, or core operator workflow changes materially, update `AGENTS.md` or nearby docs in the same pass.
- For webapp work, prefer extracting reusable components and testable utilities instead of adding more logic to monolithic files, and prefer existing shared helpers over file-local reinventions.
- For webapp utility files, keep a top-of-file export manifest current. Put it above imports and update it whenever exported functions are added, removed, renamed, or repurposed.

## Structure

- `webapp/`: Next.js workbench app for browsing and editing the project.
- `webapp/package.json`: scripts and dependency versions.
- `webapp/app/`: App Router pages, layouts, and API routes.
- `webapp/components/`: page shells and shared UI components.
- `webapp/lib/`: shared types, git and project helpers, workbench client logic, and Codex integration helpers.
- `webapp/lib/workbench/`: layered workbench runtime modules split across root client surfaces plus `editor/`, `dom/`, `state/`, `markdown/`, `project/`, and `thread/` sublayers.
- `webapp/orchestrator/`: local dev entrypoint and bridge helpers that run Next.js together with the Codex and Copilot harnesses.

## Webapp Harness Notes

- Workbench thread titles are set through`POST /api/thread-title`, which forwards to the native harness thread naming APIs rather than storing a separate overlay title.
- For Codex workbench threads, agent bootstrap instructions such as project agent-file loading should live in hidden developer or collaboration instructions, not injected fake user`<agent_type>`messages.
- For Copilot workbench threads, equivalent bootstrap behavior should be carried by the session system message so both harnesses stay aligned.

1. Read `webapp/package.json` FIRST.
2. Read every in-scope route, rendered component, stylesheet, API handler, and `lib` file BEFORE editing. For workbench or editor tasks, also read `webapp/components/workbench.tsx`, `webapp/lib/WorkbenchClient.ts`, and `webapp/lib/types.ts`. For Codex integration tasks, also read `webapp/orchestrator/index.ts`, `webapp/orchestrator/copilot-bridge.ts`, `webapp/lib/codex/*`, and the related files under `webapp/app/codex/` and `webapp/app/api/codex/`.
3. Search `webapp/components/` and `webapp/lib/` for similar components, utilities, and types BEFORE creating new ones.
4. Verify with the NARROWEST meaningful command from `webapp/`. Use `tsc --noEmit` when a type check is sufficient. STATE clearly what you did and did not verify.

## DO

- KEEP changes in the existing architecture: App Router pages and API handlers in `webapp/app/`, reusable UI in `webapp/components/`, shared contracts and helpers in `webapp/lib/`, and local multi-process development flow in `webapp/orchestrator/`.
- IN `webapp/components/`, give single-component files a DEFAULT export and a matching PascalCase filename such as `ThreadView.tsx`.
- IN `webapp/components/`, add a top manifest comment when a file contains multiple components or related functions.
- PREFER smaller components and reusable, testable utilities. EXTRACT coherent pieces instead of growing monolithic files.
- KEEP a short manifest comment at the top of every shared utility file above imports. LIST every export, its one-line purpose, and high-signal keywords. UPDATE it whenever exports change.
- PRESERVE the current visual language unless the author asks for a redesign. Make desktop and mobile behavior DELIBERATE, especially for split explorer and editor layout, sticky controls, and save or reset affordances.
- UPDATE the route handler, caller, and `webapp/lib/types.ts` in the SAME PASS when changing client/server or cross-file behavior.
- UPDATE `AGENTS.md` or nearby project guidance in the SAME PASS when the webapp's structure or operating workflow changes materially.

## DO NOT

- DO NOT add file-specific duplicate components, utilities, or types when a shared home already exists.
- DO NOT leave a single-component file in `webapp/components/` on a mismatched filename or named export.
- DO NOT leave API contracts or state flow HALF-MIGRATED.
- DO NOT run any `pnpm` script except `typecheck`.
- DO NOT run `tsx` to test your code.
