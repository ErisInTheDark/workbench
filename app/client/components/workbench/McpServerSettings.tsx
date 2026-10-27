/*
 * Exports:
 * - default McpServerSettings: one daemon's user-added MCP servers as status cards, for every project and per project; sign in or set an
 *   API key, pick allowed tools, edit a stdio (npm or cli) server's arguments and sealed environment, and add servers by URL, npm
 *   package or command.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import {
  formatMcpPackageArgs, parseMcpCliCommand, parseMcpPackageArgs, parseMcpPackageCommand,
} from "workbench-shared/workbench/mcp/mcp-package-command";
import {
  McpServerEnvNameSchema, type McpServerSettingsUpdate, type McpServerSnapshot, type McpServerSource,
} from "workbench-shared/workbench/mcp/mcp-server-settings";
import McpServerSettingsController, { isUnchecked } from "../../workbench/McpServerSettingsController";
import SecretRowsController from "../../workbench/state/SecretRowsController";
import { openCenteredMcpSignInPopup } from "../../workbench/mcp-sign-in-popup";
import { mcpToolLabel, mcpToolSharedPrefix } from "../../workbench/mcp-tool-label";
import { readWorkbenchAppPort } from "../../workbench/app/workbench-app-port-client";
import { useWorkbenchAppRpc } from "../../workbench/app/WorkbenchAppRpcContext";
import IconButton, { iconButtonClassName } from "../ui/IconButton";
import FlushInput from "../ui/FlushInput";
import MarkdownRender from "../ui/MarkdownRender";
import PressDragMenu from "../ui/PressDragMenu";
import ProjectScopedSettingsSection, { type ProjectScopedSettingsProject } from "./ProjectScopedSettingsSection";
import PrimaryButton from "../ui/PrimaryButton";
import RadioRow from "../ui/RadioRow";
import InputList from "./InputList";
import WorkbenchCheckbox from "./WorkbenchCheckbox";
import { IconLabel, SettingsMenuItem } from "./settings-row-labels";
import WorkbenchSettingsStatusRow, { type WorkbenchSettingsStatusTone } from "./WorkbenchSettingsStatusRow";
import WorkbenchTextField from "./WorkbenchTextField";
import {
  ChevronDownIcon, DownloadIcon, KeyRoundIcon, KeyRoundOffIcon, MoreVerticalIcon, PlusIcon, RefreshCwIcon, SparklesIcon, TerminalIcon, Trash2Icon,
} from "./workbench-icons";
import { enterMotionClassName } from "../../tailwind/enter-motion-classes";

type ServerProps = { server: McpServerSnapshot; controller: McpServerSettingsController; busy: boolean };
type Tool = Extract<McpServerSnapshot["catalog"], { status: "ready" }>["tools"][number];
type StdioSource = Extract<McpServerSource, { kind: "npm" | "cli" }>;
const isStdio = (source: McpServerSource): source is StdioSource => source.kind !== "http";
/** What a stdio server's arguments follow: its package or its program. */
const launchedProgram = (source: StdioSource) => source.kind === "npm" ? source.package : source.command;

const cardBorder = "border-[color-mix(in_srgb,var(--text)_10%,transparent)]";
const panelLabel = "m-0 text-[0.92em] text-fg/muted";

function presentStatus(server: McpServerSnapshot): { tone: WorkbenchSettingsStatusTone; status: string } {
  if (server.catalog.status === "pending") return { tone: "pending", status: "Checking connection..." };
  if (server.catalog.status === "installing") return { tone: "pending", status: "Installing with npm..." };
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

function useEnvRows(daemon: WorkbenchDaemonClient, id: string) {
  const controller = useMemo(() => new SecretRowsController({
    subject: "environment",
    read: () => daemon.mcpServers.env.read({ id }),
    update: (upserts, removals) => daemon.mcpServers.env.update({ id, upserts, removals }),
    keyIssue: key => {
      const parsed = McpServerEnvNameSchema.safeParse(key);
      return parsed.success ? null : parsed.error.issues[0]?.message ?? "Use a valid variable name.";
    },
  }), [daemon, id]);
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  return { controller, state: useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot) };
}

/** Arguments after the package or program, committed on Enter or blur; a typo such as an open quote stays in the field with its reason. */
function ArgumentsField({ server, source, controller, busy }: ServerProps & { source: StdioSource }) {
  const saved = formatMcpPackageArgs(source.args);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const commit = () => {
    if (draft === null) return;
    const parsed = parseMcpPackageArgs(draft);
    if ("error" in parsed) return setError(parsed.error);
    setError("");
    setDraft(null);
    if (formatMcpPackageArgs(parsed.args) !== saved) void controller.update({ action: "setArgs", id: server.id, args: parsed.args });
  };
  return <div className="flex flex-col gap-1">
    <p className={panelLabel}>Arguments</p>
    <div className="flex min-w-0 items-center gap-2 font-mono">
      <span className="shrink-0 text-fg/muted">{launchedProgram(source)}</span>
      <WorkbenchTextField variant="dotted" className="min-w-0 flex-1" aria-label="Arguments" placeholder="No arguments"
        autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={Boolean(error)} value={draft ?? saved}
        onChange={event => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={event => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") { setDraft(null); setError(""); }
        }} />
    </div>
    {error ? <p role="alert" className="m-0 text-danger">{error}</p> : null}
  </div>;
}

