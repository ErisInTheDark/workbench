/*
 * Exports:
 * - default McpServerSettings: one daemon's user-added MCP servers as status cards; sign in or set an API key, pick allowed tools, and add servers by URL.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { McpServerSnapshot } from "workbench-shared/workbench/mcp/mcp-server-settings";
import McpServerSettingsController, { openCenteredMcpSignInPopup } from "../../workbench/McpServerSettingsController";
import { readWorkbenchAppPort } from "../../workbench/app/workbench-app-port-client";
import { useWorkbenchAppRpc } from "../../workbench/app/WorkbenchAppRpcContext";
import IconButton, { iconButtonClassName } from "../ui/IconButton";
import MarkdownRender from "../ui/MarkdownRender";
import PressDragMenu from "../ui/PressDragMenu";
import PrimaryButton from "../ui/PrimaryButton";
import WorkbenchCheckbox from "./WorkbenchCheckbox";
import WorkbenchSettingsStatusRow, { type WorkbenchSettingsStatusTone } from "./WorkbenchSettingsStatusRow";
import WorkbenchTextField from "./WorkbenchTextField";
import {
  ChevronDownIcon, KeyRoundIcon, KeyRoundOffIcon, MoreVerticalIcon, PlusIcon, RefreshCwIcon, SparklesIcon, Trash2Icon,
} from "./workbench-icons";
import { enterMotionClassName } from "../../tailwind/enter-motion-classes";

type ServerProps = { server: McpServerSnapshot; controller: McpServerSettingsController; busy: boolean };
type Tool = Extract<McpServerSnapshot["catalog"], { status: "ready" }>["tools"][number];

const cardBorder = "border-[color-mix(in_srgb,var(--text)_10%,transparent)]";

/** The server's own title, else the name without a prefix every tool shares, sentence-cased. */
function toolLabel(tool: Tool, sharedPrefix: string) {
  if (tool.title?.trim()) return tool.title.trim();
  const words = tool.name.slice(sharedPrefix.length).replace(/[_-]+/gu, " ").trim();
  const sentence = /[a-z]/u.test(words) ? words : words.toLowerCase();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function sharedPrefix(tools: readonly Tool[]) {
  const prefix = tools[0]?.name.match(/^[A-Za-z0-9]+[_-]/u)?.[0] ?? "";
  return tools.length > 1 && prefix && tools.every(tool => tool.name.startsWith(prefix)) ? prefix : "";
}

function MenuItem({ icon, danger = false, children }: { icon: ReactNode; danger?: boolean; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-2 ${danger ? "text-danger" : ""}`}>{icon}{children}</span>;
}

function IconLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5">{icon}{children}</span>;
}

function presentStatus(server: McpServerSnapshot): { tone: WorkbenchSettingsStatusTone; status: string } {
  if (server.catalog.status === "signInRequired") return { tone: "action", status: "Needs sign-in" };
  if (server.catalog.status === "error") return { tone: "failed", status: "Unavailable" };
  return { tone: "ready", status: server.auth?.kind === "oauth" ? "Signed in" : server.auth?.kind === "header" ? "API key" : "Connected" };
}

function ApiKeyFields({ server, controller, busy, onDone }: ServerProps & { onDone: () => void }) {
  const [header, setHeader] = useState("");
  const [value, setValue] = useState("");
  return <form className="mt-2 flex flex-wrap items-center gap-2 text-[0.82em]" onSubmit={event => {
    event.preventDefault();
    void controller.update({ action: "setAuth", id: server.id, auth: { header: header.trim(), value: value.trim() } })
      .then(saved => { if (saved) onDone(); });
  }}>
    <WorkbenchTextField variant="dotted" className="w-36 font-mono" aria-label="API key header name" placeholder="Header name"
      autoComplete="off" spellCheck={false} disabled={busy} value={header} onChange={event => setHeader(event.target.value)} />
    <WorkbenchTextField variant="dotted" type="password" className="min-w-0 flex-1 font-mono" aria-label="API key"
      placeholder="Key" autoComplete="off" spellCheck={false} disabled={busy} value={value} onChange={event => setValue(event.target.value)} />
    <PrimaryButton type="submit" shape="compact" disabled={busy || !header.trim() || !value.trim()}>Save</PrimaryButton>
    <PrimaryButton shape="compact" disabled={busy} onClick={onDone}>Cancel</PrimaryButton>
  </form>;
}

function ToolList({ server, controller, busy }: ServerProps) {
  const tools = server.catalog.status === "ready" ? server.catalog.tools : [];
  // Allowed tools the server stopped offering stay listed so they can be unticked.
  const listed: Tool[] = [...tools, ...server.allowedTools.filter(name => !tools.some(tool => tool.name === name))
    .map(name => ({ name, title: null, description: "No longer offered by the server." }))];
  const prefix = sharedPrefix(tools);
  const setTool = (name: string, allowed: boolean) => {
    const others = server.allowedTools.filter(tool => tool !== name);
    void controller.update({ action: "setTools", id: server.id, tools: allowed ? [...others, name] : others });
  };
  // Sized in rem: the checkbox and card each shrink `em` text, which compounded into unreadable tool rows.
  const row = "w-full items-start rounded-lg text-sm [&>[aria-hidden]]:mt-[0.2rem]";
  return <div className="mt-2.5 flex flex-col gap-1 border-t border-fg/8 pt-2.5">
    <WorkbenchCheckbox className={row} label={<span className="text-text">All tools, including ones added later</span>}
      checked={server.allowAll} disabled={busy}
      onChange={allowAll => { void controller.update({ action: "setAllowAll", id: server.id, allowAll }); }} />
    {listed.map(tool => <WorkbenchCheckbox key={tool.name} className={row} disabled={busy || server.allowAll}
      checked={server.allowAll || server.allowedTools.includes(tool.name)} onChange={allowed => setTool(tool.name, allowed)}
      label={<span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-text">{toolLabel(tool, prefix)}</span>
          <code className="text-[0.85em] font-normal text-fg/muted">{tool.name}</code>
        </span>
        {tool.description ? <MarkdownRender markdown={tool.description}
          className="mt-0.5 font-normal text-fg/muted [&_p]:my-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5" /> : null}
      </span>} />)}
  </div>;
}

function ServerCard({ server, controller, busy, loopbackOrigin }: ServerProps & { loopbackOrigin: string | null }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const { tone, status } = presentStatus(server);
  const ready = server.catalog.status === "ready";
  const toolCount = server.catalog.status === "ready"
    ? server.allowAll ? "All tools" : `${server.allowedTools.length} of ${server.catalog.tools.length} tools` : "";
  const menu = [
    server.auth?.kind === "header"
      ? { id: "remove-key", content: <MenuItem icon={<KeyRoundOffIcon />}>Remove API key</MenuItem> }
      : { id: "key", content: <MenuItem icon={<KeyRoundIcon />}>Use an API key…</MenuItem> },
    ...server.auth?.kind === "oauth" ? [{ id: "sign-out", content: <MenuItem icon={<KeyRoundOffIcon />}>Sign out</MenuItem> }] : [],
    { id: "remove", content: <MenuItem icon={<Trash2Icon />} danger>Remove server</MenuItem> },
  ];
  return <WorkbenchSettingsStatusRow label={server.name} tone={tone} status={status} detail={server.url.replace(/^https?:\/\//u, "")}
    error={server.catalog.status === "error" ? server.catalog.detail : ""}
    body={<>
      {keyOpen ? <ApiKeyFields server={server} controller={controller} busy={busy} onDone={() => setKeyOpen(false)} /> : null}
      {toolsOpen && ready ? <ToolList server={server} controller={controller} busy={busy} /> : null}
    </>}>
    {server.catalog.status === "signInRequired" ? <PrimaryButton shape="compact" disabled={busy || !loopbackOrigin}
      title={loopbackOrigin ? undefined : "Sign in from the computer running Workbench"}
      onClick={() => { void controller.startSignIn(server.id); }}><IconLabel icon={<KeyRoundIcon size={14} />}>Authenticate</IconLabel></PrimaryButton> : null}
    {ready ? <button type="button" aria-expanded={toolsOpen} onClick={() => setToolsOpen(open => !open)}
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[0.82em] text-text hover:bg-fg/6">
      {toolCount}<ChevronDownIcon className={`size-3.5 text-fg/muted transition ${toolsOpen ? "rotate-180" : ""}`} />
    </button> : null}
    {server.catalog.status === "error" ? <IconButton size="small" display="hover-border" label={`Retry ${server.name}`} disabled={busy}
      onClick={() => { void controller.update({ action: "refresh", id: server.id }); }}><RefreshCwIcon className="size-4" /></IconButton> : null}
    <PressDragMenu label={`More for ${server.name}`} items={menu} align="end" disabled={busy}
      triggerAppearance="plain" triggerClassName={iconButtonClassName({ size: "small", display: "hover-border" })}
      onSelect={id => {
        if (id === "key") setKeyOpen(true);
        else if (id === "remove-key") void controller.update({ action: "setAuth", id: server.id, auth: null });
        else if (id === "sign-out") void controller.update({ action: "signOut", id: server.id });
        else if (id === "remove") void controller.update({ action: "remove", id: server.id });
      }}>
      <MoreVerticalIcon className="size-4" />
    </PressDragMenu>
  </WorkbenchSettingsStatusRow>;
}

/** The last card in the list; Add appears once a URL is typed. */
function AddServerCard({ controller, busy, onAdded }: {
  controller: McpServerSettingsController;
  busy: boolean;
  /** Ids of servers that appeared because of this add. */
  onAdded: (ids: string[]) => void;
}) {
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  return <div className="py-1">
    <form className={`flex items-center gap-2 rounded-[0.95rem] border ${cardBorder} px-3 py-1.5`} onSubmit={event => {
      event.preventDefault();
      const before = new Set(controller.getSnapshot().settings?.servers.map(server => server.id));
      setAdding(true);
      void controller.update({ action: "add", url: url.trim() }).then(added => {
        setAdding(false);
        if (!added) return;
        setUrl("");
        onAdded(controller.getSnapshot().settings?.servers.filter(server => !before.has(server.id)).map(server => server.id) ?? []);
      });
    }}>
      <PlusIcon className="size-4 shrink-0 text-fg/muted" />
      <input className="min-w-0 flex-1 bg-transparent py-1.5 text-[0.86em] text-text outline-none placeholder:text-fg/muted"
        aria-label="MCP server URL" placeholder="Add a server by URL" autoComplete="off" spellCheck={false}
        disabled={busy} value={url} onChange={event => setUrl(event.target.value)} />
      {url.trim() || adding ? <PrimaryButton type="submit" shape="compact" disabled={busy} pendingHalo={adding}>
        <IconLabel icon={<SparklesIcon size={14} />}>Add</IconLabel>
      </PrimaryButton> : null}
    </form>
  </div>;
}

export default function McpServerSettings({ daemon, daemonId }: { daemon: WorkbenchDaemonClient; daemonId: string }) {
  const rpc = useWorkbenchAppRpc();
  const controller = useMemo(() => new McpServerSettingsController({
    daemonId,
    read: () => daemon.mcpServers.read(),
    update: update => daemon.mcpServers.update(update),
    startSignIn: params => daemon.mcpServers.startSignIn(params),
    readAppPort: () => readWorkbenchAppPort(rpc),
    onSignIn: listener => rpc?.onEvent(event => {
      if (event.kind === "mcp-sign-in" && event.daemonId === daemonId) listener();
    }) ?? (() => undefined),
    openPopup: openCenteredMcpSignInPopup,
  }), [daemon, daemonId, rpc]);
  useEffect(() => {
    void controller.refresh();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Only servers added from this view animate in; ones already present on load render still.
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set());
  return <div className="flex flex-col">
    {state.settings?.servers.map(server => <div key={server.id} className={entering.has(server.id) ? enterMotionClassName : ""}>
      <ServerCard server={server} controller={controller} busy={state.busy} loopbackOrigin={state.loopbackOrigin} />
    </div>)}
    <AddServerCard controller={controller} busy={state.busy} onAdded={ids => setEntering(new Set(ids))} />
    {state.error ? <p role="alert" className="m-0 px-3 text-[0.78em] leading-[1.55] text-danger">{state.error}</p> : null}
  </div>;
}
