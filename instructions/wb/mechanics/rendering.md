## Workbench Rendering
Keep commentary quality high. Spend time reasoning to ensure your commentary will be clear, concise, complete, and correct

### ALL markdown, UNIVERSAL rule
- Avoid manual line breaks merely to keep lines visually narrow. Prefer natural paragraphs; let renderers wrap lines

### Context
Assume your tool usage, internal reasoning, and commentary were not visible to the user. Briefs, reviews, and other commentary must include ALL important facts when those facts affect the user's decisions.

### User-visible mode changes (via workflows or skills)
<set-state mode="Mode Name" />

- Treat mode tags as behavior commitment
- Do not announce new mode until confident in routing and no more work remains in prior mode
- Use mode tags when routing backwards if genuinely necessary

## Workbench File Links

Bad:
- path/to/file.ts NO UNFORMATTED PATHS
- `path/to/file.ts:123` NO BACKTICKS
- "file.ts in the usual thingy folder" NO VAGUE GESTURING

Good:
- #[path/to/file.ts]
- #[path/to/file.ts:123]
- In multi-root workspaces: #[root:path/to/file.ts:123] or #[root:path/to/file.ts]
- If custom label required: [label](path/to/file.ts:123)

Notes:
- Write paths relative to project root
- Workbench automatically renders simplest disambiguated path suffix
- User may send you paths with # but without [], assume relative to project root

### Code blocks
- In commentary use quadruple backtick fences (````) for markdown codeblocks; allows triple backtick fences (```) inside
- Workbench supports file links in first line after language, example: ````ts #[path/to/file.ts:123]
- Use file link header without line number for diffs
- Use file link header with line number for samples

### Attention Markup

<!-- Ensure agents use attention markup to mark all important stuff but otherwise don't touch it. -->
ENSURE IMPORTANT CONTENT MARKED. ENSURE ROUTINE CONTENT PLAIN.

- Use alert icons <icon color="{color}" type="alert" /> to mark lines or list items in plans or commentary. Mark important or revised in plans. Limit marking, do not overuse or it loses significance. NEVER mark routine headings. Reason for mark must be obvious by its associated text
- <notice title="{short sentence case title}" color="{color}">{markdown}</notice> to mark 1-2 paragraph sections in plans or commentary; help users quickly classify important text. NEVER put <icon> inside <notice>
- Colors: `blue` important new or revised content; `green` important summary of resolutions; `purple` important questions or alternatives; `yellow` required attention or user input; `red` serious problems or breaking changes

### Work plans, especially git-arc-related plans and addendums
- Put user-visible markdown inside <plan></plan>
- Do not wrap review summaries, completed-work reports, validation reports, or readonly findings
- Do not hide planned work inside questionnaires
- Include code block samples or diffs for important context or change proposals
- Include quote blocks for text samples or diffs, <ins></ins> and <del></del> for diffs
- Show usage samples for proposed APIs, whether public facing or internal to allow user shape evaluation
- Samples & diffs should be present, but minimal; do not include giant chunks when a smaller sample proves the point
- Extra, less important details can be put within <details>/<summary> blocks
- Show markdown table in <details> for behaviors — <icon type="check">preserved</icon>, <icon color="blue" type="asterisk">changed</icon>, <icon color="yellow" type="x">removed</icon>
- BEFORE WRITING THE PLAN AS COMMENTARY, YOU MUST ALREADY KNOW WHAT THE PLAN WILL CONTAIN THROUGH EXPLICIT REASONING
