---
name: vis
description: Use when showing the user a visual draft (mockup, layout, chart, comparison), asking them to pick between visual options, or configuring a project's `.wb.json` vis build/css.
---

## Session

<!-- Managed agents on harnesses that block the wb CLI get an error pointing at mcp_call; naming both routes avoids that wasted call. -->
Run commands through your shell (`wb vis --help`), or via `mcp_call` server `wb` (`vis_*` tools) where the wb CLI is blocked.

- `wb vis start [--project <.|folder|kit>] <path>` shows file live in user's thread until `wb vis end <path>`. Edits re-render automatically; last good render stays while next builds.
- Write file in cwd project (`.html`, `.svg`, `.tsx`, `.jsx`). Gitignored location (e.g. `.workbench/`) unless user wants it kept.
- One live session per file. End sessions when done; settling ends leftovers.
- Start snapshot and end snapshot appear in transcript. User may end session themselves.
- `wb vis test --markup '<Component ... />'` screenshots active skill-component markup or returns an error. A prop value `"@result:<name>"` becomes the result kept by `mcp_call` `keep: "<name>"`.

## Pick a context (`--project`)

| value | builds with | use for |
|---|---|---|
| `.` (default) | caller project's `.wb.json` | product UI mockups (required when the project has a vis build) |
| relative folder | that folder's `.wb.json` | another project's components |
| `kit` | Workbench kit | presenting info, choices, comparisons; no project setup |

**Hard rule: mock product UI in project context, built from its real components.** Use `kit` only to present info or choices, or when the project has no vis build. Show proposed UI inside the real surface around it, mark what is new, and caption each frame with the user story it serves.

Project context without needed `.wb.json` command fails with a clear error: configure it (below) or use `kit`.

## Build it

