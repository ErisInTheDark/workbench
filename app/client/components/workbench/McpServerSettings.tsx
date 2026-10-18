/*
 * Exports:
 * - default McpServerSettings: one daemon's user-added MCP servers; add by URL with an optional credential header, then allow tools one by one or all at once.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { McpServerSnapshot } from "workbench-shared/workbench/mcp/mcp-server-settings";
import McpServerSettingsController from "../../workbench/McpServerSettingsController";
import IconButton from "../ui/IconButton";
import { OptionCard } from "../ui/OptionCards";
import PrimaryButton from "../ui/PrimaryButton";
import WorkbenchTextField from "./WorkbenchTextField";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "./workbench-icons";

type Credential = { header: string; value: string };

/** Header name and value; both empty means no credential, and only both together form one. */
function CredentialFields({ credential, onChange, disabled }: {
  credential: Credential;
  onChange: (credential: Credential) => void;
  disabled: boolean;
}) {
  return <div className="flex flex-wrap gap-2">
    <WorkbenchTextField className="w-56 font-mono placeholder:font-sans" aria-label="Credential header name"
      placeholder="Header, e.g. x-consumer-api-key" autoComplete="off" spellCheck={false} disabled={disabled}
      value={credential.header} onChange={event => onChange({ ...credential, header: event.target.value })} />
    <WorkbenchTextField className="min-w-48 flex-1 font-mono placeholder:font-sans" aria-label="Credential value"
      placeholder="Value" type="password" autoComplete="off" spellCheck={false} disabled={disabled}
      value={credential.value} onChange={event => onChange({ ...credential, value: event.target.value })} />
  </div>;
}

function readCredential(credential: Credential): { auth: Credential | undefined } | { error: string } {
  const header = credential.header.trim();
  const value = credential.value.trim();
  if (!header && !value) return { auth: undefined };
  if (!header || !value) return { error: "Enter both the credential header name and its value." };
  return { auth: { header, value } };
}

const EMPTY_CREDENTIAL: Credential = { header: "", value: "" };

function AddServer({ controller, busy }: { controller: McpServerSettingsController; busy: boolean }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState(EMPTY_CREDENTIAL);
  const [error, setError] = useState("");
  async function add() {
    const read = readCredential(credential);
    if ("error" in read) return setError(read.error);
    setError("");
    if (await controller.update({ action: "add", name: name.trim(), url: url.trim(), ...read.auth ? { auth: read.auth } : {} })) {
      setName("");
      setUrl("");
      setCredential(EMPTY_CREDENTIAL);
    }
  }
  return <form className="grid gap-2 rounded-[0.8rem] border border-dashed border-text/16 p-3"
    onSubmit={event => { event.preventDefault(); void add(); }}>
    <div className="flex flex-wrap gap-2">
      <WorkbenchTextField className="w-40 font-mono placeholder:font-sans" aria-label="MCP server name" placeholder="Name, e.g. composio"
        autoComplete="off" spellCheck={false} disabled={busy} value={name} onChange={event => setName(event.target.value)} />
      <WorkbenchTextField className="min-w-56 flex-1 font-mono placeholder:font-sans" aria-label="MCP server URL"
        placeholder="https://connect.composio.dev/mcp" autoComplete="off" spellCheck={false} disabled={busy}
        value={url} onChange={event => setUrl(event.target.value)} />
    </div>
    <CredentialFields credential={credential} onChange={setCredential} disabled={busy} />
    <div className="flex items-center gap-2">
      <PrimaryButton type="submit" shape="compact" disabled={busy || !name.trim() || !url.trim()}>
        <PlusIcon size={14} /> Add server
      </PrimaryButton>
      {error ? <span role="alert" className="text-xs text-danger">{error}</span> : null}
    </div>
  </form>;
}

function ServerCredential({ server, controller, busy }: { server: McpServerSnapshot; controller: McpServerSettingsController; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [credential, setCredential] = useState<Credential>({ header: server.auth?.header ?? "", value: "" });
  const [error, setError] = useState("");
  async function save() {
    const read = readCredential(credential);
    if ("error" in read) return setError(read.error);
    if (!read.auth) return setError("Enter the credential header name and its value.");
    setError("");
    if (await controller.update({ action: "setAuth", id: server.id, auth: read.auth })) setEditing(false);
  }
  if (!editing) {
    return <div className="flex flex-wrap items-center gap-2 text-[0.8rem] text-fg/muted">
      <span>{server.auth ? <>Credential sent in <code>{server.auth.header}</code></> : "No credential"}</span>
      <button type="button" className="text-text underline-offset-2 hover:underline disabled:opacity-50" disabled={busy}
        onClick={() => { setCredential({ header: server.auth?.header ?? "", value: "" }); setEditing(true); }}>
        {server.auth ? "Replace" : "Add credential"}
      </button>
      {server.auth ? <button type="button" className="text-danger underline-offset-2 hover:underline disabled:opacity-50" disabled={busy}
        onClick={() => { void controller.update({ action: "setAuth", id: server.id, auth: null }); }}>Remove</button> : null}
    </div>;
  }
  return <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void save(); }}>
    <CredentialFields credential={credential} onChange={setCredential} disabled={busy} />
    <div className="flex items-center gap-3 text-[0.8rem]">
      <PrimaryButton type="submit" shape="compact" disabled={busy}>Save credential</PrimaryButton>
      <button type="button" className="text-fg/muted hover:text-text" onClick={() => setEditing(false)}>Cancel</button>
      {error ? <span role="alert" className="text-xs text-danger">{error}</span> : null}
    </div>
  </form>;
}

