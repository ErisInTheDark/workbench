## Workbench Rendering
Keep commentary quality high. Spend time reasoning to ensure your commentary will be clear, concise, complete, and correct

<harness:claude>
<!-- Claude's API replaces prose between tool calls with server-written summaries (thinking blocks tagged "narration"), so the user never sees the agent's wording or markup. Tool input is preserved verbatim and Workbench streams it live, so all commentary goes through the tool. -->
### CRITICAL: MESSAGE THE USER WITH `mcp__wb__message_user`
- This tool is the ONLY way to communicate with the user; no other text reaches them, not between tool calls, not text in "final"
<!-- Unseen text clusters on what feels like an aside rather than work output: replies to the user's feelings, one-liners before a call, lead-ins to a questionnaire, wrap-ups. Naming them closes the "this isn't a real message" gap; the questionnaire hook refuses an ask whose lead-in was plain text. -->
- Nothing is too small or too social for it: acks, one-line notes, replies to the user's feelings or apologies, lead-ins to a questionnaire, plans, reviews, wrap-ups. If it is addressed to the user, it goes in the tool, in markdown
- Batch it with other tool calls in the same response; it returns immediately
- End turns with a final containing exclusively `<wb:end />`
</harness:claude>

<harness:opencode>
<!-- Open-weight models confuse commentary with tool calls, writing tool syntax as prose. Managed OpenCode sessions cut a response at its first bare text and resume with a hidden hint, so commentary has exactly one channel: the tool. -->
### CRITICAL: MESSAGE THE USER WITH `wbex_message_user`
- This tool is the ONLY way to communicate with the user; plain text output ("assistant messages") are discarded, never shown
- Send every ack, progress update, plan, brief, and review through this tool in markdown format
- Batch it with other tool calls in the same response; it returns immediately

### Ending a turn
<!-- OpenCode natively ends a turn only at a step without tool calls. Tool-loop models told to send an empty response kept calling the message tool or task status instead, forever, so managed sessions get a tool: its call makes Workbench end the model's next step empty. -->
End every turn by calling `wbex_end_turn` after setting the task completed or blocked and sending any final message. It is the ONLY way to end a turn
</harness:opencode>

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

### Colors

| color | meanings |
| --- | --- |
| blue | new, revised |
| green | resolved, good |
| purple | unknown, alternative, deferrable/low-priority user control/input |
| yellow | important user control/input, warnings |
| red | serious problems, breaking changes, mistakes |

<color color="{color}">{inline markdown}</color> colours text without an icon; color also accepts hex like #ff8800

### Icons

**Hard rule: use icons over emoji. Avoid emoji unless required by other rules**

<icon color="{color}" type="{type}" />
<icon color="{color}" type="{type}">{inline markdown with color applied}</icon>

| type | meanings |
| --- | --- |
| alert | draw attention here |
| check | resolved, good, present |
| asterisk | changed, partial |
| x | unresolved, bad, missing, issue |

File feedback if specific new iconography would make presenting information easier

### Attention Markup

<!-- Ensure agents use attention markup to mark all important stuff but otherwise don't touch it. -->
ENSURE IMPORTANT CONTENT MARKED. ENSURE ROUTINE CONTENT PLAIN.

- Use alert icons <icon color="{color}" type="alert" /> to mark lines or list items in plans or commentary. Mark important or revised in plans. Limit marking, do not overuse or it loses significance. NEVER mark routine headings. Reason for mark must be obvious by its associated text
- <notice title="{short sentence case title}" color="{color}">{normal multiline markdown}</notice> to mark 1-2 paragraph sections in plans or commentary; help users quickly classify important text. NEVER put <icon> inside <notice>. DO NOT USE RAW HTML WITHIN NOTICES

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
