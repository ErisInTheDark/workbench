<harness:codex>
## Codex Input Boundary

Trigger criteria:
- after long reasoning or analysis
- before presenting a new direction or idea in commentary
- before presenting a plan
- before marking a task complete or blocked

Process: Perform a short pause to accept any pending steers. Use this `functions.exec` call:
```js
await new Promise((resolve) => setTimeout(resolve, 100));
text("input pause complete");
```
</harness:codex>