/** A stdio server's launch: its arguments and its sealed environment variables; Done restarts it when the environment changed. */
function LaunchSettings({ server, source, controller, busy, daemon, onDone }: ServerProps & {
  source: StdioSource;
  daemon: WorkbenchDaemonClient;
  onDone: () => void;
}) {
  const env = useEnvRows(daemon, server.id);
  const [envEdited, setEnvEdited] = useState(false);
  return <div className="mt-2.5 flex flex-col gap-3 border-t border-fg/8 pt-2.5 text-[0.82em]">
    <ArgumentsField server={server} source={source} controller={controller} busy={busy} />
    <div className="flex flex-col gap-1">
      <p className={panelLabel}>Environment, encrypted for this device and user</p>
      <InputList kind="pairs" idPrefix={`mcp-env-${server.id}`} rowLabel="Environment variable" keyPlaceholder="NAME" placeholder="value" secret
        disabled={env.state.status === "loading"} errors={env.state.issues} rows={env.state.rows}
        onRowsChange={rows => { setEnvEdited(true); env.controller.setRows(rows); }} />
    </div>
    <div className="flex min-h-7 items-center gap-2">
      {env.state.status === "loading" ? <p role="status" className="m-0 text-fg/muted">Loading environment...</p> : null}
      {env.state.status === "saving" ? <p role="status" className="m-0 text-fg/muted">Saving...</p> : null}
      {env.state.status === "failed" ? <>
        <p role="alert" className="m-0 text-danger">{env.state.error}</p>
        <button type="button" className="rounded-lg px-2 py-1 text-accent hover:bg-accent-soft" onClick={() => env.controller.retry()}>Retry</button>
      </> : null}
      <PrimaryButton shape="compact" className="ml-auto" disabled={busy || env.state.status === "saving"} onClick={() => {
        if (envEdited) void controller.update({ action: "refresh", id: server.id });
        onDone();
      }}>Done</PrimaryButton>
    </div>
  </div>;
}

function ToolList({ server, controller, busy }: ServerProps) {
  const tools = server.catalog.status === "ready" ? server.catalog.tools : [];
  // Allowed tools the server stopped offering stay listed so they can be unticked.
  const listed: Tool[] = [...tools, ...server.allowedTools.filter(name => !tools.some(tool => tool.name === name))
    .map(name => ({ name, title: null, description: "No longer offered by the server." }))];
  const prefix = mcpToolSharedPrefix(tools);
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
    {server.catalog.status === "ready" && server.catalog.search
      ? <p className="m-0 px-1 text-[0.8rem] text-fg/muted">Search-based server: agents find its tools by searching and ask you to enable them.</p>
      : null}
    {listed.map(tool => <WorkbenchCheckbox key={tool.name} className={row} disabled={busy || server.allowAll}
      checked={server.allowAll || server.allowedTools.includes(tool.name)} onChange={allowed => setTool(tool.name, allowed)}
      label={<span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-text">{mcpToolLabel(tool, prefix)}</span>
          <code className="text-[0.85em] font-normal text-fg/muted">{tool.name}</code>
        </span>
        {tool.description ? <MarkdownRender markdown={tool.description}
          className="mt-0.5 font-normal text-fg/muted [&_p]:my-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5" /> : null}
      </span>} />)}
  </div>;
}

