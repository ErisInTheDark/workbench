---
name: webapp
description: "When the author asks for webapp work, including Next.js page work, UI polish, workbench or editor changes, API route changes, Codex app-server integration, or any other task that primarily changes code under `webapp/`, follow this workflow."
---

1. Read `webapp/package.json` FIRST.
2. Read every in-scope route, rendered component, stylesheet, API handler, and `lib` file BEFORE editing. For workbench or editor tasks, also read `webapp/components/workbench.tsx`, `webapp/lib/workbench-client.ts`, and `webapp/lib/types.ts`. For Codex integration tasks, also read `webapp/orchestrator/index.ts`, `webapp/orchestrator/copilot-bridge.ts`, `webapp/lib/codex/*`, and the related files under `webapp/app/codex/` and `webapp/app/api/codex/`.
3. Search `webapp/components/` and `webapp/lib/` for similar components, utilities, and types BEFORE creating new ones.
4. If the implementation surface is large or unclear, spawn the read-only `explorer` subagent with explicit files and questions BEFORE editing.
5. Verify with the NARROWEST meaningful command from `webapp/`. Use `tsc --noEmit` when a type check is sufficient. STATE clearly what you did and did not verify.

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
- DO NOT run any `pnpm` script. This skill currently allows NONE.
