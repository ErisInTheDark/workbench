/*
 * WORKBENCH_DATABASE_TABLE_NAMES: exact current Workbench database table inventory.
 * WORKBENCH_DATABASE_SCHEMA_VERSION: current global SQLite schema version.
 * installWorkbenchDatabaseSchema: install latest or an explicit historical target transactionally, never downgrade.
 * coreTables: current core table map.
 * CoreSchemaRows: current core selected-row registry.
 * codexSandboxNetworkTables: current Codex sandbox network table map.
 * CodexSandboxNetworkSchemaRows: current Codex sandbox network selected-row registry.
 * itemTables: current item table map.
 * ItemSchemaRows: current item selected-row registry.
 * operationSourceTables: current operation source table map.
 * OperationSourceSchemaRows: current operation source selected-row registry.
 * interactionTables: current interaction table map.
 * InteractionSchemaRows: current interaction selected-row registry.
 * evidenceTables: current evidence table map.
 * EvidenceSchemaRows: current evidence selected-row registry.
 * searchTables/SearchSchemaRows: current workspace-search projection registry.
 * usageTables/UsageSchemaRows: durable token, rate-limit, and claim-session facts.
 * transcriptIdentityTables/TranscriptIdentitySchemaRows: permanent identity and compatibility aliases.
 * gitArcProposalDiffTables: immutable Git arc proposal diff cache table map.
 * instructionTombstoneTables: durable retired instruction file receipt table map.
 * projectTables/ProjectSchemaRows: canonical project storage, roots, and aliases.
 * workbenchDatabaseTables: every current table keyed by its SQLite name.
 * workbenchDatabaseSchema: assembled history used by protected production migration.
 * validateWorkbenchDatabaseReleases: reject rewritten or unsealed releases before opening SQLite.
 * defineRelationalThreadStateSchema: assemble the relational serving schema at its release version.
 */
import type Database from "better-sqlite3";

