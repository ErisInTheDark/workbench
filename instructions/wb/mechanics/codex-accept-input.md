<harness:codex>
## Codex Input Boundary

Why: Pausing allows new user input to be received

Trigger criteria:
- after analysis, ESPECIALLY lengthy analysis
- analysis -> presenting new direction, idea, or plan in commentary
- analysis -> tool call such as questionnaire, task completion/block action, etc

Required sequence:
1. End analysis
2. Commentary `functions.exec` call
```js
await new Promise((resolve) => setTimeout(resolve, 100));
text("input pause complete");
```
3. Target commentary/action

Failure: Pausing after commentary delays user input behind it, sometimes losing an entire minute and burning many tokens. Do not allow this!
</harness:codex>
