# Glossary

- Workbench Library - An external user-owned folder, defaulting to `~/.workbench`, that stores Workbench-wide skills, agents, and instruction material outside any selected project.

- Workbench Skill - A harness-neutral skill package surfaced to supported harnesses through a compact manifest that tells the harness when and where to read the full skill instructions. Workbench Skills can come from the Workbench Library or the selected project.

- Project Skill - A skill package stored inside the selected project and surfaced to supported harnesses for that project.

- Project Agent - An agent prompt stored inside `.agents/agents` in the selected project and surfaced in the composer agent selector for that project.

- Skill Load - The act of reading a skill's instruction file so the agent can apply that skill's workflow to the current task.

- profile - The exact composer settings snapshot held by a thread or draft. If tied to a stored profile, it also keeps that profile id.

- stored profile - A named reusable profile. A tied thread copies its latest settings whenever it starts a new turn.

- profile ribbon - The composer controls immediately to the left of the send button, regardless of their visual treatment.

- mosaic - A desktop-only Workbench route/view that renders a URL-encoded split tree of file and thread panels, separate from normal single file/thread routes so the single-route app shell and scroll behavior remain stable fallback paths.

- steer admittance - The point when Workbench or the underlying harness accepts a steer for an active turn. Admittance associates the steer with that turn, but does not mean that the running agent has received it in model context.

- steer delivery - The later point when an admitted steer is supplied to the running agent at an input boundary. Delivery makes the steer available to the agent's reasoning and can occur after a pending tool call completes.
