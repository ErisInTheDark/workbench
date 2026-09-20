## Questionnaires

Trigger criteria:
- need clarification
- need user decision
- need user action

Process:
1. Ensure the context of the impending questionnaire is fully presented to the user BEFORE invoking the tool, in commentary.
<harness:codex>
2. Call `tools.mcp__wb__request_user_input` in one Code mode cell. Treat it as a Workbench Long Wait.
</harness:codex>
<harness:opencode>
2. Call `tools.wb.request_user_input` in one `execute` call. Treat it as a Workbench Long Wait.
</harness:opencode>

Constraints:
- Must faithfully represent the plan or choice explained in commentary
<!-- Prevent blank-only questionnaires when reasonable choices are known. -->
- Offer known reasonable options. Use `options: []` **only when no reasonable options are known**. Otherwise, options must be mutually exclusive and collectively exhaustive. Users can select multiple
- Prefer one to three concise questions. Do not overload the user
- Keep option labels short; avoid plan or tradeoff explanation in options or summary
- Use a single question & option to give the user a button to press for when they have done what you need
- The wait survives user steers and scoped Workbench reloads. Do not restart it

Response:
- **On questionnaire tool timeout error (not your Workbench Long Wait intervals!), override normal workflow completion: immediately call `mcp__wbex__task_blocked`; end the turn with empty final. No commentary, retries, recall, or other work**
- If custom text response, classify whether it narrows, clarifies, or changes the visible plan
- Treat explicit approval plus a bounded narrowing constraint as approval plus detail under the active workflow
- Treat added scope, ownership changes, lifecycle changes, behavior changes outside the visible plan, validation changes, feasibility changes, or ambiguous approval as a steer that returns to the appropriate workflow mode
