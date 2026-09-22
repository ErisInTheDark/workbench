/*
 * Exports:
 * - default WorkbenchProjectDiscoverySettings: edit and save this daemon's ordered Git discovery folders.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProjectDiscoverySettingsResult } from "workbench-shared/workbench/project/project-discovery-settings";
import {
  blurProjectDiscoveryRow,
  createProjectDiscoveryRows,
  editProjectDiscoveryRow,
  populatedProjectDiscoveryRows,
  removeProjectDiscoveryRow,
} from "../../workbench/project-discovery-path-editor";
import InputList from "./InputList";
import { useWorkbenchDaemonClient } from "./WorkbenchDaemonClientContext";

const ISSUE_LABELS: Record<Extract<ProjectDiscoverySettingsResult, { accepted: false }>["issues"][number]["reason"], string> = {
  relative: "Enter an absolute folder path.",
  missing: "This folder does not exist or cannot be read.",
  "not-directory": "This path is not a folder.",
  duplicate: "This folder is already listed.",
};

function looksAbsolute (value: string) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value);
}

export default function WorkbenchProjectDiscoverySettings ({ onSaved }: { onSaved: () => Promise<void> }) {
  const daemon = useWorkbenchDaemonClient();
  const [savedPaths, setSavedPaths] = useState<string[]>([]);
  const [rows, setRows] = useState(() => createProjectDiscoveryRows([]));
  const [serverIssues, setServerIssues] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void daemon.projectDiscoverySettings.read().then(({ paths }) => {
      if (cancelled) return;
      setAvailable(true);
      setSavedPaths(paths);
      setRows(createProjectDiscoveryRows(paths));
      setServerIssues({});
      setLoading(false);
    }).catch((failure: Error) => {
      if (cancelled) return;
      setAvailable(false);
      setError(`Git roots are unavailable until a daemon is connected. ${failure.message}`);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [daemon, reloadKey]);

  const filled = useMemo(() => populatedProjectDiscoveryRows(rows), [rows]);
  const localIssues = useMemo(() => {
    const issues: Record<number, string> = {};
    const seen = new Set<string>();
    for (const row of filled) {
      if (!looksAbsolute(row.value)) {
        issues[row.id] = ISSUE_LABELS.relative;
        continue;
      }
      const key = row.value.replace(/\\/gu, "/").replace(/\/+$/gu, "").toLocaleLowerCase();
      if (seen.has(key)) issues[row.id] = ISSUE_LABELS.duplicate;
      seen.add(key);
    }
    return issues;
  }, [filled]);
  const paths = filled.map(row => row.value);
  const dirty = paths.length !== savedPaths.length || paths.some((value, index) => value !== savedPaths[index]);
  const blocked = loading || saving || !available || !dirty || Object.keys(localIssues).length > 0
    || filled.some(row => Boolean(serverIssues[row.id]));

  async function save () {
    if (blocked) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const result = await daemon.projectDiscoverySettings.update({ paths });
      if (!result.accepted) {
        setServerIssues(Object.fromEntries(result.issues.map(issue => [
          filled[issue.index]?.id ?? -1, ISSUE_LABELS[issue.reason],
        ])));
        return;
      }
      setSavedPaths(result.paths);
      setRows(createProjectDiscoveryRows(result.paths));
      setServerIssues({});
      setStatus("Git roots saved.");
      try {
        await onSaved();
      } catch (failure) {
        setError(failure instanceof Error ? `Git roots were saved, but the project list did not refresh: ${failure.message}` : "Git roots were saved, but the project list did not refresh.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to save Git roots.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 py-1">
      <div>
        <h3 className="m-0 text-[0.98rem] font-semibold leading-tight text-text">Git roots</h3>
        <p className="mt-1 text-[0.8rem] leading-5 text-fg/muted">Folders scanned for git repositories and workspaces.</p>
      </div>
      <InputList
        disabled={loading || saving || !available}
        idPrefix="git-root"
        onBlur={() => setRows(current => blurProjectDiscoveryRow(current))}
        onChange={(id, value) => {
          setRows(current => editProjectDiscoveryRow(current, id, value));
          setServerIssues(current => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          setStatus("");
        }}
        onRemove={id => {
          setRows(current => removeProjectDiscoveryRow(current, id));
          setServerIssues(current => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          setStatus("");
        }}
        placeholder="Absolute folder path"
        rows={rows.map((row, index) => ({
          id: row.id,
          label: `Git root ${index + 1}`,
          value: row.value,
          error: localIssues[row.id] ?? serverIssues[row.id],
        }))}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button className="rounded-lg px-3 py-1.5 text-[0.83rem] font-medium text-accent hover:bg-accent-soft disabled:opacity-40" disabled={blocked} onClick={() => { void save(); }} type="button">Save Git roots</button>
        <button
          className="rounded-lg px-3 py-1.5 text-[0.83rem] text-fg/muted hover:bg-surface-hover disabled:opacity-40"
          disabled={loading || saving || !available || !dirty}
          onClick={() => {
            setRows(createProjectDiscoveryRows(savedPaths));
            setServerIssues({});
            setError("");
            setStatus("");
          }}
          type="button"
        >Reset</button>
      </div>
      {error ? <p role="alert" className="m-0 text-[0.8rem] text-danger">{error}</p> : null}
      {!available && !loading ? <button className="rounded-lg px-3 py-1.5 text-[0.83rem] text-accent hover:bg-accent-soft" onClick={() => setReloadKey(value => value + 1)} type="button">Retry connection</button> : null}
      {status ? <p role="status" className="m-0 text-[0.8rem] text-fg/muted">{status}</p> : null}
    </section>
  );
}
