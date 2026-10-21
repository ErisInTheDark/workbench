/*
 * Exports:
 * - default WorkbenchProviderSettings: one row per provider on the selected daemon: install its Workbench-managed runtime when it has one,
 *   then sign its accounts in and out.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { installedProviderKeys, type WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import {
  ProviderRuntimeKeySchema, type ProviderRuntimeKey, type ProviderRuntimeStatus, type ProviderRuntimesSnapshot,
} from "workbench-shared/workbench/provider/provider-runtime";
import ProviderAccountController, { type ProviderAccountState } from "../../workbench/ProviderAccountController";
import IconButton, { iconButtonClassName } from "../ui/IconButton";
import PressDragMenu from "../ui/PressDragMenu";
import PrimaryButton from "../ui/PrimaryButton";
import ProviderSignInPanel, { type ProviderKeyTarget } from "./ProviderSignInPanel";
import { IconLabel, SettingsMenuItem } from "./settings-row-labels";
import { KeyRoundIcon, KeyRoundOffIcon, MoreVerticalIcon, RefreshCwIcon } from "./workbench-icons";
import WorkbenchSettingsStatusRow, { type WorkbenchSettingsStatusTone } from "./WorkbenchSettingsStatusRow";

const labels: Record<WorkbenchProviderKey, string> = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };

interface RowView { tone: WorkbenchSettingsStatusTone; status: string; detail: string }

/** The provider's Workbench-installed runtime key, or null when it ships with the checkout. */
function runtimeKey(provider: WorkbenchProviderKey): ProviderRuntimeKey | null {
  const parsed = ProviderRuntimeKeySchema.safeParse(provider);
  return parsed.success ? parsed.data : null;
}

function failureMessage(failure: unknown, fallback: string) {
  return (failure instanceof Error ? failure.message : fallback).slice(0, 500);
}

function runtimeView(status: ProviderRuntimeStatus, installing: boolean): RowView & { action: string | null } {
  const label = labels[status.provider];
  if (installing || status.state === "installing") {
    return { tone: "pending", status: "Installing", detail: `Downloading ${label} ${status.version} onto this daemon...`, action: null };
  }
  switch (status.state) {
    case "ready":
      return { tone: "ready", status: `Ready · ${status.version}`, detail: `Threads use Workbench's pinned ${label} build.`, action: null };
    case "missing":
      return status.installedVersion
        ? { tone: "action", status: "Update needed", detail: `${status.installedVersion} is installed; this Workbench needs ${status.version}.`, action: "Update" }
        : { tone: "action", status: "Not installed", detail: `Install ${label} ${status.version} to use it in threads on this daemon.`, action: "Install" };
    case "failed":
      return { tone: "failed", status: "Install failed", detail: status.error ?? "The install failed. See the daemon log.", action: "Retry" };
    case "unsupported":
      return { tone: "failed", status: "Unsupported", detail: status.error ?? `${label} has no build for this daemon's platform.`, action: null };
  }
}

function accountView(provider: WorkbenchProviderKey, account: ProviderAccountState, runtime: ProviderRuntimeStatus | null): RowView {
  const label = labels[provider];
  const build = runtime ? ` · ${runtime.version}` : "";
  const primary = account.snapshot?.integrations.find(integration => integration.primary) ?? null;
  if (account.snapshot?.attempt?.state === "pending") {
    return { tone: "pending", status: "Signing in", detail: `Finish signing in to ${label} below.` };
  }
  if (!account.snapshot) {
    return account.error
      ? { tone: "failed", status: "Check failed", detail: `Couldn't check ${label}'s sign-in on this daemon.` }
      : { tone: "pending", status: "Checking", detail: `Checking ${label}'s sign-in...` };
  }
  if (primary?.signedIn) {
    return { tone: "ready", status: `Signed in${build}`, detail: primary.accountLabel ? `Signed in as ${primary.accountLabel}.` : `Threads use this daemon's ${label} sign-in.` };
  }
  return { tone: "action", status: `Not signed in${build}`, detail: `Sign in to use ${label} in threads on this daemon.` };
}

