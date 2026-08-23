/*
 * Exports:
 * - default ThreadReloadScopeList: render runtime reload scope barriers separately from file plans and claims. Keywords: thread, git, arc, reload, scope.
 */
import type { OrchestratorReloadScope } from "../../../lib/types";
import { GitArcReloadScopeIcon } from "./GitArcIcon";

export default function ThreadReloadScopeList({ scopes }: { scopes: readonly OrchestratorReloadScope[] }) {
  if (!scopes.length) return null;
  return (
    <div className="border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)] py-1.5" data-thread-reload-scopes="true">
      <div className="px-1 pb-1 text-[0.72em] font-medium uppercase tracking-[0.08em] text-muted">Runtime reload scopes</div>
      <div className="grid gap-0.5">
        {scopes.map((scope) => (
          <div className="flex min-w-0 items-center gap-2 px-1 py-0.5 text-[0.78em] leading-[1.45] text-muted" data-thread-reload-scope={scope} key={scope}>
            <GitArcReloadScopeIcon className="size-3.5 shrink-0" />
            <code className="min-w-0 truncate font-mono text-[0.95em] text-text">{scope}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
