---
name: skill-extensions
description: Use when authoring a skill's chat components (`workbench_components`) or MCP call matchers (`workbench_mcp_matchers`).
---

<!-- Kept out of always-loaded instructions: few threads author skills, and these contracts are long. -->

Skills extend Workbench's transcript through frontmatter lists of files relative to the skill folder. Both apply only while the skill is active in a thread.

```md
---
name: azure-devops
description: ...
workbench_components: [BuildList.tsx, BuildCard.tsx]
workbench_mcp_matchers: [mcp-matchers.ts]
---
```

## Chat components (`workbench_components`)

- Each `.tsx` default-exports a function component named like its file (`BuildList.tsx` -> `<BuildList />`). Imports: relative files inside the skill, `"workbench/kit"`, React (no hooks).
- Agents write `<BuildList builds={[...]} />` in a message; Workbench renders it in a sandbox and keeps the result, so later skill edits never change it.
- Props must be serialisable; no event handlers. Draw icons with kit `SvgIcon` (`mode="fill"` for brand glyphs, any `viewBox`). Style with Tailwind classes and theme tokens (`text-text`, `text-fg/muted`, `bg-fg/5`); support light and dark.
- A prop value `"@result:<name>"` becomes the result an `mcp_call` kept with `keep: "<name>"`.
- Test: `wb vis test --markup '<BuildList ... />'` (MCP `vis_test`) returns a screenshot or the error.

## MCP call matchers (`workbench_mcp_matchers`)

Matchers decide how external MCP calls draw: direct calls, `mcp_call` to a non-wb server, and `wb mcp call`. They never see Workbench's own tools.

```ts
import { code, defineMcpMatcher, path, primary, thread } from "workbench-skill";

export default defineMcpMatcher(call => {
  if (call.server !== "azure-devops" || call.tool !== "pipelines_build") return null;
  const { action, project, buildIds } = call.arguments;
  if (action === "list") return {
    verb: ["Listing", "Listed"],
    summary: ["builds", code(buildIds.join(", ")), "in", code(project)],
    chip: { id: "builds", verb: "builds", icon: "git" },
    component: "BuildList",
  };
  if (action === "queue") return { verb: ["Queueing", "Queued"], summary: ["build"], display: { card: "pipelines" }, component: "BuildCard" };
  return null;
});
```

Contract (`workbench-skill` exports only `defineMcpMatcher`, `code`, `primary`, `path`, `thread`, `component(name, props, text)`; write the types inline if wanted):

```ts
interface Call {
  server: string; tool: string; arguments: Json;
  keep: string | null;                                // name the call kept its result under
  status: "inProgress" | "completed" | "failed" | null; // null: `wb mcp call`, matched from its command text alone
  error: string | null;
  result: Json | null;                                // structured content, else text (JSON text parsed); null while running or expired
}
interface Presentation {
  verb: [running: string, done: string];             // line = verb + summary parts, one space apart
  summary?: (string | { code } | { primary } | { path } | { thread } | { component; props?; text })[];
  icon?: Icon;                                       // row/card icon; default chip icon, else terminal
  chip?: { id: string; verb: string; icon: Icon };
  display?: "step" | "hidden" | { card: string; open?: boolean }; // default "step"
  component?: string;                                // one of this skill's components
  props?: Record<string, Json>;                      // extra props for it
}
type Icon = "terminal" | "file" | "search" | "book" | "folder" | "eye" | "git" | "arc" | "skill" | "browser" | "web" | "image"
  | { svg: { paths: string[]; viewBox?: string; mode?: "stroke" | "fill" } }; // single colour; brand glyphs: mode "fill"
```

- Return `null` to leave a call to the next active skill, then the generic summary. First non-null wins, in skill catalogue order.
- `step`: a row inside the activity card, counted under its chip (else exec). `{ card }`: its own card outside activity cards; back-to-back cards of one family stitch into one. `hidden`: not drawn.
- Summary `{ component }` parts draw one of this skill's components inline in the line (pills, avatars: keep them small), rendered once per props and kept; `text` shows until then and wherever the line is plain text. At most 16 per line.
- `component` renders once the call completes, with props `{ ...props, call }`; with `keep`, `call.result` is the kept result. The first render is kept, so result expiry never blanks it.
- Matchers run synchronously in a QuickJS sandbox in the browser: no DOM, network, timers or packages; imports only relative files and `workbench-skill`. Matcher code gets 25ms per call, after the call is loaded; a matcher that overruns or runs out of memory is switched off until the thread's matchers reload. Keep them pure and fast; branch on presentation-relevant facts only.
- `result` text that isn't bare JSON (e.g. wrapped in marker lines) stays a string. Decide from server/tool/arguments first, keep summaries light, and parse big results in the component, which has no deadline.
- Matchers reload when the thread's active skills change; the transcript redraws with the new presentation.
- Mock before building: a kit vis importing `ThreadPreview` from `workbench/kit/thread` with this skill's matchers and components shows the real transcript.
- Test: `wb vis match --server <s> --tool <t> --arguments-json '<json>' [--result-json '<json>'] [--status completed|failed|inProgress] [--keep <name>]` (MCP `vis_match`) runs the active skills' matchers on that call exactly as the browser does: compile, runtime and output errors, the drawn lines, chip, display, then a screenshot of the component.
