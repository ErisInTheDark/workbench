/*
 * Exports:
 * - default GitTreeObjects: tree diffs and path surgery in-process, reading through the operation's object reader and writing loose objects.
 * - GitTreeEntry: one raw tree entry; name bytes are kept so untouched entries re-serialise byte-for-byte.
 */
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import GitObjectReadSession from "./GitObjectReadSession";
import type GitObjectWriter from "./GitObjectWriter";

export interface GitTreeEntry {
  id: string;
  mode: string;
  name: string;
  nameBytes: Buffer;
}

/** A path's replacement entry, or null to remove it. */
export type GitTreeEdit = Pick<GitTreeEntry, "id" | "mode"> | null;

const TREE_MODE = "40000";

function isTree(entry: Pick<GitTreeEntry, "mode"> | null | undefined) {
  return entry?.mode === TREE_MODE;
}

/** Git orders tree entries by name bytes, comparing directories as if their names ended in `/`. */
function compareEntries(left: GitTreeEntry, right: GitTreeEntry) {
  const key = (entry: GitTreeEntry) => isTree(entry) ? Buffer.concat([entry.nameBytes, Buffer.from("/")]) : entry.nameBytes;
  return Buffer.compare(key(left), key(right));
}

function join(prefix: string, name: string) {
  return prefix ? `${prefix}/${name}` : name;
}

/** First entry per name, as `find` would return it. */
function entriesByName(entries: readonly GitTreeEntry[]) {
  const byName = new Map<string, GitTreeEntry>();
  for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry);
  return byName;
}

export default class GitTreeObjects {
  constructor(private readonly root: string, private readonly writer: GitObjectWriter) {}

  async emptyTree() {
    return await this.writer.writeObject("tree", Buffer.alloc(0));
  }

  async readTree(id: string): Promise<GitTreeEntry[]> {
    const [object] = await GitObjectReadSession.read(this.root, [id]);
    if (!object || object.type !== "tree" || !object.contents) throw new Error(`Git object ${id} is not a tree.`);
    const bytes = object.contents;
    const idBytes = id.length / 2;
    const entries: GitTreeEntry[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(0x20, offset);
      const nul = bytes.indexOf(0, space + 1);
      if (space < 0 || nul < 0 || nul + 1 + idBytes > bytes.length) throw new Error(`Git tree ${id} is malformed.`);
      const nameBytes = bytes.subarray(space + 1, nul);
      entries.push({
        id: bytes.subarray(nul + 1, nul + 1 + idBytes).toString("hex"),
        mode: bytes.subarray(offset, space).toString("ascii"),
        name: nameBytes.toString("utf8"),
        nameBytes: Buffer.from(nameBytes),
      });
      offset = nul + 1 + idBytes;
    }
    return entries;
  }

  async writeTree(entries: GitTreeEntry[]) {
    const sorted = [...entries].sort(compareEntries);
    return await this.writer.writeObject("tree", Buffer.concat(sorted.flatMap(entry => [
      Buffer.from(`${entry.mode} `, "ascii"), entry.nameBytes, Buffer.from([0]), Buffer.from(entry.id, "hex"),
    ])));
  }

  /**
   * Paths whose entries differ between two trees, as `git diff --name-only --no-renames` lists them: changed blobs,
   * modes and gitlinks, and every file on both sides of a file/directory swap. Only differing subtrees are read.
   */
  async changedPaths(from: string | null, to: string | null, scopes: readonly string[] = []) {
    const changed: string[] = [];
    // A directory may hold selected paths when it overlaps a scope; no scopes selects everything.
    const selection = scopes.length ? new GitArcPathSet(scopes) : null;
    const walk = async (left: string | null, right: string | null, prefix: string): Promise<void> => {
      if (left === right) return;
      const [leftEntries, rightEntries] = await Promise.all([left ? this.readTree(left) : [], right ? this.readTree(right) : []]);
      const byName = new Map<string, [GitTreeEntry | null, GitTreeEntry | null]>();
      for (const entry of leftEntries) byName.set(entry.name, [entry, null]);
      for (const entry of rightEntries) byName.set(entry.name, [byName.get(entry.name)?.[0] ?? null, entry]);
      const nested: Array<Promise<void>> = [];
      for (const [name, [before, after]] of byName) {
        if (before && after && before.id === after.id && before.mode === after.mode) continue;
        const entryPath = join(prefix, name);
        const beforeIsTree = isTree(before);
        const afterIsTree = isTree(after);
        if ((before && !beforeIsTree) || (after && !afterIsTree)) changed.push(entryPath);
        if ((beforeIsTree || afterIsTree) && (!selection || selection.overlaps(entryPath))) {
          nested.push(walk(beforeIsTree ? before!.id : null, afterIsTree ? after!.id : null, entryPath));
        }
      }
      await Promise.all(nested);
    };
    await walk(from, to, "");
    return changed;
  }

