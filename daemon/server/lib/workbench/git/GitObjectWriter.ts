/*
 * Exports:
 * - default GitObjectWriter: write loose Git objects and commits in-process; returns null where Git itself must decide.
 * - GitCommitActorOverrides: optional author/committer fields applied over Git's default identity.
 * - formatGitRawDate: Git's raw date form with the local offset, e.g. `1759633402 +1300`.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

import GitObjectReadSession from "./GitObjectReadSession";

const execFileAsync = promisify(execFile);
const deflate = promisify(zlib.deflate);

type ObjectFormat = "sha1" | "sha256";
type ObjectType = "blob" | "commit" | "tree";
interface RepositoryFacts { format: ObjectFormat; objectsDirectory: string }
interface Actor { date: string; email: string; name: string }
interface DefaultIdentity { author: Actor; authorDateFromEnvironment: boolean; committer: Actor; committerDateFromEnvironment: boolean }

export interface GitCommitActorOverrides {
  authorDate?: string;
  authorEmail?: string;
  authorName?: string;
  committerDate?: string;
  committerEmail?: string;
  committerName?: string;
}

const RAW_DATE = /^\d+ [+-]\d{4}$/u;
const IDENT_LINE = /^(.*) <(.*)> (\d+ [+-]\d{4})$/u;
// Per-process: an object store's location and hash format never change while the repository exists.
const repositoryFacts = new Map<string, Promise<RepositoryFacts>>();

export function formatGitRawDate(date: Date) {
  const offset = -date.getTimezoneOffset();
  const magnitude = Math.abs(offset);
  const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(magnitude / 60)).padStart(2, "0")}${String(magnitude % 60).padStart(2, "0")}`;
  return `${Math.floor(date.getTime() / 1000)} ${zone}`;
}

/** Git strips these from both ends of identity fields and drops `<`, `>` and newlines inside them. */
function isCrud(character: string) {
  return character <= " " || ".,:;<>\"\\'".includes(character);
}

/** Only fields Git would store unchanged are written in-process; anything Git would rewrite goes through Git. */
function storesVerbatim(value: string) {
  return value.length > 0 && !/[<>\n\0]/u.test(value) && !isCrud(value[0]!) && !isCrud(value.at(-1)!);
}

function parseIdent(value: string | undefined): Actor | null {
  const match = value ? IDENT_LINE.exec(value) : null;
  return match ? { name: match[1]!, email: match[2]!, date: match[3]! } : null;
}

export default class GitObjectWriter {
  constructor(private readonly root: string) {}

  private async facts() {
    let facts = repositoryFacts.get(this.root);
    if (!facts) {
      facts = (async () => {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "objects", "--show-object-format"], {
          cwd: this.root, encoding: "utf8", windowsHide: true,
        });
        const [objects = "", format = ""] = stdout.split(/\r?\n/u).map(line => line.trim());
        if (!objects || (format !== "sha1" && format !== "sha256")) throw new Error(`Unsupported Git object store (${format || "unknown format"}).`);
        return { format, objectsDirectory: path.resolve(this.root, objects) } satisfies RepositoryFacts;
      })();
      repositoryFacts.set(this.root, facts);
      facts.catch(() => { if (repositoryFacts.get(this.root) === facts) repositoryFacts.delete(this.root); });
    }
    return await facts;
  }

  async objectIdLength() {
    return (await this.facts()).format === "sha1" ? 40 : 64;
  }

  async writeObject(type: ObjectType, content: Buffer) {
    const { format, objectsDirectory } = await this.facts();
    const framed = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
    const id = createHash(format).update(framed).digest("hex");
    const directory = path.join(objectsDirectory, id.slice(0, 2));
    const target = path.join(directory, id.slice(2));
    if (await exists(target)) return id;
    await fs.mkdir(directory, { recursive: true });
    // Same protocol as Git: a private temporary file renamed into place, so readers never see partial objects.
    const temporary = path.join(directory, `tmp_obj_${randomUUID()}`);
    try {
      await fs.writeFile(temporary, await deflate(framed), { mode: 0o444 });
      try {
        await fs.rename(temporary, target);
      } catch (error) {
        // A concurrent writer of the identical object already put it in place.
        if (!await exists(target)) throw error;
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return id;
  }

  /**
   * Writes a commit exactly as `git commit-tree --no-gpg-sign -F -` would, or returns null when Git must decide:
   * unknown identity, non-UTF-8 commit encoding, non-raw date overrides, or actor fields Git would rewrite.
   */
  async writeCommit(tree: string, parents: string[], message: string, overrides: GitCommitActorOverrides = {}) {
    const length = await this.objectIdLength();
    const ids = [tree, ...parents];
    if (ids.some(id => id.length !== length || !/^[a-f0-9]+$/u.test(id)) || new Set(parents).size !== parents.length) return null;
    const identity = await this.defaultIdentity();
    if (!identity) return null;
    const author = this.actor(identity.author, identity.authorDateFromEnvironment, overrides.authorName, overrides.authorEmail, overrides.authorDate);
    const committer = this.actor(identity.committer, identity.committerDateFromEnvironment, overrides.committerName, overrides.committerEmail, overrides.committerDate);
    if (!author || !committer) return null;
    // Git refuses commits whose tree or parents are missing or mistyped; let it report those itself.
    const objects = await GitObjectReadSession.read(this.root, ids, "info");
    if (objects[0]?.type !== "tree" || objects.slice(1).some(object => object?.type !== "commit")) return null;
    const header = [
      `tree ${tree}`,
      ...parents.map(parent => `parent ${parent}`),
      `author ${author.name} <${author.email}> ${author.date}`,
      `committer ${committer.name} <${committer.email}> ${committer.date}`,
    ].join("\n");
    return await this.writeObject("commit", Buffer.from(`${header}\n\n${message}`, "utf8"));
  }

  private actor(base: Actor, dateFromEnvironment: boolean, name?: string, email?: string, date?: string): Actor | null {
    const resolved = {
      date: date ?? (dateFromEnvironment ? base.date : formatGitRawDate(new Date())),
      email: email ?? base.email,
      name: name ?? base.name,
    };
    if (!RAW_DATE.test(resolved.date) || !storesVerbatim(resolved.name) || !storesVerbatim(resolved.email)) return null;
    return resolved;
  }

  /** One `git var -l` per operation: Git's own resolution of env, config and commit encoding. */
  private async defaultIdentity() {
    return await GitObjectReadSession.memo(`git-var:${this.root}`, async (): Promise<DefaultIdentity | null> => {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync("git", ["var", "-l"], { cwd: this.root, encoding: "utf8", windowsHide: true }));
      } catch (error) {
        // Expected when Git cannot determine an identity (a nonzero exit); commit-tree then reports that failure itself.
        if (error && typeof error === "object" && "code" in error && typeof error.code === "number") return null;
        throw error;
      }
      const values = new Map<string, string>();
      for (const line of stdout.split(/\r?\n/u)) {
        const separator = line.indexOf("=");
        if (separator > 0) values.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1));
      }
      const encoding = values.get("i18n.commitencoding");
      if (encoding && !/^utf-?8$/iu.test(encoding)) return null;
      const author = parseIdent(values.get("git_author_ident"));
      const committer = parseIdent(values.get("git_committer_ident"));
      if (!author || !committer) return null;
      return {
        author,
        authorDateFromEnvironment: Boolean(process.env.GIT_AUTHOR_DATE),
        committer,
        committerDateFromEnvironment: Boolean(process.env.GIT_COMMITTER_DATE),
      };
    });
  }
}

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
