/*
 * Exports:
 * - default WorkbenchProjectLocationLabel: render a projected project folder address.
 */

export default function WorkbenchProjectLocationLabel({
  displayPath,
  hostname,
}: {
  displayPath: string;
  hostname: string;
}) {
  const daemonPrefix = `${hostname}:`;
  const qualified = displayPath.startsWith(daemonPrefix);
  const qualifiedPath = qualified ? displayPath.slice(daemonPrefix.length) : displayPath;
  const leadingSlash = qualified && qualifiedPath.startsWith("/") ? "/" : "";
  const path = leadingSlash ? qualifiedPath.slice(1) : qualifiedPath;
  const worktree = path.match(/^(.*\/)?(\+[^/]+)$/u);
  return (
    <span className="block min-w-0 truncate text-fg/80">
      {qualified ? <span className="font-normal text-fg/muted">{daemonPrefix}{leadingSlash}</span> : null}
      {worktree
        ? <>{worktree[1] ?? ""}<strong className="font-semibold text-text">{worktree[2]}</strong></>
        : path}
    </span>
  );
}