function ServerTools({ server, controller, busy }: { server: McpServerSnapshot; controller: McpServerSettingsController; busy: boolean }) {
  const offered = server.catalog.status === "ready" ? server.catalog.tools : [];
  // Allowed tools the server stopped offering stay listed so they can be unticked.
  const stale = server.allowedTools.filter(name => !offered.some(tool => tool.name === name)).map(name => ({ name, description: "" }));
  const toggle = (name: string) => {
    const tools = server.allowedTools.includes(name)
      ? server.allowedTools.filter(tool => tool !== name)
      : [...server.allowedTools, name];
    void controller.update({ action: "setTools", id: server.id, tools });
  };
  return <div className="grid gap-1">
    <OptionCard label="Allow all tools" density="tight" isSingleChoice={false} isChecked={server.allowAll} disabled={busy}
      description="Includes tools the server adds later."
      onClick={() => { void controller.update({ action: "setAllowAll", id: server.id, allowAll: !server.allowAll }); }} />
    {[...offered, ...stale].map(tool => {
      const isStale = !offered.includes(tool);
      return <OptionCard key={tool.name} density="tight" isSingleChoice={false} disabled={busy || server.allowAll}
        isChecked={server.allowAll || server.allowedTools.includes(tool.name)}
        label={<span className="font-mono text-[0.82rem]">{tool.name}</span>}
        description={isStale ? "No longer offered by the server." : tool.description.split(/\r?\n/u)[0] ?? ""}
        onClick={() => toggle(tool.name)} />;
    })}
  </div>;
}

function ServerRow({ server, controller, busy }: { server: McpServerSnapshot; controller: McpServerSettingsController; busy: boolean }) {
  return <section className="grid gap-2 rounded-[0.8rem] border border-text/12 p-3" aria-label={`MCP server ${server.name}`}>
    <div className="flex min-w-0 items-center gap-2">
      <span className="font-mono text-[0.9rem] font-medium text-text">{server.name}</span>
      <span className="min-w-0 flex-1 truncate text-[0.8rem] text-fg/muted" title={server.url}>{server.url}</span>
      <IconButton type="button" size="small" display="hover-border" label={`Reconnect ${server.name}`} disabled={busy}
        onClick={() => { void controller.update({ action: "refresh", id: server.id }); }}>
        <RefreshCwIcon size={14} />
      </IconButton>
      <IconButton type="button" size="small" display="hover-border" tone="danger" label={`Remove ${server.name}`} disabled={busy}
        onClick={() => { void controller.update({ action: "remove", id: server.id }); }}>
        <Trash2Icon size={14} />
      </IconButton>
    </div>
    {server.catalog.status === "error" ? <p role="alert" className="m-0 text-xs text-danger">{server.catalog.detail}</p> : null}
    <ServerCredential key={server.auth?.header ?? ""} server={server} controller={controller} busy={busy} />
    <ServerTools server={server} controller={controller} busy={busy} />
  </section>;
}

export default function McpServerSettings({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const controller = useMemo(() => new McpServerSettingsController(daemon.mcpServers), [daemon]);
  useEffect(() => {
    void controller.refresh();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const servers = state.settings?.servers ?? [];
  return <div className="grid gap-3 py-1">
    <p className="m-0 text-detail text-fg/muted">
      Agents find allowed tools with <code>mcp_tools</code> and run them with <code>mcp_call</code>. Workbench supports streamable-HTTP servers with an optional credential header; OAuth sign-in isn&apos;t supported yet.
    </p>
    {servers.map(server => <ServerRow key={server.id} server={server} controller={controller} busy={state.busy} />)}
    <AddServer controller={controller} busy={state.busy} />
    {state.error ? <p role="alert" className="m-0 text-xs text-danger">{state.error}</p> : null}
  </div>;
}
