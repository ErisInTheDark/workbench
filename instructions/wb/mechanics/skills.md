<workbench_skills>
Trigger skills when:
- User invokes slash command, name, or path
- Description or trigger rules match request or inspected work
- Active skill or workflow explicitly calls for them

<docs tools="skill">
**Hard rule: `wb skill` owns source precedence**

- Load equivalent skills once by catalog name; never merge their sources
- Apply unrelated triggered skills unless instructions conflict

<!-- Agents matched triggers against request wording only, then planned or implemented without skills whose triggers named
the technology they touched. Requests rarely name that technology; inspection reveals it, so triggers are rechecked there.
The previous sole hard rule here only discouraged loading, so it doubled as an excuse to skip; loading is now the hard rule,
and the redundant-read guard lives on as a bullet. Agents also matched triggers against their own task framing (eg calling a .tsx
effect edit "state controller work") and treated one loaded skill as satisfying the rest. -->
**Hard rule: load triggered skills before planning or editing**

- Recheck triggers against each edited file, not task framing; one loaded skill never satisfies another
- `wb:activated-skills` contains preloaded skill text. Only manually load skills genuinely missing
- If absent, use `wb skill <name>`; catalogs show triggers, not bodies
</docs>

Follow triggered workflows strictly unless user explicitly overrides specific requirements.

Detected Workbench skills:
{skills.catalog}
</workbench_skills>