function useProviderRuntimes(daemon: WorkbenchDaemonClient) {
  const [snapshot, setSnapshot] = useState<ProviderRuntimesSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState<ReadonlySet<ProviderRuntimeKey>>(() => new Set());
  const [error, setError] = useState("");
  /** Newer reads and settled installs invalidate older in-flight reads. */
  const generation = useRef(0);
  const mounted = useRef(true);

  const check = useCallback(() => {
    const current = ++generation.current;
    setChecking(true);
    setError("");
    void daemon.providerRuntimes.read().then(next => {
      if (current === generation.current) setSnapshot(next);
    }).catch((failure: unknown) => {
      if (current === generation.current) setError(failureMessage(failure, "Runtime check failed."));
    }).finally(() => {
      if (current === generation.current) setChecking(false);
    });
  }, [daemon]);

  const settle = useCallback((provider: ProviderRuntimeKey) => {
    setInstalling(current => {
      const next = new Set(current);
      next.delete(provider);
      return next;
    });
  }, []);

  /** Starts or joins the daemon-owned install; the daemon keeps going if this view closes. */
  const install = useCallback((provider: ProviderRuntimeKey) => {
    setInstalling(current => new Set(current).add(provider));
    setError("");
    void daemon.providerRuntimes.install(provider).then(next => {
      if (!mounted.current) return;
      generation.current++;
      setSnapshot(next);
      setChecking(false);
      settle(provider);
    }).catch(() => {
      // A dropped socket doesn't stop the daemon's install; reread its real state instead of reporting failure.
      if (!mounted.current) return;
      settle(provider);
      check();
    });
  }, [check, daemon, settle]);

  useEffect(() => {
    mounted.current = true;
    check();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [check]);

  // Follow installs started elsewhere (another tab, or the daemon updating a stale runtime) until they settle.
  // Keyed to each new snapshot, so a failed join never re-joins until a fresh read confirms the install.
  const followed = useRef<ProviderRuntimesSnapshot | null>(null);
  useEffect(() => {
    if (!snapshot || followed.current === snapshot) return;
    followed.current = snapshot;
    for (const status of snapshot.data) {
      if (status.state === "installing" && !installing.has(status.provider)) install(status.provider);
    }
  }, [install, installing, snapshot]);

  return { snapshot, checking, installing, error, check, install };
}

function ProviderRow({ provider, runtime, installing, checking, account, controller, onInstall, onRecheck }: {
  provider: WorkbenchProviderKey;
  /** Null for providers without a Workbench-installed runtime. */
  runtime: ProviderRuntimeStatus | null;
  installing: boolean;
  checking: boolean;
  account: ProviderAccountState;
  controller: ProviderAccountController;
  onInstall: () => void;
  onRecheck: () => void;
}) {
  const [keyTarget, setKeyTarget] = useState<ProviderKeyTarget | null>(null);
  const label = labels[provider];
  const runtimeReady = !runtime || (runtime.state === "ready" && !installing);
  const recheck = <IconButton display="hover-border" size="small" label={checking ? `Checking ${label}` : `Recheck ${label}`}
    disabled={checking} aria-busy={checking} onClick={onRecheck}>
    <RefreshCwIcon className={`size-4 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`} />
  </IconButton>;
  if (!runtimeReady && runtime) {
    const view = runtimeView(runtime, installing);
    return <WorkbenchSettingsStatusRow label={label} tone={view.tone} status={view.status} detail={view.detail}>
      {view.action ? <PrimaryButton shape="compact" onClick={onInstall}>{view.action}</PrimaryButton> : null}
      {recheck}
    </WorkbenchSettingsStatusRow>;
  }
  const { snapshot, busy } = account;
  const primary = snapshot?.integrations.find(integration => integration.primary) ?? null;
  const attempt = snapshot?.attempt ?? null;
  const pending = attempt?.state === "pending";
  const [signInMethod, ...otherMethods] = primary?.methods.filter(method => method.kind === "browser") ?? [];
  const keyMethods = primary?.methods.filter(method => method.kind === "key") ?? [];
  const menu = primary ? [
    ...otherMethods.map(method => ({
      id: `browser:${method.id}`,
      content: <SettingsMenuItem icon={<KeyRoundIcon />}>Sign in with {method.label}</SettingsMenuItem>,
    })),
    ...keyMethods.map(method => ({
      id: `key:${method.id}`,
      content: <SettingsMenuItem icon={<KeyRoundIcon />}>{keyMethods.length > 1 ? `Use ${method.label}…` : "Use an API key…"}</SettingsMenuItem>,
    })),
    ...primary.signedIn ? [{ id: "sign-out", content: <SettingsMenuItem icon={<KeyRoundOffIcon />}>Sign out</SettingsMenuItem> }] : [],
  ] : [];
  const view = accountView(provider, account, runtime);
  const error = account.error || (attempt?.state === "failed" ? attempt.error ?? "" : "");
  return <WorkbenchSettingsStatusRow label={label} tone={view.tone} status={view.status} detail={view.detail} error={error}
    body={<ProviderSignInPanel provider={provider} controller={controller} busy={busy} attempt={attempt}
      integrations={snapshot?.integrations.filter(integration => !integration.primary) ?? []}
      keyTarget={keyTarget} onKey={setKeyTarget} onKeyDone={() => setKeyTarget(null)} />}>
    {primary && signInMethod && !primary.signedIn && !pending ? <PrimaryButton shape="compact" disabled={busy}
      onClick={() => { void controller.start(provider, primary.id, signInMethod.id); }}>
      <IconLabel icon={<KeyRoundIcon size={14} />}>Sign in</IconLabel>
    </PrimaryButton> : null}
    {recheck}
    {menu.length ? <PressDragMenu label={`More for ${label}`} items={menu} align="end" disabled={busy || pending}
      triggerAppearance="plain" triggerClassName={iconButtonClassName({ size: "small", display: "hover-border" })}
      onSelect={id => {
        if (!primary) return;
        const [kind, methodId] = id.split(":", 2) as [string, string | undefined];
        if (kind === "sign-out") void controller.signOut(provider, primary.id);
        else if (kind === "browser" && methodId) void controller.start(provider, primary.id, methodId);
        else if (kind === "key" && methodId) {
          const method = keyMethods.find(candidate => candidate.id === methodId);
          setKeyTarget({ integrationId: primary.id, methodId, label: `${primary.label} ${method?.label ?? "API key"}` });
        }
      }}>
      <MoreVerticalIcon className="size-4" />
    </PressDragMenu> : null}
  </WorkbenchSettingsStatusRow>;
}

export default function WorkbenchProviderSettings({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const runtimes = useProviderRuntimes(daemon);
  const accounts = useMemo(() => new ProviderAccountController(daemon.providerAccounts), [daemon]);
  useEffect(() => () => accounts.dispose(), [accounts]);
  const states = useSyncExternalStore(accounts.subscribe, accounts.getSnapshot, accounts.getSnapshot);
  const runtimeOf = (provider: WorkbenchProviderKey) => {
    const key = runtimeKey(provider);
    return key ? runtimes.snapshot?.data.find(status => status.provider === key) ?? null : null;
  };
  // Accounts are read through each provider's own executable, so runtime providers wait until theirs is ready.
  const readyKey = installedProviderKeys.filter(provider => {
    const key = runtimeKey(provider);
    return !key || (runtimeOf(provider)?.state === "ready" && !runtimes.installing.has(key));
  }).join(",");
  useEffect(() => {
    for (const provider of readyKey ? readyKey.split(",") : []) void accounts.refresh(provider);
  }, [accounts, readyKey]);
  const recheck = (provider: WorkbenchProviderKey) => {
    runtimes.check();
    if (readyKey.split(",").includes(provider)) void accounts.refresh(provider);
  };

  if (!runtimes.snapshot) {
    return <WorkbenchSettingsStatusRow label="Providers" tone={runtimes.error ? "failed" : "pending"}
      status={runtimes.error ? "Check failed" : "Checking"} detail="Checking this daemon's providers..." error={runtimes.error}>
      <IconButton display="hover-border" size="small" label="Recheck providers"
        disabled={runtimes.checking} aria-busy={runtimes.checking} onClick={runtimes.check}>
        <RefreshCwIcon className={`size-4 ${runtimes.checking ? "animate-spin motion-reduce:animate-none" : ""}`} />
      </IconButton>
    </WorkbenchSettingsStatusRow>;
  }
  return <>
    {installedProviderKeys.map(provider => {
      const key = runtimeKey(provider);
      return <ProviderRow key={provider} provider={provider} runtime={runtimeOf(provider)}
        installing={key !== null && runtimes.installing.has(key)} checking={runtimes.checking}
        account={states[provider] ?? accounts.state(provider)} controller={accounts}
        onInstall={() => { if (key) runtimes.install(key); }} onRecheck={() => recheck(provider)} />;
    })}
    {runtimes.error ? <p role="alert" className="m-0 px-3 text-[0.78em] leading-[1.55] text-danger">{runtimes.error}</p> : null}
  </>;
}
