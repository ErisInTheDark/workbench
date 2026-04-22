# Project Instructions

## Ownership

- Treat this workspace as a living companion webapp, not a one-off prompt.
- Take ownership of webapp behavior.
- The user has final say, but agents should proactively look for better options, flag contradictions, spot missed opportunities, and notice when an app change has wider consequences.
- Think one route wider and one contract wider than the immediate request.
- Be creative, invested, and interested in improving the webapp and its tools rather than only satisfying the narrow wording of the task.

## Required Reading Before Webapp Work

Before editing code under `webapp/`:

- Read `webapp/package.json` first to understand the stack, scripts, and runtime expectations.
- Read the relevant route entry files under `webapp/app/`, the rendered component files under `webapp/components/`, and the relevant helpers and types under `webapp/lib/` before editing.
- Search `webapp/components/` and `webapp/lib/` for existing or similar components, utilities, and types before creating new ones.
- When reading or creating utility files, look for a top-of-file export manifest first and keep that manifest accurate if you change exports.
- Read `webapp/app/layout.tsx` and `webapp/app/globals.css` when changing page structure, shared UI, or visual language.
- If the task touches the markdown workbench or editor UX, read `webapp/components/workbench.tsx`, `webapp/lib/workbench-client.ts`, and `webapp/lib/types.ts`.
- If the task touches project file IO, tree or thread state, or save or reset flows, read the matching route handlers under `webapp/app/api/` plus `webapp/lib/project.ts` and `webapp/lib/git.ts`.
- If the task touches Codex integration, read `webapp/orchestrator.js`, `webapp/lib/codex/*`, and the related files under `webapp/app/codex/` and `webapp/app/api/codex/`.

Minimum expectation by task:

- UI polish or layout work: read the route, the rendered component tree, and `webapp/app/globals.css`.
- Shared component change: read every route or shell that renders it, not just the component file.
- Client/server contract change: read both the caller and the handler, plus `webapp/lib/types.ts`, before editing.
- New component, utility, or type: check for an existing shared home or near-match before adding a file-local version.
- Build, startup, or Codex app-server issues: read `webapp/package.json`, `webapp/orchestrator.js`, and the affected integration files before changing code.

## Webapp Orientation

- `webapp/` is a Next.js App Router app using React 19, Tailwind 4, and a custom markdown workbench and editor.
- `webapp/components/workbench.tsx` owns the React shell, responsive explorer and editor layout, and UI chrome; `webapp/lib/workbench-client.ts` owns imperative editor behavior, persistence, polling, and most client-side file and thread interactions.
- `webapp/app/api/` contains server routes for tree, file, and Codex operations; keep their contracts aligned with `webapp/lib/types.ts`.
- `webapp/orchestrator.js` coordinates local Next.js and Codex app-server development flow.
- Prefer smaller components and reusable, testable utilities over growing already-large files. Prefer extending or relocating shared logic over adding file-specific helpers or duplicate types.
- Every shared utility file should start with a short manifest comment that lists every exported function, a one-line summary of what it is for, and high-signal keywords so future agents can find the right helper quickly.

## Workflow Discipline
If you have not been given a "designation" or a skill workflow to follow, and the user hasn't specified, confirm with the user that you should proceed without one.

For work under `webapp/`, use the `webapp` skill.

## Update Discipline

- If webapp architecture, startup flow, or core operator workflow changes materially, update `AGENTS.md` or nearby docs in the same pass.
- For webapp work, prefer extracting reusable components and testable utilities instead of adding more logic to monolithic files, and prefer existing shared helpers over file-local reinventions.
- For webapp utility files, keep a top-of-file export manifest current. Put it above imports and update it whenever exported functions are added, removed, renamed, or repurposed.

## Project Structure

- `.agents/skills/`: project-specific workflows.
- `webapp/`: Next.js workbench app for browsing and editing the project.
- `webapp/package.json`: scripts and dependency versions.
- `webapp/app/`: App Router pages, layouts, and API routes.
- `webapp/components/`: page shells and shared UI components.
- `webapp/lib/`: shared types, git and project helpers, workbench client logic, and Codex integration helpers.
- `webapp/orchestrator.js`: local dev entrypoint that runs Next.js together with the Codex app-server.
