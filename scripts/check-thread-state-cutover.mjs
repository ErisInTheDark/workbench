/*
 * No exports. Temporary read-only proof that legacy thread-state authority matches the relational projection. Keywords: thread state, SQLite, cutover, migration, parity.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";

const HARNESSES = new Set(["codex", "copilot", "opencode"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodedKey(...parts) {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

function compareRelationships(left, right) {
  return left.projectId.localeCompare(right.projectId)
    || left.harness.localeCompare(right.harness)
    || left.parentThreadId.localeCompare(right.parentThreadId)
    || left.directSubagentIndex - right.directSubagentIndex
    || left.threadId.localeCompare(right.threadId);
}

function readSubagentAuthority(directoryPath) {
  const mismatches = [];
  const parents = new Map();
  const relationships = [];
  let entries;
  try {
    entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return {
      mismatches: [`legacy subagent directory is unavailable: ${directoryPath}`],
      parents: [],
      relationships: [],
    };
  }

  for (const entry of entries.filter(({ name }) => name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue;
    const filePath = path.join(directoryPath, entry.name);
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      mismatches.push(`legacy parent file is unreadable: ${entry.name}`);
      continue;
    }
    if (
      !isRecord(stored)
      || typeof stored.parentThreadId !== "string"
      || !Number.isSafeInteger(stored.nextDirectSubagentIndex)
      || stored.nextDirectSubagentIndex < 0
      || !isRecord(stored.subagents)
    ) {
      mismatches.push(`legacy parent file has an invalid envelope: ${entry.name}`);
      continue;
    }
    const records = Object.values(stored.subagents);
    if (records.length === 0) {
      mismatches.push(`legacy parent file has no project-qualified relationship: ${entry.name}`);
      continue;
    }
    for (const record of records) {
      const strings = [
        "cwd", "harness", "name", "parentThreadId", "profileId",
        "profileName", "projectId", "threadId", "title",
      ];
      const numbers = ["createdAt", "directSubagentIndex", "updatedAt"];
      if (
        !isRecord(record)
        || strings.some((field) => typeof record[field] !== "string")
        || numbers.some((field) => !Number.isSafeInteger(record[field]) || record[field] < 0)
        || !HARNESSES.has(record.harness)
        || record.parentThreadId !== stored.parentThreadId
      ) {
        mismatches.push(`legacy parent file has an invalid relationship: ${entry.name}`);
        continue;
      }
      const parentKey = encodedKey(record.projectId, record.harness, record.parentThreadId);
      const parent = {
        harness: record.harness,
        nextDirectSubagentIndex: stored.nextDirectSubagentIndex,
        parentThreadId: record.parentThreadId,
        projectId: record.projectId,
      };
      const existingParent = parents.get(parentKey);
      if (existingParent && !isDeepStrictEqual(existingParent, parent)) {
        mismatches.push(`legacy parent scope has conflicting allocation state: ${entry.name}`);
        continue;
      }
      parents.set(parentKey, parent);
      relationships.push({
        createdAt: record.createdAt,
        cwd: record.cwd,
        directSubagentIndex: record.directSubagentIndex,
        harness: record.harness,
        name: record.name,
        nameKey: record.name.toLocaleLowerCase(),
        parentThreadId: record.parentThreadId,
        profileId: record.profileId,
        profileName: record.profileName,
        projectId: record.projectId,
        relationshipKind: record.threadId.startsWith("pending:") ? "pending" : "active",
        threadId: record.threadId,
        title: record.title,
        updatedAt: record.updatedAt,
      });
    }
  }

  return {
    mismatches,
    parents: [...parents.values()].sort((left, right) => (
      left.projectId.localeCompare(right.projectId)
      || left.harness.localeCompare(right.harness)
      || left.parentThreadId.localeCompare(right.parentThreadId)
    )),
    relationships: relationships.sort(compareRelationships),
  };
}

function inspectCutover(projectRoot) {
  const databasePath = path.join(projectRoot, ".workbench", "workbench.sqlite3");
  const authority = readSubagentAuthority(path.join(projectRoot, ".workbench", "runtime", "subagents"));
  const database = new Database(databasePath, { fileMustExist: true, readonly: true });
  try {
    database.pragma("query_only = ON");
    const status = database.prepare(`
      SELECT
        completed_at completedAt,
        error_code errorCode,
        error_text errorText,
        generation,
        mismatch_count mismatchCount,
        projected_subagent_count projectedSubagentCount,
        projected_thread_count projectedThreadCount,
        source_digest sourceDigest,
        source_project_count sourceProjectCount,
        source_project_updated_at sourceProjectUpdatedAt,
        source_subagent_count sourceSubagentCount,
        source_subagent_parent_count sourceSubagentParentCount,
        state,
        updated_at updatedAt
      FROM workbench_thread_state_projection_status
      WHERE id = 1
    `).get() ?? null;
    const count = (table) => database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
    const authorityProjectCount = count("workbench_thread_state_projects");
    const projectedThreadCount = count("workbench_thread_state_threads");
    const projectedSubagentCount = count("workbench_thread_state_subagents");
    const projectedParentCount = count("workbench_thread_state_subagent_parents");
    const projectedRelationshipCount = count("workbench_thread_state_subagent_relationships");
    const projectedPendingCount = count("workbench_thread_state_pending_subagent_relationships");
    const projectedActiveCount = count("workbench_thread_state_active_subagent_relationships");
    const parents = database.prepare(`
      SELECT
        parent.harness_id harness,
        parent.next_direct_subagent_index nextDirectSubagentIndex,
        identity.provider_thread_id parentThreadId,
        parent.project_id projectId
      FROM workbench_thread_state_subagent_parents parent
      JOIN workbench_thread_state_provider_identities identity
        ON identity.thread_id = parent.parent_thread_id
      ORDER BY parent.project_id, parent.harness_id, identity.provider_thread_id
    `).all();
    const relationships = database.prepare(`
      SELECT
        relationship.created_at createdAt,
        COALESCE(pending.cwd, subagent.cwd) cwd,
        relationship.direct_subagent_index directSubagentIndex,
        parent.harness_id harness,
        COALESCE(pending.name, subagent.name) name,
        relationship.name_key nameKey,
        parent_identity.provider_thread_id parentThreadId,
        COALESCE(pending.profile_id, subagent.profile_id) profileId,
        COALESCE(pending.profile_name, subagent.profile_name) profileName,
        parent.project_id projectId,
        relationship.relationship_kind relationshipKind,
        COALESCE(pending.reservation_thread_id, child_identity.provider_thread_id) threadId,
        COALESCE(pending.title, child.title) title,
        relationship.updated_at updatedAt
      FROM workbench_thread_state_subagent_relationships relationship
      JOIN workbench_thread_state_subagent_parents parent
        ON parent.id = relationship.parent_id
      JOIN workbench_thread_state_provider_identities parent_identity
        ON parent_identity.thread_id = parent.parent_thread_id
      LEFT JOIN workbench_thread_state_pending_subagent_relationships pending
        ON pending.relationship_id = relationship.id
      LEFT JOIN workbench_thread_state_active_subagent_relationships active
        ON active.relationship_id = relationship.id
      LEFT JOIN workbench_thread_state_subagents subagent
        ON subagent.thread_id = active.thread_id
      LEFT JOIN workbench_thread_state_provider_identities child_identity
        ON child_identity.thread_id = active.thread_id
      LEFT JOIN workbench_thread_state_threads child
        ON child.id = active.thread_id
      ORDER BY
        parent.project_id,
        parent.harness_id,
        parent_identity.provider_thread_id,
        relationship.direct_subagent_index,
        threadId
    `).all().sort(compareRelationships);
    const invalidAugmentationCount = database.prepare(`
      SELECT COUNT(*) count
      FROM workbench_thread_state_subagent_relationships relationship
      LEFT JOIN workbench_thread_state_pending_subagent_relationships pending
        ON pending.relationship_id = relationship.id
      LEFT JOIN workbench_thread_state_active_subagent_relationships active
        ON active.relationship_id = relationship.id
      WHERE
        (pending.relationship_id IS NOT NULL) + (active.relationship_id IS NOT NULL) <> 1
        OR (relationship.relationship_kind = 'pending') <> (pending.relationship_id IS NOT NULL)
    `).get().count;
    const mismatches = [...authority.mismatches];
    if (!status) mismatches.push("projection status is missing");
    else {
      if (status.state !== "complete") mismatches.push(`projection state is ${status.state}`);
      if (status.mismatchCount !== 0) mismatches.push(`projection reports ${status.mismatchCount} mismatch(es)`);
      if (status.sourceProjectCount !== authorityProjectCount) mismatches.push("source project count does not match current authority");
      if (status.sourceSubagentParentCount !== authority.parents.length) mismatches.push("source parent count does not match current authority");
      if (status.sourceSubagentCount !== authority.relationships.length) mismatches.push("source relationship count does not match current authority");
      if (status.projectedThreadCount !== projectedThreadCount) mismatches.push("reported projected thread count does not match typed rows");
      if (status.projectedSubagentCount !== projectedSubagentCount) mismatches.push("reported projected subagent count does not match typed rows");
    }
    if (projectedParentCount !== authority.parents.length) mismatches.push("typed parent count does not match current authority");
    if (projectedRelationshipCount !== authority.relationships.length) mismatches.push("typed relationship count does not match current authority");
    if (projectedPendingCount + projectedActiveCount !== projectedRelationshipCount) mismatches.push("pending and active counts do not cover every typed relationship");
    if (invalidAugmentationCount !== 0) mismatches.push(`${invalidAugmentationCount} typed relationship(s) have invalid augmentation`);
    if (!isDeepStrictEqual(parents, authority.parents)) mismatches.push("typed parent allocation watermarks do not match current authority");
    if (!isDeepStrictEqual(relationships, authority.relationships)) mismatches.push("typed relationships do not match current authority");

    const watermarks = parents.map(({ nextDirectSubagentIndex }) => nextDirectSubagentIndex);
    return {
      counts: {
        authorityParents: authority.parents.length,
        authorityProjects: authorityProjectCount,
        authorityRelationships: authority.relationships.length,
        projectedActive: projectedActiveCount,
        projectedParents: projectedParentCount,
        projectedPending: projectedPendingCount,
        projectedRelationships: projectedRelationshipCount,
        projectedSubagents: projectedSubagentCount,
        projectedThreads: projectedThreadCount,
      },
      databasePath,
      mismatches,
      status,
      watermarkRange: watermarks.length
        ? { maximum: Math.max(...watermarks), minimum: Math.min(...watermarks) }
        : null,
    };
  } finally {
    database.close();
  }
}

function runSelfTest() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-thread-state-cutover-"));
  const workbenchRoot = path.join(projectRoot, ".workbench");
  const subagentRoot = path.join(workbenchRoot, "runtime", "subagents");
  const databasePath = path.join(workbenchRoot, "workbench.sqlite3");
  fs.mkdirSync(subagentRoot, { recursive: true });
  const relationship = {
    createdAt: 1,
    cwd: projectRoot,
    directSubagentIndex: 0,
    harness: "codex",
    name: "child",
    parentThreadId: "parent",
    profileId: "profile",
    profileName: "Profile",
    projectId: "project",
    threadId: "child",
    title: "Child",
    updatedAt: 2,
  };
  fs.writeFileSync(path.join(subagentRoot, "parent.json"), JSON.stringify({
    nextDirectSubagentIndex: 1,
    parentThreadId: "parent",
    schemaVersion: 4,
    subagents: { child: relationship },
  }));

  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE workbench_thread_state_projects(project_id TEXT PRIMARY KEY);
      INSERT INTO workbench_thread_state_projects VALUES ('project');

      CREATE TABLE workbench_thread_state_projection_status(
        id INTEGER PRIMARY KEY,
        completed_at INTEGER,
        error_code TEXT,
        error_text TEXT,
        generation INTEGER,
        mismatch_count INTEGER,
        projected_subagent_count INTEGER,
        projected_thread_count INTEGER,
        source_digest TEXT,
        source_project_count INTEGER,
        source_project_updated_at INTEGER,
        source_subagent_count INTEGER,
        source_subagent_parent_count INTEGER,
        state TEXT,
        updated_at INTEGER
      );
      INSERT INTO workbench_thread_state_projection_status
        VALUES (1, 3, NULL, NULL, 1, 0, 1, 2, '${"a".repeat(64)}', 1, 2, 1, 1, 'complete', 3);

      CREATE TABLE workbench_thread_state_threads(id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO workbench_thread_state_threads VALUES ('parent-row', 'Parent'), ('child-row', 'Child');

      CREATE TABLE workbench_thread_state_provider_identities(
        thread_id TEXT PRIMARY KEY,
        harness_id TEXT,
        project_id TEXT,
        provider_thread_id TEXT
      );
      INSERT INTO workbench_thread_state_provider_identities VALUES
        ('parent-row', 'codex', 'project', 'parent'),
        ('child-row', 'codex', 'project', 'child');

      CREATE TABLE workbench_thread_state_subagents(
        thread_id TEXT PRIMARY KEY,
        cwd TEXT,
        name TEXT,
        profile_id TEXT,
        profile_name TEXT
      );
      INSERT INTO workbench_thread_state_subagents
        VALUES ('child-row', '${projectRoot.replaceAll("'", "''")}', 'child', 'profile', 'Profile');

      CREATE TABLE workbench_thread_state_subagent_parents(
        id TEXT PRIMARY KEY,
        harness_id TEXT,
        next_direct_subagent_index INTEGER,
        parent_thread_id TEXT,
        project_id TEXT
      );
      INSERT INTO workbench_thread_state_subagent_parents
        VALUES ('parent-scope', 'codex', 1, 'parent-row', 'project');

      CREATE TABLE workbench_thread_state_subagent_relationships(
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        relationship_kind TEXT,
        name_key TEXT,
        direct_subagent_index INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );
      INSERT INTO workbench_thread_state_subagent_relationships
        VALUES ('relationship', 'parent-scope', 'active', 'child', 0, 1, 2);

      CREATE TABLE workbench_thread_state_pending_subagent_relationships(
        relationship_id TEXT PRIMARY KEY,
        reservation_thread_id TEXT,
        cwd TEXT,
        name TEXT,
        profile_id TEXT,
        profile_name TEXT,
        title TEXT
      );
      CREATE TABLE workbench_thread_state_active_subagent_relationships(
        relationship_id TEXT PRIMARY KEY,
        thread_id TEXT
      );
      INSERT INTO workbench_thread_state_active_subagent_relationships
        VALUES ('relationship', 'child-row');
    `);
  } finally {
    database.close();
  }

  try {
    const matching = inspectCutover(projectRoot);
    const writable = new Database(databasePath);
    try {
      writable.prepare("DELETE FROM workbench_thread_state_active_subagent_relationships").run();
    } finally {
      writable.close();
    }
    const broken = inspectCutover(projectRoot);
    const passed = matching.mismatches.length === 0
      && broken.mismatches.some((mismatch) => mismatch.includes("invalid augmentation"));
    return {
      brokenMismatches: broken.mismatches,
      matchingMismatches: matching.mismatches,
      passed,
    };
  } finally {
    fs.rmSync(projectRoot, { force: true, recursive: true });
  }
}

if (process.argv[2] === "--self-test") {
  try {
    const report = runSelfTest();
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      failure: error instanceof Error ? error.message : "unknown cutover self-test failure",
    }, null, 2));
    process.exitCode = 1;
  }
} else {
  const projectRoot = path.resolve(process.argv[2] ?? ".");
  try {
    const report = inspectCutover(projectRoot);
    console.log(JSON.stringify(report, null, 2));
    if (report.mismatches.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      failure: error instanceof Error ? error.message : "unknown cutover inspection failure",
      projectRoot,
    }, null, 2));
    process.exitCode = 1;
  }
}
