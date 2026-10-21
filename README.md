
# workbench

an agentic ide about the human

## how 2 use

you need to install these yourself first:
1. [git](https://git-scm.com/)
2. node, through whatever you like. [vite+](https://viteplus.dev/) recommended

optional:
1. [tailscale](https://tailscale.com/), if you want to connect to workbench agents on other devices

and then workbench itself is just:
```bash
# install & open
npx @inthedark/wb

# set up daemon on another device
npx @inthedark/wb connect
```

## philosophies

- what the human says goes
- harnesses should own agent mistake prevention via mechanical tools. make mistakes impossible or difficult to walk into
- for projects sandboxes are the right approach
- allow the user to do anything in minimal clicks
- reinventing the wheel is worth it way more than in the past

## features

selling points first:

#### first class shared workspace support
a lot of work is not worktree->pr shaped; agents claim the files they need and other agents don't freak out about workspace dirt, they don't *see* it. they queue up behind each other for their claims. even has a git view that helps you easily commit unclaimed dirt

#### fully customisable instructions
base instructions get improved constantly; but YOUR CONTROL is important. you can override it piecemeal or in entirety, *with* support for comments & imports

#### consolidated tool & sandbox behaviour across harnesses
codex, opencode 2, and claude code agents all have workbench tools and only the most basic of their native tools left like edit tools

#### customisable voice to text
what if voice to text was like telling someone what to do in a rich text editor

#### webdev mockups using real project components & css
configure build+css scripts to handle the agent's created tsx

#### .env secrets
store secrets in ui, reference from .env, see dedicated docs below

#### agents can search repos with comfy shell fs tools
vfs-powered, so doesn't require the repo being on disk entirely

### ux
- thread status inbox, snooze threads while working to make them hide until done
- human readable displays for common shell commands
- near-instant loads
- smooth per-token animations, or animate in whole blocks if you prefer

### obligatory
- built on top of other harnesses (codex, opencode 2, claude code) so you can use subscriptions
- cross-harness subagents
- browser use
- saved profiles for harness/model/effort/window/fast mode/agent identity
- mcp servers (agents must ask to enable tools by default)

### misc
- automatic compaction on turn start past configurable time & token thresholds (reduce cache write costs)
- tailscale integration
- daemon sleeps when idle, leaving only a light http wake service up

### unpolished/unfinished/broken stuff (coming soon tm!!!!!)
- soon, autocomplete/suggestions extension for vscode & similar (highly configurable, able to be FAST)
- worktree->pr workflow is unsupported (gonna be honest i have been in a cave working solo on wb for so long that i have not needed this yet)
- search UX
- i'd like more git ui
- the codebase's refactors from its (very) humble beginnings are not complete

## tech

note: have tried to keep dependencies minimal for the most part

`/package` — the entrypoint/installer, what actually gets published to npm  
`/daemon/host` — wake service  
`/daemon/server` — workbench harness  
`/daemon/voice` — vtt service (rust)  
`/daemon/repo` — vfs service (go)  
`/daemon/relay` — linux sandbox loopback relay (go)  
`/integration` — integrations in third party software
`/instructions` — instructions for agents, copied into the user's `~/.workbench` folder whenever read  
`/app/server` — server for frontend app  
`/app/client` — frontend SPA  
`/app/tray` — system tray application for the frontend app (rust/tauri)  
`/shared` — shared stuff between the projects  
`/shared/network/native` — tailscale integration (go)  
`/test` — test runner  
`/scripts` — stuff used by package scripts plus anything i didn't notice an agent left behind :3  
`/docs` — help agents find things and not break them without eating all their tokens

## .env secrets

workbench's npm package `@inthedark/wb` can be used as a dotenv replacement. its `config` is async, so await it before reading your env vars:

```js
import { config } from "@inthedark/wb";

await config();
```

the following syntax in your .env file can be used to load data from workbench's private store:

```dotenv
API_KEY=${wb:API_KEY}
```

configure secrets in workbench at settings > projects & folders > environment > store. select the folder you want to configure.

the env loader by default silently acts like dotenv would for loading the .env if workbench is not installed, so it's safe to use in teams where some devs are using other stuff. references it can't resolve stay as literal text. existing env vars still take precedence. pass a `warn` callback to opt into lookup warnings.

you can choose what happens when values are missing:

```js
await config({ required: ["DATABASE_URL"] }); // all others optional
await config({ optional: ["ANALYTICS_KEY"] }); // all others required
```

use one list or the other. missing optional vars become empty strings, including the whole value if a store reference fails. missing required vars throw one error listing all their names before changing the environment. explicitly empty values are valid. "all others" means vars in your .env files.

you can use wb's env loader to load from other clis too, not just wb store:

```dotenv
WB_STORES="wb: wb store get {key}; other: my-secret-cli get {key}"
API_KEY=${other:API_KEY}
```

replace `my-secret-cli get {key}` with your cli's command. `{key}` is substituted into its arguments, and stdout becomes the value. commands run without a shell.

### security note

wb's env secret storage is not built for maximum security. it's built to prevent agents accidentally obtaining secrets. values use aes-256-gcm with a key derived from the device identity, username and project location, not a separate password, so this isn't protection against hostile code running as you.
