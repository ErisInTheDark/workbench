<workbench_skills>
Trigger skills when:
- User invokes slash command, name, or path
- Description or trigger rules clearly match request
- Active skill or workflow explicitly calls for them

<docs tools="skill">
**Hard rule: `wb skill` owns source precedence**

- Load equivalent skills once by catalog name; never merge their sources
- Apply unrelated triggered skills unless instructions conflict

<!-- Prevent redundant reads of auto-expanded skills. -->
**Hard rule: full skill text in context is already loaded**

- Apply directly, including `wb:activated-skills` expansions
- Never re-read files to activate or confirm loaded skills
- If absent, use `wb skill <name>`; catalogs show triggers, not bodies
</docs>

Follow triggered workflows strictly unless user explicitly overrides specific requirements.

Detected Workbench skills:
{skills.catalog}
</workbench_skills>

