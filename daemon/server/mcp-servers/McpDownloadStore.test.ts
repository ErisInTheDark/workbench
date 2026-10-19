/*
 * No production exports. Protects that MCP downloads save exactly what was fetched, never reach local or private
 * addresses (even through redirects), stop at the size cap without leaving partial files, and live only until their
 * thread settles, including across restarts.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";
import { renderCreateTable } from "workbench-shared/database/schema/schema-definition";
import { mcpDownloads } from "../lib/workbench/database/schema/mcp-server-schema";
import McpDownloadStore, { type McpDownloadStoreOptions } from "./McpDownloadStore";

const PUBLIC = "203.0.113.10";

async function setup(responses: Record<string, () => Response>, addresses: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-downloads-"));
  const sqlite = new Database(":memory:");
  sqlite.exec(renderCreateTable(mcpDownloads));
  const tables = { [mcpDownloads.name]: mcpDownloads };
  const database: McpDownloadStoreOptions["database"] = {
    query: async <Row extends WorkbenchDatabaseRow>(query: Parameters<McpDownloadStoreOptions["database"]["query"]>[0]) => {
      const compiled = compileWorkbenchDatabaseStatement(tables, query);
      return sqlite.prepare(compiled.sql).all(...compiled.parameters) as Row[];
    },
    executeTransaction: async statements => sqlite.transaction(() => {
      let changes = 0;
      for (const statement of statements) {
        const compiled = compileWorkbenchDatabaseStatement(tables, statement);
        changes += sqlite.prepare(compiled.sql).run(...compiled.parameters).changes;
      }
      return { changes };
    })(),
  };
  const fetched: string[] = [];
  const errors: unknown[] = [];
  const settledThreads = new Map<string, boolean>();
  const listeners = new Set<(threadId: string) => void>();
  const create = () => new McpDownloadStore({
    directory, database,
    maxBytes: 64,
    onError: error => { errors.push(error); },
    threads: {
      onSettled: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      settled: async threadId => settledThreads.get(threadId) ?? null,
    },
    lookup: async host => [addresses[host] ?? PUBLIC],
    fetch: async input => {
      const url = String(input);
      fetched.push(url);
      const respond = responses[url];
      if (!respond) throw new Error(`unexpected fetch ${url}`);
      return respond();
    },
  });
  const store = create();
  return {
    store, create, directory, fetched, settledThreads,
    settle: (threadId: string) => { settledThreads.set(threadId, true); for (const listener of listeners) listener(threadId); },
    files: async () => (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name),
    rows: () => sqlite.prepare("SELECT thread_id FROM mcp_downloads ORDER BY thread_id").all(),
    close: async () => {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
      assert.deepEqual(errors, []);
    },
  };
}

const signal = () => new AbortController().signal;
const THREAD = "thread-a";

test("a download is saved under its suggested name with its type and size", async () => {
  const { store, close } = await setup({
    "https://files.example.test/abc": () => new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  try {
    const saved = await store.download(THREAD, "https://files.example.test/abc", "Ali and the Zephyrum", signal());
    assert.equal(path.basename(saved.path), "Ali and the Zephyrum.html");
    assert.deepEqual({ name: saved.name, contentType: saved.contentType, bytes: saved.bytes }, {
      name: "Ali and the Zephyrum.html", contentType: "text/html", bytes: 9,
    });
    assert.equal(await readFile(saved.path, "utf8"), "<p>hi</p>");
  } finally { await close(); }
});

test("names come from Content-Disposition or the URL path, without path separators", async () => {
  const { store, close } = await setup({
    "https://files.example.test/report.csv": () => new Response("a,b", {
      headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=\"../../evil.csv\"" },
    }),
    "https://files.example.test/dir/notes.txt": () => new Response("x", { headers: { "content-type": "text/plain" } }),
  });
  try {
    assert.equal((await store.download(THREAD, "https://files.example.test/report.csv", undefined, signal())).name, "evil.csv");
    assert.equal((await store.download(THREAD, "https://files.example.test/dir/notes.txt", undefined, signal())).name, "notes.txt");
  } finally { await close(); }
});

test("loopback and private hosts are refused, including when a redirect leads there", async () => {
  const { store, fetched, files, close } = await setup({
    "https://public.example.test/file": () => new Response(null, { status: 302, headers: { location: "https://internal.example.test/secret" } }),
  }, { "local.example.test": "127.0.0.1", "internal.example.test": "192.168.1.20", "v6.example.test": "::1" });
  try {
    for (const host of ["local.example.test", "v6.example.test"]) {
      await assert.rejects(store.download(THREAD, `https://${host}/x`, undefined, signal()), /local or private address/u);
    }
    await assert.rejects(store.download(THREAD, "https://public.example.test/file", undefined, signal()), /local or private address/u);
    assert.deepEqual(fetched, ["https://public.example.test/file"], "refused hosts are never fetched");
    assert.deepEqual(await files(), []);
  } finally { await close(); }
});

test("a download over the size cap is aborted and leaves no partial file", async () => {
  const { store, files, close } = await setup({
    "https://files.example.test/big": () => new Response("x".repeat(65), { headers: { "content-type": "text/plain" } }),
  });
  try {
    await assert.rejects(store.download(THREAD, "https://files.example.test/big", undefined, signal()), /larger than/u);
    assert.deepEqual(await files(), []);
  } finally { await close(); }
});

const textFile = (body: string) => () => new Response(body, { headers: { "content-type": "text/plain" } });

test("settling a thread deletes its downloads, and only its own", async () => {
  const { store, settle, settledThreads, files, rows, close } = await setup({
    "https://files.example.test/a.txt": textFile("a"), "https://files.example.test/b.txt": textFile("b"),
  });
  try {
    settledThreads.set(THREAD, false).set("thread-b", false);
    store.start();
    await store.idle();
    await store.download(THREAD, "https://files.example.test/a.txt", undefined, signal());
    await store.download("thread-b", "https://files.example.test/b.txt", undefined, signal());
    settle(THREAD);
    await store.dispose();
    assert.deepEqual(await files(), ["b.txt"]);
    assert.deepEqual(rows(), [{ thread_id: "thread-b" }]);
  } finally { await close(); }
});

test("a restart drops downloads of threads that settled meanwhile and folders nothing owns, keeping unknown threads' files", async () => {
  const { store, create, directory, settledThreads, files, rows, close } = await setup({
    "https://files.example.test/a.txt": textFile("a"), "https://files.example.test/b.txt": textFile("b"),
    "https://files.example.test/c.txt": textFile("c"),
  });
  try {
    settledThreads.set(THREAD, false).set("thread-b", false).set("thread-c", false);
    store.start();
    await store.idle();
    await store.download(THREAD, "https://files.example.test/a.txt", undefined, signal());
    await store.download("thread-b", "https://files.example.test/b.txt", undefined, signal());
    await store.download("thread-c", "https://files.example.test/c.txt", undefined, signal());
    await store.dispose();
    settledThreads.set(THREAD, true);
    settledThreads.delete("thread-b");
    await mkdir(path.join(directory, "crash-leftover"));
    const restarted = create();
    restarted.start();
    await restarted.dispose();
    assert.deepEqual((await files()).sort(), ["b.txt", "c.txt"]);
    assert.deepEqual(rows(), [{ thread_id: "thread-b" }, { thread_id: "thread-c" }]);
    assert.equal((await readdir(directory)).includes("crash-leftover"), false);
  } finally { await close(); }
});
