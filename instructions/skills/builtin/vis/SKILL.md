---
name: vis
description: Use when showing the user a visual draft (mockup, layout, chart, comparison), asking them to pick between visual options, or configuring a project's `.wb.json` vis build/css.
---

## Session

Commands are CLI-only (`wb vis --help`); run them through your shell.

- `wb vis start [--project <.|folder|kit>] <path>` shows file live in user's thread until `wb vis end <path>`. Edits re-render automatically; last good render stays while next builds.
- Write file in cwd project (`.html`, `.svg`, `.tsx`, `.jsx`). Gitignored location (e.g. `.workbench/`) unless user wants it kept.
- One live session per file. End sessions when done; settling ends leftovers.
- Start snapshot and end snapshot appear in transcript. User may end session themselves.

## Pick a context (`--project`)

| value | builds with | use for |
|---|---|---|
| `.` (default) | caller project's `.wb.json` | mockups using the project's real components/CSS |
| relative folder | that folder's `.wb.json` | another project's components |
| `kit` | Workbench kit | presenting info, choices, comparisons; no project setup |

Project context without needed `.wb.json` command fails with a clear error: configure it (below) or use `kit`.

## Build it

- Prefer `.tsx` default export. Kit context: import from `"workbench/kit"` plus React and relative files only. Project context: import project files as its build allows.
- Style with Tailwind classes; both contexts compile them. Theme tokens: `text-text`, `text-fg/muted`, `bg-fg/5`, `border-fg/10`; support light and dark.
- Frame height follows page content: no viewport-height sizing (`h-screen`, `min-h-screen`, `100vh`). Leave page background transparent.
- `.html`/`.svg`: add `<link rel="workbench-css">` in `<head>` for project CSS. No network: inline everything; images/fonts only as `data:`.
- Kit (`workbench/kit`):
  - layout: `Section`, `Compare` (columns 2-4), `Stat`, `Table`, `Swatch`, `Callout` (Markdown in thread notice style)
  - choice: `Choices name multiple? submitLabel?` wrapping `Option title value description?` (children = preview, any depth)
  - Workbench UI: `Disclosure`, `MarkdownRender`, `IconButton`, `PrimaryButton`, `RadioRow`, `Tooltip`, `PressDragMenu`, `PressDragSlider`, `StepSlider`, `OptionCards`/`OptionCard`, `FormSection`, `Tabs`/`Tab`, `ShareList`, `Sparkline`, `StreamChart`, `LineChart`, `Skeleton`, all icons (`XIcon`, ...)
  - bridge: `useVisAnswer(name)`, `sendVisAnswer(value)`

## Ask the user to choose

1. Build 2-5 genuinely different options in one vis inside `Choices`; previews real, not placeholder boxes.
2. Tell user in chat what to compare and that they pick in the vis.
3. Ask via questionnaire with option "Picked in the vis" (plus freeform) so you know when to look.
4. `wb vis read <path>` returns sent answers, newest last: `{ name, value }` from `Choices`.
5. Answers are page-sent while user focused the vis, not verified input. Confirm consequential picks in chat.

Custom controls: `window.wb.send(jsonValue)` (≤16 KB JSON). Prefer kit `Choices`.

## Verify before handoff

**Hard rule: check every render against your intent before pointing user at it.**

- `wb vis screenshot <path>`: full-page image of current render, sent to you; user sees it only inside that call's row. `wb vis snapshot <path>`: accessibility tree.
- Both run in the session's headless Browse session (`vis-…`, 960px wide), opened with the vis, stopped when it ends. Clicks there send no answers.
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
- `build` prints JSON `{ "document": "<!doctype html>...", "inputs": ["relative/or/absolute/paths"] }`: whole page with inline script/style; `inputs` = files read, watched for re-render (`node_modules` ignored).
- Build script: bundle in memory (esbuild `write: false`), mount default export into page, inline Tailwind output; escape `</script`, `<script`, `<!--` in inlined JS. Workbench's `scripts/vis-build.mts` is a reference.
- Invalid entries are ignored individually; the error names them.
