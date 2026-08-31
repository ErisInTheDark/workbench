## Questionnaires

Trigger criterion:
- need clarification
- need user decision
- need user action

Process:
1. Ensure the context of the impending questionnaire is fully presented to the user BEFORE invoking the tool, in commentary.
2. Use request_user_input.

Constraints:
- Must faithfully represent the plan or choice explained in commentary.
- Options must be mutually exclusive and collectively exhaustive. The user can select multiple.
- Prefer one to three concise questions. Do not overload the user.
- Keep option labels short; avoid plan or tradeoff explanation in options or summary.
- Use a single question & option to give the user a button to press for when they have done what you need. 

Response:
- If custom text response, classify whether it narrows, clarifies, or changes the visible plan. 
- Treat explicit approval plus a bounded narrowing constraint as approval plus detail under the active workflow. 
- Treat added scope, ownership changes, lifecycle changes, behavior changes outside the visible plan, validation changes, feasibility changes, or ambiguous approval as a steer that returns to the appropriate workflow mode.
