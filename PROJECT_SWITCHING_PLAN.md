# Project Switching Plan

This document describes the intended project-switching architecture for the
workbench. Keep it forward-facing as the implementation evolves: update it to
describe the current design and next steps, not historical repo state.

## Goals

- Discover projects under a configured projects root.
- Treat a project as a directory containing a `.git` directory or `.git` file.
- Stop descending into a directory once it is identified as a project.
- Use normalized project ids based on paths relative to the configured projects
  root.
- Route the workbench through readable client-side URLs instead of file/thread
  search params.
- Keep all file, tree, git, agent, and thread behavior scoped to the selected
  project.

## Project Discovery

Use a server-only configured root, tentatively `WORKBENCH_PROJECTS_ROOT`.

Project ids are normalized relative paths from that root:

```text
WORKBENCH_PROJECTS_ROOT=c:/git
c:/git/web/workbench -> web/workbench
```

Discovery should recursively scan the configured root. When a directory contains
`.git` as either a file or directory, emit that directory as a project and skip
its descendants. Then continue scanning sibling directories.

The scanner should ignore generated or tool-owned directories such as:

- `.git`
- `.codex`
- `.workbench`
- `.next`
- `.vscode`
- `node_modules`
- `dist`
- `build`
- `coverage`

The project list endpoint should return stable metadata:

```ts
interface WorkbenchProjectOption {
  id: string;
  name: string;
  rootPath: string;
  relativePath: string;
}
```

The client should never submit arbitrary filesystem roots. It submits
`projectId`; the server resolves and validates that id against the configured
projects root.

## API Surface

Add:

```text
GET /api/projects
```

Response:

```ts
interface WorkbenchProjectsPayload {
  data: WorkbenchProjectOption[];
  rootPath: string;
}
```

Make project IO APIs project-aware:

```text
GET /api/tree?projectId=web/workbench
POST /api/tree
GET /api/file?projectId=web/workbench&path=webapp/package.json
PUT /api/file
GET /api/agents?projectId=web/workbench
```

Request bodies for write/create operations should include `projectId`.

All path resolution should follow this shape:

```ts
const projectRoot = resolveProjectRoot(projectId);
const absolutePath = safeResolveProjectPath(projectRoot, relativePath);
```

Server helpers should be root-parameterized:

```ts
resolveProjectRoot(projectId)
safeResolveProjectPath(projectRoot, relativePath)
buildTree(projectRoot)
getProjectSnapshot(projectId)
listUserInvocableAgents(projectId)
readUserInvocableAgentDefinition(projectId, agentPath)
```

During migration, routes may default to the current project when `projectId` is
absent. Once the routed client is stable, explicit project ids should be the
normal contract.

## Workbench Routes

Use catch-all app route handling so the same workbench shell can render for
project, file, and thread URLs. Parsing and navigation should be owned by
client-side route helpers.

Supported URL forms:

```text
/web/workbench
/web/workbench/@/file/webapp/package.json
/web/workbench/@/thread/uuiduuid-uuid-uuid-uuid-uuiduuiduuid
```

Parsing rules:

- Everything before `/@/` is the project id.
- `/@/file/...` selects a project-relative file path.
- `/@/thread/...` selects a thread id.
- A route without `/@/` selects only the project.
- Unsupported modes should clear the active selection or redirect to the project
  root.

Shared helpers should expose a normalized selection:

```ts
interface WorkbenchRouteSelection {
  projectId: string;
  filePath: string;
  threadId: string;
}
```

and a writer:

```ts
syncWorkbenchRoute({
  projectId,
  filePath,
  threadId,
});
```

API routes can continue using query strings and JSON bodies. The clean route
shape is for browser navigation and workbench state.

## Client State

The workbench project client should own:

- discovered projects
- selected project id
- selected project root path
- selected project tree
- selected project git changes
- expanded directories scoped to the selected project

Startup flow:

1. Fetch `/api/projects`.
2. Parse the current route.
3. Select the routed project if valid.
4. If the route has no valid project, select a default project and rewrite the
   route.
5. Fetch the selected project snapshot.
6. Apply any routed file or thread selection.

Shared state contracts should include project identity:

```ts
interface ProjectSnapshot {
  projectId: string;
  root: string;
  rootPath: string;
  tree: TreeNode[];
  changes: Record<string, ChangeSummary>;
}

interface ExplorerSnapshot {
  projects: WorkbenchProjectOption[];
  currentProjectId: string;
  root: string;
  rootPath: string;
  tree: TreeNode[];
  threads: ThreadSummary[];
  changes: Record<string, ChangeSummary>;
  currentPath: string;
  currentThreadId: string;
  expandedDirectories: string[];
  locallyModifiedPaths: string[];
  threadsError: string;
  fontSize: number;
}
```

Controls should include:

```ts
selectProject(projectId: string): Promise<void>;
```

## Persistence

Persist browser state by project id so equal relative paths in different
projects do not collide.

Recommended scoping:

- Expanded directories: `workbench:expanded-directories:<projectId>`
- Drafts: key by `projectId:path`
- Current route: path-based project route
- In-memory draft buffers: either per selected project or keyed by
  `projectId:path`

Project switching should:

1. Persist the current dirty draft.
2. Clear the active editor/thread view.
3. Load the selected project tree and changes.
4. Refresh project-scoped threads.
5. Apply routed file/thread selection if present.

No blocking prompt is needed if draft persistence is reliable.

## Threads

Codex thread creation should use the selected project root as `cwd`.

Thread filtering should match the selected project root exactly unless a future
workflow explicitly supports subdirectory-owned threads. Since project discovery
does not descend into discovered projects, nested project ownership should not
be inferred from parent containment.

Copilot should accept selected cwd through the bridge contract when starting a
new session. The bridge must validate the requested cwd against known project
roots before passing it to the SDK. Resumed sessions can continue using metadata
cwd, but the workbench should only show/open sessions that match the selected
project.

## UI

Add a compact project picker in the explorer header.

Expected behavior:

- Show the current project name or id.
- List projects from `/api/projects`.
- Selecting a project navigates to `/<projectId>`.
- File and thread selections route under the selected project.
- If no projects are found, show an empty state with the configured projects
  root.
- If discovery fails, show a concise error in the explorer.

## Implementation Order

1. Add project discovery helpers and `GET /api/projects`.
2. Refactor project helpers to accept selected project roots.
3. Make tree, file, and agents APIs project-aware.
4. Add catch-all workbench route parsing and writing.
5. Add selected-project state to the workbench project client.
6. Scope expanded directories and drafts by project id.
7. Add the project picker UI.
8. Update Codex thread cwd and filtering.
9. Update Copilot bridge cwd handling.
10. Verify with typecheck and manual route/API checks.

## Verification

Use the narrowest meaningful checks for each slice:

```text
pnpm run typecheck
GET /api/projects
GET /api/tree?projectId=web/workbench
GET /api/file?projectId=web/workbench&path=webapp/package.json
/web/workbench
/web/workbench/@/file/webapp/package.json
/web/workbench/@/thread/<thread-id>
```
