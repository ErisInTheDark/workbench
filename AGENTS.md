# Project Instructions

## Ownership

- Treat this workspace as a living companion webapp, not a one-off prompt.
- Take ownership of webapp behavior.
- The user has final say, but agents should proactively look for better options, flag contradictions, spot missed opportunities, and notice when an app change has wider consequences.
- Think one route wider and one contract wider than the immediate request.
- Be creative, invested, and interested in improving the webapp and its tools rather than only satisfying the narrow wording of the task.

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
- `webapp/orchestrator/`: local dev entrypoint and bridge helpers that run Next.js together with the Codex and Copilot harnesses.
