/*
 * Exports:
 * - WorkbenchGitObject: what a git tab shows: the working tree's changes, one commit or one stash.
 * - WorkbenchGitTarget: a git tab's own folder, object and optional focused file; its namespace formats and parses one
 *   as the tab segments after `git` and compares objects.
 */
import { encodeWorkbenchRoutePath } from "../../navigation/workbench-route-path.ts";

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export type WorkbenchGitObject =
  | { kind: "changes" }
  | { kind: "commit"; sha: string }
  | { kind: "stash"; sha: string };

export interface WorkbenchGitTarget {
  /** The tab's own folder; null means the route's sidebar folder. */
  folderAddress: readonly string[] | null;
  object: WorkbenchGitObject;
  /** The focused file within the object, or null for its first file. */
  path: string | null;
}

export namespace WorkbenchGitTarget {
  export const changes: WorkbenchGitObject = { kind: "changes" };

  export function isObjectId(value: string) {
    return OBJECT_ID.test(value);
  }

  /** Segments after `git`, URL-encoded: `[folder.../<marker>/]changes|commit/<sha>|stash/<sha>[/path...]`. */
  export function format(target: WorkbenchGitTarget, marker: string) {
    const folder = target.folderAddress?.length
      ? `${target.folderAddress.map(encodeURIComponent).join("/")}/${marker}/` : "";
    const object = target.object.kind === "changes" ? "changes" : `${target.object.kind}/${target.object.sha}`;
    return `${folder}${object}${target.path ? `/${encodeWorkbenchRoutePath(target.path)}` : ""}`;
  }

  /** Decoded segments after `git`; null when they do not name a target. */
  export function parse(segments: readonly string[], marker: string): WorkbenchGitTarget | null {
    const at = segments.indexOf(marker);
    const folderAddress = at < 0 ? null : segments.slice(0, at);
    if (folderAddress?.length === 0) return null;
    const [kind, ...rest] = at < 0 ? segments : segments.slice(at + 1);
    let object: WorkbenchGitObject;
    let pathSegments: readonly string[];
    if (kind === "changes") {
      object = changes;
      pathSegments = rest;
    } else if ((kind === "commit" || kind === "stash") && rest[0] && isObjectId(rest[0])) {
      object = { kind, sha: rest[0] };
      pathSegments = rest.slice(1);
    } else return null;
    return { folderAddress, object, path: pathSegments.length ? pathSegments.join("/") : null };
  }

  export function sameObject(left: WorkbenchGitObject, right: WorkbenchGitObject) {
    if (left.kind === "changes" || right.kind === "changes") return left.kind === right.kind;
    return left.kind === right.kind && left.sha === right.sha;
  }
}