import { codexSandboxNetworkSchemaHistory } from "../lib/workbench/database/schema/codex-sandbox-network-schema.ts";
import { composerProfileSchemaHistory } from "../lib/workbench/database/schema/composer-profile-schema.ts";
import { voiceSettingsSchemaHistory } from "../lib/workbench/database/schema/voice-settings-schema.ts";
import { defineThreadDomainCoreSchema } from "workbench-shared/workbench/database/schema/core-schema";
import { evidenceSchemaHistory } from "workbench-shared/workbench/database/schema/evidence-schema";
import { interactionSchemaHistory } from "workbench-shared/workbench/database/schema/interaction-schema";
import { itemSchemaHistory } from "workbench-shared/workbench/database/schema/item-schema";
import { operationSourceSchemaHistory } from "workbench-shared/workbench/database/schema/operation-source-schema";
import { searchSchemaHistory } from "workbench-shared/workbench/database/schema/search-schema";
import { usageSchemaHistory } from "workbench-shared/workbench/database/schema/usage-schema";
import { transcriptIdentitySchemaHistory } from "workbench-shared/workbench/database/schema/transcript-identity-schema";
import { threadStateSchemaHistory } from "../lib/workbench/database/schema/thread-state-schema.ts";
import { defineCanonicalThreadTitleHistorySchema } from "../lib/workbench/database/schema/thread-title-history-schema.ts";
import { defineThreadDomainSchema } from "../lib/workbench/database/schema/thread-domain-schema.ts";
import { defineSidebarLayoutSchema } from "../lib/workbench/database/schema/sidebar-layout-schema.ts";
import { defineThreadQuestionnaireSchema } from "../lib/workbench/database/schema/thread-questionnaire-schema.ts";
import { defineThreadGitObservationSchema } from "../lib/workbench/database/schema/thread-git-observation-schema.ts";
import { gitArcProposalDiffSchemaHistory } from "../lib/workbench/database/schema/git-arc-proposal-diff-schema.ts";
import { instructionTombstoneSchemaHistory } from "../lib/workbench/database/schema/instruction-tombstone-schema.ts";
import type { CurrentTableDefinition } from "workbench-shared/database/schema/schema-definition";
import { applyWorkbenchDatabaseSchema, defineWorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";
import { assertSchemaReleaseManifest } from "workbench-shared/database/schema/schema-release-manifest";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { codexTranscriptSchemaHistory } from "workbench-shared/workbench/database/schema/codex-transcript-schema";
import { projectSchemaHistory } from "workbench-shared/workbench/database/schema/project-schema";
import { localCapabilitySchemaHistory } from "../lib/workbench/database/schema/local-capability-schema.ts";
import { browsePersistenceSchemaHistory } from "../lib/workbench/database/schema/browse-persistence-schema.ts";
import { externalStorageImportSchemaHistory } from "../lib/workbench/database/schema/external-storage-import-schema.ts";
import { transcriptAssetContentSchemaHistory } from "../lib/workbench/database/schema/transcript-asset-content-schema.ts";
import { legacyDiffArtifactSchemaHistory } from "../lib/workbench/database/schema/legacy-diff-artifact-schema.ts";
import { threadGitSelectionSchemaHistory } from "../lib/workbench/database/schema/thread-git-selection-schema.ts";

export { projectTables } from "workbench-shared/workbench/database/schema/project-schema";
export type { ProjectSchemaRows } from "workbench-shared/workbench/database/schema/project-schema";

export { codexSandboxNetworkTables } from "../lib/workbench/database/schema/codex-sandbox-network-schema.ts";
export type { CodexSandboxNetworkSchemaRows } from "../lib/workbench/database/schema/codex-sandbox-network-schema.ts";
export { coreTables } from "workbench-shared/workbench/database/schema/core-schema";
export type { CoreSchemaRows } from "workbench-shared/workbench/database/schema/core-schema";
export { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
export type { EvidenceSchemaRows } from "workbench-shared/workbench/database/schema/evidence-schema";
export { interactionTables } from "workbench-shared/workbench/database/schema/interaction-schema";
export type { InteractionSchemaRows } from "workbench-shared/workbench/database/schema/interaction-schema";
export { itemTables } from "workbench-shared/workbench/database/schema/item-schema";
export type { ItemSchemaRows } from "workbench-shared/workbench/database/schema/item-schema";
export { operationSourceTables } from "workbench-shared/workbench/database/schema/operation-source-schema";
export type { OperationSourceSchemaRows } from "workbench-shared/workbench/database/schema/operation-source-schema";
export { searchTables } from "workbench-shared/workbench/database/schema/search-schema";
export type { SearchSchemaRows } from "workbench-shared/workbench/database/schema/search-schema";
export { usageTables } from "workbench-shared/workbench/database/schema/usage-schema";
export type { UsageSchemaRows } from "workbench-shared/workbench/database/schema/usage-schema";
export { transcriptIdentityTables } from "workbench-shared/workbench/database/schema/transcript-identity-schema";
export type { TranscriptIdentitySchemaRows } from "workbench-shared/workbench/database/schema/transcript-identity-schema";
export { gitArcProposalDiffTables } from "../lib/workbench/database/schema/git-arc-proposal-diff-schema.ts";
export { instructionTombstoneTables } from "../lib/workbench/database/schema/instruction-tombstone-schema.ts";

export const workbenchDatabaseSchema = defineRelationalThreadStateSchema(databaseReleases.relationalThreadState.version);

export function defineRelationalThreadStateSchema(schemaVersion: number) {
  return defineWorkbenchDatabaseSchema({
    subsystems: [
      projectSchemaHistory,
      composerProfileSchemaHistory,
      voiceSettingsSchemaHistory,
      codexSandboxNetworkSchemaHistory,
      codexTranscriptSchemaHistory,
      defineThreadDomainCoreSchema(schemaVersion).history,
      transcriptIdentitySchemaHistory,
      itemSchemaHistory,
      operationSourceSchemaHistory,
      interactionSchemaHistory,
      evidenceSchemaHistory,
      threadStateSchemaHistory,
      defineCanonicalThreadTitleHistorySchema(schemaVersion).history,
      searchSchemaHistory,
      usageSchemaHistory,
      defineThreadDomainSchema(schemaVersion).history,
      defineSidebarLayoutSchema(schemaVersion).history,
      defineThreadQuestionnaireSchema(schemaVersion).history,
      defineThreadGitObservationSchema(schemaVersion).history,
      gitArcProposalDiffSchemaHistory,
      instructionTombstoneSchemaHistory,
      localCapabilitySchemaHistory,
      browsePersistenceSchemaHistory,
      externalStorageImportSchemaHistory,
      transcriptAssetContentSchemaHistory,
      legacyDiffArtifactSchemaHistory,
      threadGitSelectionSchemaHistory,
    ],
  });
}

export const workbenchDatabaseTables = Object.freeze(Object.fromEntries(
  workbenchDatabaseSchema.currentTables.map((table) => [table.name, table]),
)) as Readonly<Record<string, CurrentTableDefinition>>;

export const WORKBENCH_DATABASE_TABLE_NAMES = Object.freeze(
  workbenchDatabaseSchema.currentTables.map((table) => table.name),
);

export const WORKBENCH_DATABASE_SCHEMA_VERSION = workbenchDatabaseSchema.currentVersion;

export function validateWorkbenchDatabaseReleases() {
  assertSchemaReleaseManifest(workbenchDatabaseSchema, databaseReleases, "daemon");
}

export function installWorkbenchDatabaseSchema(database: Database.Database, options: { targetVersion?: number } = {}) {
  validateWorkbenchDatabaseReleases();
  applyWorkbenchDatabaseSchema(database, workbenchDatabaseSchema, options);
}
