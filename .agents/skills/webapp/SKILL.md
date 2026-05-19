---

name: webapp
description: "When the author asks for webapp work, including Next.js page work, UI polish, workbench or editor changes, API route changes, Codex app-server integration, or any other task that primarily changes code under `webapp/`, follow this workflow."

---

## Orientation

- `webapp/` is a Next.js App Router app using React 19, Tailwind 4, and a custom markdown workbench and editor.
- `webapp/components/workbench.tsx` owns the React shell, responsive explorer and editor layout, and UI chrome; `webapp/lib/WorkbenchClient.ts` owns imperative editor behavior, persistence, polling, and most client-side file and thread interactions.
- `webapp/lib/workbench/` uses layered ownership: public client surfaces stay at the folder root, editor-private controllers live under `editor/`, reusable DOM helpers live under `dom/`, state owners live under `state/`, markdown helpers live under `markdown/`, project helpers live under `project/`, and thread helpers live under `thread/`.
- `webapp/app/api/` contains server routes for tree, file, and Codex operations; keep their contracts aligned with `webapp/lib/types.ts`.
- `webapp/orchestrator/` coordinates local Next.js development together with the Codex and Copilot bridge paths.

# Constraints

## DO

- PREFER REUSABLE COMPONENTS. Reusable components should be the default export of their file, which should have a matching PascalCase filename such as `ThreadView.tsx`.
- PREFER PROMINENT CONTROLLERS. State owners/controllers — whether a function, or a class — should be the default export of their file, which should have a matching PascalCase filename such as `WorkbenchClient.ts`.
- MISC FILES LOOK MISC. Files containing miscellaneous functions or types or registries should be kebab-case, such as `command-matchers.ts`.
- RELATED FUNCTIONALITY BELONGS IN REGISTRIES. For example, handling transformation of raw strings into specific actions or displays should not be hardcoded, but should instead be individual items within a transformation registry. Large registries should be broken into a core registry file that imports all of its contents from smaller files of individual registry items or groups.
- DOCUMENT FILES. Add & keep updated a start-of-file manifest comment for files containing multiple components, functions, types, etc. Include high-signal keywords. List every export and its one-line purpose. Manifest comments that do not follow this exact format should be proactively updated.
- KEEP FILES SMALL AND REUSABLE. PROACTIVELY PLAN REFACTORS. The codebase MUST stay in coherent, maintainable pieces instead of growing monolithic files.
- FLUSH/ZEN VISUAL LANGUAGE. Minimal borders, backgrounds only when necessary. Gradient masks can help differentiate parts of the app. Buttons should only get a background on hover.
- ENSURE COLOUR SCHEME SUPPORT. Both dark & light mode should be supported by every change.
- ENSURE MOBILE SUPPORT. Make desktop and mobile behavior DELIBERATE, especially for split explorer and editor layout, sticky controls, and save or reset affordances.
- KEEP SHARED CODE IN SYNC. Never write shared code, such as client/server code, with `any`/`unknown` types, always use shared types and keep the two sides synchronised.
- UPDATE GUIDANCE. Keep`AGENTS.md` or nearby project guidance up-to-date when the webapp's structure or operating workflow changes materially. Confirm the changes with the user.

## DO NOT

- DO NOT add file-specific duplicate components, utilities, or types when a shared home already exists.
- DO NOT leave a single-component file in `webapp/components/` on a mismatched filename or named export.
- DO NOT leave API contracts or state flow half-migrated.
- DO NOT run any `pnpm` script except `typecheck`.
- DO NOT call the webapp endpoints yourself without EXPLICIT permission from the user.
- DO NOT run `tsx` to test your code.

# Workflow

- Research the task at hand.
  - Cross-reference with `GLOSSARY.md` to ensure you and the user are on the same page.
  - When a feature seems particularly large or like in an ideal scenario it wants to touch a lot of the codebase, ask the user for permission to spawn one or more explorer subagents focused on specific slices of code or classes of issues, to make sure your understanding is exhaustive.
  - For bugs, produce a list of theories. For features, a list of edges. Present these to the user as commentary, ranked by importance.
  - Sharpen fuzzy language before making a plan.
    - When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."
    - Challenge against the glossary — When the user uses a term that conflicts with the existing language in `GLOSSARY.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"
    - Discuss concrete scenarios — When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.
    - Cross-reference with code — When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"
    - Update `GLOSSARY.md` inline —When a term is resolved, update `GLOSSARY.md` right there. Don't batch these up — capture them as they happen. The glossary should be totally devoid of implementation details. It is a glossary and nothing else.
- Produce a CONCRETE plan for the changes you're going to make, and present it to the user. This plan should include concrete existing symbol names and hypothetical symbol names, where applicable. NO vaguely gesturing at the codebase and rephrasing the user's request. The user MUST be presented with something concrete for approval.
- Once the user has been presented with the plan, ask them for confirmation on it using your questionnaire tool. If the user gives follow-up notes, replan, or even re-research if it looks like their notes widen the task.
- Once the user has given approval for implementation, implement the plan.
- Run a typecheck to verify everything still works.
- Present a "Does this look good? What's next?" or similar questionnaire with the user to verify that everything is working as intended. In this questionnaire prompt, provide a list of suggested follow-ups that could be done as addendums to this changeset. The user may give new information here that changes the scope of the task. STRONGLY consider jumping back to the initial research step for round 2 in the case that this occurs.