  /** The entries at each path (null when absent); paths name files, so directories read as absent. */
  async entriesAt(tree: string | null, paths: readonly string[]) {
    const found = new Map<string, GitTreeEdit>(paths.map(candidate => [candidate, null]));
    const walk = async (id: string, prefix: string, wanted: readonly string[]): Promise<void> => {
      const entries = entriesByName(await this.readTree(id));
      const nested = new Map<string, string[]>();
      for (const candidate of wanted) {
        const relative = prefix ? candidate.slice(prefix.length + 1) : candidate;
        const separator = relative.indexOf("/");
        const head = separator < 0 ? relative : relative.slice(0, separator);
        if (separator < 0) {
          const entry = entries.get(head);
          if (entry && !isTree(entry)) found.set(candidate, { id: entry.id, mode: entry.mode });
        } else {
          const children = nested.get(head);
          if (children) children.push(candidate);
          else nested.set(head, [candidate]);
        }
      }
      await Promise.all([...nested].map(async ([head, children]) => {
        const entry = entries.get(head);
        if (isTree(entry)) await walk(entry!.id, join(prefix, head), children);
      }));
    };
    if (tree && paths.length) await walk(tree, "", paths);
    return found;
  }

  /**
   * `base` with each edited file path replaced or removed, writing only the touched subtrees and pruning directories
   * left empty. A file edit at a path that `base` holds as a directory replaces that directory, and vice versa.
   */
  async withEdits(base: string | null, edits: ReadonlyMap<string, GitTreeEdit>) {
    const rewrite = async (id: string | null, prefix: string, scoped: ReadonlyMap<string, GitTreeEdit>): Promise<string | null> => {
      const entries = new Map((id ? await this.readTree(id) : []).map(entry => [entry.name, entry]));
      const direct = new Map<string, GitTreeEdit>();
      const nested = new Map<string, Map<string, GitTreeEdit>>();
      for (const [candidate, edit] of scoped) {
        const relative = prefix ? candidate.slice(prefix.length + 1) : candidate;
        const separator = relative.indexOf("/");
        if (separator < 0) direct.set(relative, edit);
        else {
          const head = relative.slice(0, separator);
          const group = nested.get(head) ?? new Map<string, GitTreeEdit>();
          group.set(candidate, edit);
          nested.set(head, group);
        }
      }
      const rewritten = await Promise.all([...nested].map(async ([head, group]) => {
        const existing = entries.get(head);
        return [head, await rewrite(isTree(existing) ? existing!.id : null, join(prefix, head), group)] as const;
      }));
      for (const [head, tree] of rewritten) {
        // A file placed at this name wins over edits beneath it.
        if (direct.get(head)) continue;
        if (tree) entries.set(head, { id: tree, mode: TREE_MODE, name: head, nameBytes: entries.get(head)?.nameBytes ?? Buffer.from(head, "utf8") });
        else if (isTree(entries.get(head)) || direct.has(head)) entries.delete(head);
      }
      for (const [name, edit] of direct) {
        if (edit) entries.set(name, { ...edit, name, nameBytes: entries.get(name)?.nameBytes ?? Buffer.from(name, "utf8") });
        else if (!nested.has(name) || !isTree(entries.get(name))) entries.delete(name);
      }
      if (!entries.size) return prefix ? null : await this.emptyTree();
      return await this.writeTree([...entries.values()]);
    };
    if (!edits.size) return base ?? await this.emptyTree();
    return (await rewrite(base, "", edits))!;
  }
}