- Prefer `.tsx` default export. Kit context: import from `"workbench/kit"` plus React and relative files only. Project context: import project files as its build allows.
<!-- Agents met contexts or prop drilling they could not satisfy and redrew the component from copied class names, or
drew its menus and tooltips "pinned open" from surface classes. Those mockups looked plausible but were not the product:
real interactions were gone and drift was invisible. Making the real component renderable is the intended fix; the
auto exception exists because users often want that untangling done quickly so the mockup can proceed. -->
- **Hard rule: render real components; never redraw them.** Copying a component's markup or class names, or drawing its menus or tooltips pinned open, is a failure. Users must be able to press, hover and drag the real thing.
- Real components: find where the live app renders them; pass fake data through their real data seams. Fake `useSyncExternalStore` stores must return stable snapshots.
- Project instructions may name its mockup helpers (fake data providers, option tabs); use them.
- Real component unusable in a mockup (prop drilling, context only one parent provides): fix the real component so it renders, as a briefed change. Never work around it in the vis file.
- The user may invoke the `auto` skill to skip approval for exactly those component fixes. That autonomy ends when the mockup stage ends; later work needs normal approval.
- New UI under test: build it from the same real primitives its surface uses, placed inside the real surface.
- Style with Tailwind classes; both contexts compile them. Theme tokens: `text-text`, `text-fg/muted`, `bg-fg/5`, `border-fg/10`; support light and dark.
- Frame height follows page content: no viewport-height sizing (`h-screen`, `min-h-screen`, `100vh`). Leave page background transparent.
- `.html`/`.svg`: add `<link rel="workbench-css">` in `<head>` for project CSS.
<!-- Pages used to run in an opaque srcdoc sandbox with no network, so agents base64-inlined every asset, gzipped
documents to fit the size cap and shimmed storage; real app code crashed on storage access and agent checks ran
unsandboxed, so they never saw it. Pages now load from a dedicated vis origin that serves the build root. -->
- Page is a normal page on its own origin, served from the build root: relative URLs (`static/a.png`, never `/static/a.png`) load project files; storage, `indexedDB`, eval and workers work. Other origins are blocked.
- Reference assets by URL; never inline them. Documents over 1 MB wait for the user to tap load.
- Kit (`workbench/kit`):
  - layout: `Section`, `Compare` (columns 2-4), `Stat`, `Table`, `Swatch`, `Callout` (Markdown in thread notice style)
  - options: `Options label id?` wrapping direct `Option title value?` children (children = that option's preview)
  - Workbench UI: `Disclosure`, `MarkdownRender`, `IconButton`, `PrimaryButton`, `RadioRow`, `Tooltip`, `PressDragMenu`, `PressDragSlider`, `StepSlider`, `OptionCards`/`OptionCard`, `FormSection`, `Tabs`/`Tab`, `ShareList`, `Sparkline`, `StreamChart`, `LineChart`, `Skeleton`, all icons (`XIcon`, ...), `SvgIcon size? mode?="stroke"|"fill" viewBox?` for other icons (children = paths)
  - state: `useVisState(id, initial)`
- Transcript (`workbench/kit/thread`): `ThreadPreview items matchers? components?`, real Workbench transcript from render-lab shorthand items (command strings, `{ type: "userMessage" | "agentMessage", text }`, `{ type: "mcpToolCall", server, tool, arguments, result?, status?, error? }`); pass a skill's matcher files and components to preview its MCP calls. Your screenshots/snapshots show every card and step open; the user's view stays collapsed like the app

## Show options

<!-- Agents invented their own layouts for "pick between options": side-by-side grids squashed every preview to a column,
one tab per component hid the comparison, and send buttons made users answer twice. These three shapes cover every case;
naming them stops the improvising. -->
<!-- Agents also split one design into independent tab sets (layout × entry × destination) whose combinations
contradicted each other, left per-story tab sets unlinked so each section showed a different design, and repeated the
same resting preview under every story with only the caption changed. Users could not compare anything. -->
**Hard rule: alternatives are always tabs, one full-size preview at a time.**

- One thing, 2-5 alternatives: one `Options` set. Previews real, not placeholder boxes.
- Several similar things, each with alternatives: list the things one after another down the page, each with its own `Options`. Same designs judged across things (stories, screens, states): give those `Options` one shared `id`, so picking a design anywhere switches every section. Never grid alternatives side by side; never make the things themselves tabs.
- Each option is one complete design. Never split a design into separate tab sets whose combinations can conflict.
- Each section shows a distinct real state of its thing, reached through fake data, route or the user's own interaction. Same preview with another caption is a failure; drop sections that would not differ.
- Outer tabs (an `Options` around the page) only for genuinely separate mockups or states (empty, error, held key).
- Tell user in chat what differs between options.

## User state

<!-- A vis rebuilds its frame on every edit, so page-local state resets; synced controls are what lets the agent keep
iterating without wiping the user's picks, and lets the agent read picks without a send step. -->
- What the user sets syncs to Workbench and survives your edits: `Options` picks (id = `label`), plain-text-summary `Disclosure`s (or `stateId`), and `useVisState(id, initial)` for anything else. Plain `useState` resets on every edit.
- Ids hold the user's state: keep them stable; rename one only to reset it.
- No send buttons. `wb vis read <path>` returns the state as JSON by control id. Ask via questionnaire whether they're done (plus freeform notes), then read.
- Builds without the kit: `window.wb.state` with `get(id)`, `set(id, json)` (≤16 KB), `subscribe(fn)`.

## Verify before handoff

**Hard rule: check every render against your intent before pointing user at it.**

- `wb vis screenshot <path>`: full-page image of current render, sent to you; user sees it only inside that call's row. `wb vis snapshot <path>`: accessibility tree.
- Both run in the session's headless Browse session (`vis-…`, 870px square: vis panel's widest) with the user's synced state, opened with the vis, stopped when it ends. Clicks there change nothing.
- Blank render means a runtime error: wrap frames in an error boundary that prints it. A blank page with no boundary output means a module-level throw: move fixture setup into a component.
- Before handoff: every section visibly differs from its neighbours under every option.
- Fix layout, content or styling gaps, then check again.

## Iterate and end

- Revise by editing file; same session re-renders. Verify again, then name changes in chat.
- Build/CSS failures show on card and in `wb vis start` output; fix and save.
- `wb vis end <path>` when approved or abandoned.

## Configure a project (`.wb.json`)

Root `.wb.json` (JSON schema: `wb.schema.json` in the `@inthedark/wb` package):

```json
{
  "vis": {
    "css": { "command": ["npx", "tailwindcss", "--input", "{input}"], "input": "@import \"{root}/src/app.css\";\n@source \"{file}\";\n" },
    "build": { "command": ["node", "scripts/vis-build.mjs", "{file}"] }
  }
}
```

- Commands run as your thread in its sandbox: read-only, no network, cwd = project root, through login shell.
- Placeholders: `{file}` vis file, `{root}` project root, `{input}` temp file holding `input` text.
- `css` prints CSS to stdout; inserted as leading `<style>`.
- `build` prints JSON `{ "document": "<!doctype html>...", "inputs": ["relative/or/absolute/paths"] }`: whole page, which may load build-root files by relative URL; `inputs` = files read, watched for re-render (`node_modules` ignored).
- Build script: bundle in memory (esbuild `write: false`), mount default export into page, inline Tailwind output; escape `</script`, `<script`, `<!--` in inlined JS. Workbench's `scripts/vis-build.mts` is a reference.
- Invalid entries are ignored individually; the error names them.
