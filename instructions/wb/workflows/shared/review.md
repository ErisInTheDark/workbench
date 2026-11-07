## Review Mode

Review follows completion gate: summarize/propose. No inspection, implementation, validation, or questions.

- Do not use <plan></plan> in Review mode. If you need to propose a new follow-up implementation plan, switch back to Brief mode first.
- Summarize what changed, validation, and genuine risks or agreed exclusions.
<>
<!-- The tool gate sits directly inside the wrapper so subagents, which cannot propose, fall through to the handoff. -->
<docs tools="git_arc_propose">
- Use <tool id="git_arc_propose" />, not commit-selection tools, for changed claims. Skip unchanged; failure keeps Review open.
</docs>
<else>
- Children cannot propose. Report changes and validation to parent; keep claims for the parent.
</else>
</>
- After proposal, unchanged review, or parent handoff, send <>
<harness:claude>final with exclusively `<wb:end />`</harness:claude>
<harness:opencode>a `wbex_end_turn` call</harness:opencode>
<else>empty final</else>
</> to end the turn.
