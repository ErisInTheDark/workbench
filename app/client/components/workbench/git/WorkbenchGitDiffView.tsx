/* Exports: default WorkbenchGitDiffView: the focused file's sticky path and layout controls over its text, markdown or image diff. */
"use client";
import { useEffect, useState } from "react";
import RadioRow from "../../ui/RadioRow";
import TooltipIconButton from "../../ui/TooltipIconButton";
import { PilcrowIcon, RefreshCwIcon } from "../workbench-icons";
import { useGitChangeset } from "./WorkbenchGitChangesetProvider";
import WorkbenchGitImageDiff from "./WorkbenchGitImageDiff";
import WorkbenchGitMarkdownDiff from "./WorkbenchGitMarkdownDiff";
import WorkbenchGitTextDiff from "./WorkbenchGitTextDiff";

type Layout = "unified" | "split" | "markdown";
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/iu;
const MARKDOWN = /\.(?:md|markdown|mdown|mkd|mkdn|mdx)$/iu;

/** One layout and whitespace choice for every diff in this browser tab, kept across files and git tabs. */
const preference = { layout: "unified" as Layout, whitespace: false };

export default function WorkbenchGitDiffView() {
  const { changeset, snapshot } = useGitChangeset();
  const [layout, setLayout] = useState<Layout>(preference.layout);
  const [whitespace, setWhitespace] = useState(preference.whitespace);
  const file = changeset.file;
  const image = IMAGE.test(file?.path ?? "");
  const markdown = MARKDOWN.test(file?.path ?? "");
  const mode = !markdown && layout === "markdown" ? "unified" : layout;
  const needsPreview = image || mode === "markdown";
  useEffect(() => {
    if (snapshot.contentStatus === "ready" && !snapshot.contentError && needsPreview) void changeset.loadPreview();
  }, [changeset, snapshot.contentStatus, snapshot.contentError, file?.identity, needsPreview]);
  if (!file) return null;
  const loading = snapshot.contentStatus === "loading"
    || (snapshot.contentStatus === "ready" && needsPreview && !snapshot.preview && !snapshot.contentError);
  const slash = file.path.lastIndexOf("/");
  return <section className="min-w-0" aria-busy={loading}>
    <div className="sticky top-0 z-10 flex min-h-11 items-center gap-2 pb-2 text-sm">
      <span className="pointer-events-none absolute -inset-x-2 inset-y-0 -z-10 bg-[linear-gradient(to_bottom,var(--app-bg-solid)_75%,transparent)]" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {file.oldPath ? <span className="text-fg/muted">{file.oldPath} → </span> : null}
        <span className="text-fg/muted">{slash >= 0 ? file.path.slice(0, slash + 1) : ""}</span>
        <span className="text-text">{file.path.slice(slash + 1)}</span>
      </span>
      {!image ? <>
        <RadioRow ariaLabel="Diff layout" value={mode} onChange={value => { preference.layout = value; setLayout(value); }} options={[
          { value: "unified", label: "Unified", icon: null },
          { value: "split", label: "Split", icon: null },
          ...markdown ? [{ value: "markdown" as const, label: "Rendered", icon: null }] : [],
        ]} />
        {mode !== "markdown" ? <TooltipIconButton size="small" aria-pressed={whitespace} className="aria-pressed:bg-fg/8"
          label="Whitespace changes" tooltip={whitespace ? "Hide whitespace changes" : "Show whitespace changes"}
          onClick={() => { preference.whitespace = !whitespace; setWhitespace(!whitespace); }}>
          <PilcrowIcon size={16} />
        </TooltipIconButton> : null}
      </> : null}
    </div>
    {snapshot.contentError ? <div role="alert" className="flex items-center gap-2 py-3 text-sm text-danger">
      <span className="min-w-0 flex-1">{snapshot.contentError}</span>
      <TooltipIconButton size="small" label="Retry" onClick={() => { void changeset.loadContent(); }}><RefreshCwIcon size={16} /></TooltipIconButton>
    </div> : null}
    {loading ? <div role="status" aria-label="Loading diff" className="space-y-3 py-3">
      {Array.from({ length: 10 }, (_, index) => <div key={index} className="flex gap-4" aria-hidden="true">
        <span className="h-3 w-16 shrink-0 rounded workbench-skeleton" />
        <span className="h-3 rounded workbench-skeleton" style={{ width: `${[62, 78, 45, 70, 36][index % 5]}%` }} />
      </div>)}
    </div>
      : image ? <WorkbenchGitImageDiff key={`${snapshot.rootId}:${file.identity}`} />
        : mode === "markdown" ? <WorkbenchGitMarkdownDiff />
          : snapshot.diff?.unavailable ? <p className="py-4 text-sm text-fg/muted">{snapshot.diff.unavailable}</p>
            : snapshot.diff ? <WorkbenchGitTextDiff key={`${snapshot.rootId}:${file.identity}:${mode}:${whitespace}`}
              mode={mode} whitespace={whitespace} onShowWhitespace={() => { preference.whitespace = true; setWhitespace(true); }} />
              : null}
  </section>;
}
