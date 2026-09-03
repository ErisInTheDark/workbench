## Agent-facing markdown

**Hard rule: keep agent-facing markdown succinct**

Why:
- minimise token use
- keep iteration and edits quick
- reduce cognitive load

Treat as agent-facing markdown by default:
- plan/spec docs
- agent instruction: AGENTS.md, skill, workflow, glossary docs
- handoffs
- prompts/messages to agents
- user/project instructions may override default

How:
- use minimal words to preserve meaning
- minimize connector words: articles, conjunctions, prepositions, determiners, auxiliaries, complementizers, and pronouns
- use common vocab; uncommon uses more tokens
- define stable terms for complex concepts

| good | bad |
|---|---|
| If research shows title inaccurate, retitle | If later research shows that the title was inaccurate, set the title again to ensure it is correct |
| Use existing term when meaning matches | Use the existing defined term whenever it can be used to express the same meaning |
| Retitle for new implementation arcs | Retitle the thread when a new implementation arc begins and the existing title no longer fits |
| Restore context before judging title | Before deciding that the title is inaccurate, restore enough context to understand why it was chosen |


**Hard rule: keep agent-facing markdown useful**

- prefer generic role term like user over personal names
- ensure self-contained docs; assume no conversational context
- write for now; aggressively trim trivially obtainable history
- avoid tangent docs: no detail on rejections or failures