function ServerCard({ server, controller, busy, loopbackOrigin, daemon, projectNamed }: ServerProps & {
  loopbackOrigin: string | null;
  daemon: WorkbenchDaemonClient;
  /** Whether the server's project, if any, is listed in this view under its own name. */
  projectNamed: boolean;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const { tone, status } = presentStatus(server);
  const ready = server.catalog.status === "ready";
  // Only offered tools count; picks the server no longer offers stay listed below but are not "enabled".
  const enabledCount = server.catalog.status === "ready"
    ? server.catalog.tools.filter(tool => server.allowedTools.includes(tool.name)).length : 0;
  const toolCount = server.catalog.status !== "ready" ? ""
    : server.allowAll ? "All tools"
      // A search-based server's total is unknown: it holds thousands, found by searching.
      : server.catalog.search ? `${enabledCount} enabled` : `${enabledCount} of ${server.catalog.tools.length} tools`;
  // A local stdio server runs as this computer's user; it takes arguments and environment variables instead of an API key or sign-in.
  const menu = [
    ...isStdio(server.source)
      ? [{ id: "launch", content: <SettingsMenuItem icon={<TerminalIcon />}>Launch settings…</SettingsMenuItem> }]
      : [server.auth?.kind === "header"
      ? { id: "remove-key", content: <SettingsMenuItem icon={<KeyRoundOffIcon />}>Remove API key</SettingsMenuItem> }
      : { id: "key", content: <SettingsMenuItem icon={<KeyRoundIcon />}>Use an API key…</SettingsMenuItem> }],
    ...server.auth?.kind === "oauth" ? [{ id: "sign-out", content: <SettingsMenuItem icon={<KeyRoundOffIcon />}>Sign out</SettingsMenuItem> }] : [],
    { id: "remove", content: <SettingsMenuItem icon={<Trash2Icon />} danger>Remove server</SettingsMenuItem> },
  ];
  return <WorkbenchSettingsStatusRow tone={tone}
    label={<FlushInput ariaLabel="Server name" value={server.name} disabled={busy}
      className="-mx-1 rounded-md px-1 hover:bg-fg/5 focus:bg-fg/8"
      onCommit={name => { void controller.update({ action: "rename", id: server.id, name }); }} />} status={status}
    detail={`${sourceDetail(server.source)}${server.projectId && !projectNamed ? " · for a project not in the sidebar" : ""}`}
    error={server.catalog.status === "error" ? server.catalog.detail : ""}
    body={<>
      {keyOpen ? <ApiKeyFields server={server} controller={controller} busy={busy} onDone={() => setKeyOpen(false)} /> : null}
      {launchOpen && isStdio(server.source) ? <LaunchSettings server={server} source={server.source} controller={controller}
        busy={busy} daemon={daemon} onDone={() => setLaunchOpen(false)} /> : null}
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
        else if (id === "launch") setLaunchOpen(true);
        else if (id === "remove-key") void controller.update({ action: "setAuth", id: server.id, auth: null });
        else if (id === "sign-out") void controller.update({ action: "signOut", id: server.id });
        else if (id === "remove") void controller.update({ action: "remove", id: server.id });
      }}>
      <MoreVerticalIcon className="size-4" />
    </PressDragMenu>
  </WorkbenchSettingsStatusRow>;
}

type AddMode = "http" | "npm" | "cli";

const addModes = {
  http: { label: "http", inputLabel: "MCP server URL", placeholder: "http://example.com/mcp" },
  npm: { label: "npm", inputLabel: "npm package and arguments", placeholder: "@org/package p1 p2" },
  cli: { label: "cli", inputLabel: "Command and arguments", placeholder: "path/to/cli p1 p2" },
} satisfies Record<AddMode, { label: string; inputLabel: string; placeholder: string }>;

type AddUpdate = Extract<McpServerSettingsUpdate, { action: "add" | "addPackage" | "addCommand" }>;

/** The update one typed draft would send, or why it can't be sent yet. */
function addUpdate(mode: AddMode, draft: string, projectId: string | null): { update: AddUpdate } | { error: string } | null {
  if (!draft.trim()) return null;
  const scope = projectId ? { projectId } : {};
  if (mode === "http") return { update: { action: "add", url: draft.trim(), ...scope } };
  if (mode === "npm") {
    const parsed = parseMcpPackageCommand(draft);
    return "error" in parsed ? parsed : { update: { action: "addPackage", ...parsed.command, ...scope } };
  }
  const parsed = parseMcpCliCommand(draft);
  return "error" in parsed ? parsed : { update: { action: "addCommand", ...parsed.command, ...scope } };
}

