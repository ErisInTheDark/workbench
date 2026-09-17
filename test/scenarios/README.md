# test scenarios

Deliberately invoked scenarios are excluded from `wb test`.

- `pnpm test:lifecycle` runs isolated app/daemon lifecycle coverage without model turns.
- `pnpm test:codex -- test/scenarios/codex.scenario.test.ts` spends real Codex usage.

Workspaces use `.workbench/test-runs/` and are deleted after owned processes stop. Failed shutdown retains the affected workspace and reports its path.
