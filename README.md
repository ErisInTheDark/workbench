
# workbench

an agentic ide about the human

## how 2 use
```bash
# install & open
npx @inthedark/wb

# set up daemon on another device
npx @inthedark/wb connect
```

## features

key features:
- fully customisable agent instructions with support for comments & imports
- strong thread transcript UX for when you need to keep an eye on a thread (command matching + html elements for agents)
- strong thread management UX for when you're managing LOTS of threads (thread status-sorted sidebar)
- better shared workspace support than any other agentic ide, because a lot of work is not worktree->pr shaped; agents claim the files they need and other agents don't freak out about unclaimed dirt
- customisable voice to text
- git UI for doing your own work at the same time as other agents, allowing easy commits while agents have other files claimed
- quickly switch between saved profiles for harness/model/effort/window/fast mode/agent identity

setup/meta:
- built on top of other harnesses (codex, opencode2 wip) so you can use subscriptions
- tailscale integration
- daemon sleeps when idle, leaving only a light http wake service up

unpolished/unfinished/broken stuff (coming soon tm!!!!!):
- worktree->pr workflow is unsupported (gonna be honest i have been in a cave working solo on wb for so long that i have not needed this yet)
- subagents are kinda broken rn
- browse AX
- search UX
- stats UX
- settings UX
- UX when working across many projects at once (currently it's a lot nicer to have one tab open for each project)
- i'd like more git ui
- many places around the app could use a UI polish pass
- the codebase itself could use a polish pass, esp. the react & tailwind

## tech

note: have tried to keep dependencies minimal for the most part

`/package` — the entrypoint/installer, what actually gets published to npm  
`/daemon/host` — wake service  
`/daemon/server` — workbench harness  
`/daemon/voice` - vtt service (rust)  
`/instructions` — instructions for agents, copied into the user's `~/.workbench` folder whenever read  
`/app/server` — server for frontend app  
`/app/client` — frontend SPA  
`/app/tray` — system tray application for the frontend app (rust/tauri)  
`/app/network` — tailscale integration (go)  
`/shared` — shared stuff between the projects  
`/test` — test runner  
`/scripts` — stuff used by package scripts plus anything i didn't notice an agent left behind :3  
`/docs` — help agents find things and not break them without eating all their tokens
