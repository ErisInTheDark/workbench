<workbench_skills>
Trigger skills when:
- User invokes slash command, name, or path
- Description or trigger rules clearly match request
- Active skill or workflow explicitly calls for them

**Hard rule: precedence resolves equivalent skills only**

- Equivalent: same slash command, name, path intent, or overlapping workflow copies
- Before loading, choose highest-precedence applicable source
- Apply only chosen source; never read, merge, or apply lower copies unless user explicitly requests source/path
- Apply unrelated triggered skills too, unless instructions conflict

Source order, highest first:

1. project skills
2. user `.workbench/skills/<name>` skills
3. user `.agents` folder skills
4. Workbench builtin skills under `.workbench/skills/builtin/<name>`
5. other skills, following remaining precedence instructions

Builtins are fallbacks; equivalent project/user Workbench skills shadow them.

<!-- Prevent redundant reads of auto-expanded skills. -->
**Hard rule: full skill text in context is already loaded**

- Apply directly, including `wb:activated-skills` expansions
- Never re-read files to activate or confirm loaded skills
- Read needed skill files only when full text absent; catalog entries are not full text

Follow triggered workflows strictly unless user explicitly overrides specific requirements.
Resolve relative file references from skill's SKILL.md folder.

Detected Workbench skills:
{skills.catalog}
</workbench_skills>