function sourceDetail(source: McpServerSnapshot["source"]) {
  if (source.kind === "http") return source.url.replace(/^https?:\/\//u, "");
  const program = source.kind === "npm" ? `${source.package}@${source.version}` : formatMcpPackageArgs([source.command]);
  return [source.kind, program, formatMcpPackageArgs(source.args)].filter(Boolean).join(" ");
}

/**
 * The last card in a scope's list: type a server, pick its kind, then Add (or hold Install, since npm downloads and runs a
 * package's code). One row that wraps the kind and button under the field when narrow.
 */
function AddServerCard({ controller, busy, projectId, onAdded }: {
  controller: McpServerSettingsController;
  busy: boolean;
  /** The project the added server belongs to; null for every project. */
  projectId: string | null;
  /** Ids of servers that appeared because of this add. */
  onAdded: (ids: string[]) => void;
}) {
  const [mode, setMode] = useState<AddMode>("http");
  // Each mode keeps its own draft, so peeking at another mode loses nothing.
  const [drafts, setDrafts] = useState<Record<AddMode, string>>({ http: "", npm: "", cli: "" });
  const [adding, setAdding] = useState(false);
  const draft = drafts[mode];
  const next = addUpdate(mode, draft, projectId);
  const npm = mode === "npm";
  return <div className="py-1">
    <form className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[0.95rem] border ${cardBorder} py-1.5 pl-3 pr-1.5`} onSubmit={event => {
      event.preventDefault();
      if (!next || !("update" in next)) return;
      const before = new Set(controller.getSnapshot().settings?.servers.map(server => server.id));
      const addedMode = mode;
      setAdding(true);
      void controller.update(next.update).then(added => {
        setAdding(false);
        if (!added) return;
        setDrafts(current => ({ ...current, [addedMode]: "" }));
        onAdded(controller.getSnapshot().settings?.servers.filter(server => !before.has(server.id)).map(server => server.id) ?? []);
      });
    }}>
      <div className="flex min-w-0 flex-[1_1_14rem] items-center gap-2">
        <PlusIcon className="size-4 shrink-0 text-fg/muted" />
        <input className="min-w-0 flex-1 bg-transparent py-1.5 text-[0.86em] text-text outline-none placeholder:text-fg/muted"
          aria-label={addModes[mode].inputLabel} placeholder={addModes[mode].placeholder} autoComplete="off" spellCheck={false}
          aria-invalid={next !== null && "error" in next} disabled={busy} value={draft}
          onChange={event => { const value = event.target.value; setDrafts(current => ({ ...current, [mode]: value })); }} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <RadioRow<AddMode> ariaLabel="Server type" value={mode} disabled={busy} onChange={setMode}
          options={(Object.keys(addModes) as AddMode[]).map(value => ({ value, label: addModes[value].label }))} />
        <PrimaryButton type="submit" shape="compact" disabled={busy || !next || "error" in next} pendingHalo={adding}
          {...npm ? { tone: "danger", holdToConfirmMs: 1000, title: "Hold to install and run this npm package on this computer" } : {}}>
          <IconLabel icon={npm ? <DownloadIcon size={14} /> : <SparklesIcon size={14} />}>{npm ? "Install" : "Add"}</IconLabel>
        </PrimaryButton>
      </div>
    </form>
    {next && "error" in next ? <p className="m-0 px-3 pt-1.5 text-[0.78em] leading-[1.55] text-fg/muted">{next.error}</p> : null}
  </div>;
}

export default function McpServerSettings({ daemon, daemonId, projects }: {
  daemon: WorkbenchDaemonClient;
  daemonId: string;
  /** This machine's projects, by daemon project id, that can have their own servers. */
  projects: readonly ProjectScopedSettingsProject<string>[];
}) {
  const rpc = useWorkbenchAppRpc();
  const controller = useMemo(() => new McpServerSettingsController({
    daemonId,
    read: () => daemon.mcpServers.read({ configuredOnly: true }),
    readServer: id => daemon.mcpServers.read({ id }),
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
  const servers = state.settings?.servers ?? [];
  const pending = servers.filter(server => isUnchecked(server.catalog)).length;
  // Only servers added from this view animate in; ones already present on load render still.
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set());
  const scopedProjectIds = [...new Set(servers.flatMap(server => server.projectId ? [server.projectId] : []))];
  // A project this view cannot name (not in the sidebar) still lists its servers with the defaults, so they stay removable.
  const scopeOf = (server: McpServerSnapshot) => server.projectId && projects.some(project => project.id === server.projectId)
    ? server.projectId : null;
  return <>
    <ProjectScopedSettingsSection id="settings-mcp-servers" title="MCP servers" addLabel="Add project-specific servers"
      defaultLabel="All projects" projects={projects} scopedProjectIds={scopedProjectIds}
      renderScope={projectId => <div className="flex flex-col">
        {servers.filter(server => scopeOf(server) === projectId).map(server =>
          <div key={server.id} className={entering.has(server.id) ? enterMotionClassName : ""}>
            <ServerCard server={server} controller={controller} busy={state.busy} loopbackOrigin={state.loopbackOrigin} daemon={daemon}
              projectNamed={scopeOf(server) !== null} />
          </div>)}
        <AddServerCard controller={controller} busy={state.busy} projectId={projectId} onAdded={ids => setEntering(new Set(ids))} />
      </div>} />
    {!state.settings && state.busy ? <p role="status" className="m-0 px-3 pb-2 text-[0.78em] leading-[1.55] text-fg/muted">Loading MCP servers...</p> : null}
    {pending ? <p role="status" className="m-0 px-3 pb-2 text-[0.78em] leading-[1.55] text-fg/muted">
      Checking servers: {servers.length - pending} of {servers.length} complete
    </p> : null}
    {state.error ? <p role="alert" className="m-0 px-3 text-[0.78em] leading-[1.55] text-danger">{state.error}</p> : null}
  </>;
}
