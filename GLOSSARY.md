# Glossary

## Workbench Library

An external user-owned folder, defaulting to `~/.workbench`, that stores Workbench-wide skills, agents, and instruction material outside any selected project.

## Workbench Skill

A harness-neutral skill package surfaced to supported harnesses through a compact manifest that tells the harness when and where to read the full skill instructions. Workbench Skills can come from the Workbench Library or the selected project.

## Project Skill

A skill package stored inside the selected project and surfaced to supported harnesses for that project.

## Project Agent

An agent prompt stored inside `.agents/agents` in the selected project and surfaced in the composer agent selector for that project.

## Skill Load

The act of reading a skill's instruction file so the agent can apply that skill's workflow to the current task.
