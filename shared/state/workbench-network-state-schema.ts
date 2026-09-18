/*
 * Exports:
 * - workbenchNetworkTables: typed app-local configuration, directory, grants and transfer tables.
 * - workbenchNetworkHistory: append releases without changing historical table definitions.
 */
import {
  booleanInteger, check, defineTable, enumText, foreignKey, integer, literal,
  primaryKey, publishCurrentTable, sql, text, unique,
} from "../database/schema/schema-definition.ts";
import { createTable, defineTableHistory, tableVersion } from "../database/schema/schema-history.ts";

const hostServe = defineTable("network_host_serve", {
  id: enumText("singleton").primaryKey(),
  enabled: booleanInteger().notNull(),
  port: integer().notNull(),
}, table => ({ constraints: [check(sql`${table.port} BETWEEN ${literal(1)} AND ${literal(65535)}`)] }));

const privateAccess = defineTable("network_private_access", {
  id: enumText("singleton").primaryKey(),
  enabled: booleanInteger().notNull(),
  label: text().notNull(),
  role: enumText("unconfigured", "authority", "member").notNull(),
}, table => ({ constraints: [
  unique([table.id, table.role]),
  check(sql`${table.role} <> ${literal("unconfigured")} OR ${table.enabled} = ${literal(0)}`),
] }));

const issuer = defineTable("network_private_issuer", {
  id: enumText("singleton").primaryKey(),
  role: enumText("member").notNull(),
  address: text().notNull(),
  hostname: text().notNull(),
}, table => ({ constraints: [
  foreignKey([table.id, table.role], {
    table: "network_private_access", columns: ["id", "role"], onDelete: "CASCADE",
  }),
] }));

const members = defineTable("network_members", {
  node_id: text().primaryKey(),
  label: text().notNull(),
  key_fingerprint: text().notNull(),
}, table => ({ constraints: [unique([table.label])] }));

const memberAddresses = defineTable("network_member_addresses", {
  node_id: text().notNull().references("network_members", "node_id", { onDelete: "CASCADE" }),
  family: enumText("ipv4", "ipv6").notNull(),
  address: text().notNull(),
}, table => ({ constraints: [
  primaryKey([table.node_id, table.family]),
  unique([table.address]),
] }));

const originalTables = Object.freeze({
  networkHostServe: publishCurrentTable(hostServe),
  networkPrivateAccess: publishCurrentTable(privateAccess),
  networkPrivateIssuer: publishCurrentTable(issuer),
  networkMembers: publishCurrentTable(members),
  networkMemberAddresses: publishCurrentTable(memberAddresses),
});

const mode = defineTable("network_mode", {
  id: enumText("singleton").primaryKey(),
  mode: enumText("localhost", "tailnet-ip", "tailnet-service").notNull(),
});
const identity = defineTable("network_identity", {
  id: enumText("singleton").primaryKey().references("network_private_access", "id", { onDelete: "CASCADE" }),
  node_label: text().notNull(),
});
const rename = defineTable("network_rename", {
  id: enumText("singleton").primaryKey().references("network_private_access", "id", { onDelete: "CASCADE" }),
  operation_id: text().notNull(),
  previous_label: text().notNull(),
  next_label: text().notNull(),
  phase: enumText("prepare", "activate", "retire").notNull(),
}, table => ({ constraints: [check(sql`${table.previous_label} <> ${table.next_label}`)] }));
const reservations = defineTable("network_member_renames", {
  node_id: text().primaryKey().references("network_members", "node_id", { onDelete: "CASCADE" }),
  operation_id: text().notNull(),
  previous_label: text().notNull(),
  next_label: text().notNull(),
}, table => ({ constraints: [
  unique([table.operation_id]), unique([table.next_label]),
  check(sql`${table.previous_label} <> ${table.next_label}`),
] }));
const modeTables = Object.freeze({
  networkMode: publishCurrentTable(mode),
  networkIdentity: publishCurrentTable(identity),
  networkRename: publishCurrentTable(rename),
  networkMemberRenames: publishCurrentTable(reservations),
});

const group = defineTable("network_group", {
  id: enumText("singleton").primaryKey(),
  network_id: text().notNull(),
  revision: integer().notNull(),
  owner_node_id: text().notNull(),
  dns_node_id: text().notNull(),
  access: enumText("all", "selected").notNull(),
}, table => ({ constraints: [check(sql`${table.revision} >= ${literal(1)}`)] }));
const memberHosts = defineTable("network_member_hosts", {
  node_id: text().primaryKey().references("network_members", "node_id", { onDelete: "CASCADE" }),
  host_node_id: text().notNull(),
});
const memberPublication = defineTable("network_member_publication", {
  node_id: text().primaryKey().references("network_members", "node_id", { onDelete: "CASCADE" }),
  published: booleanInteger().notNull(),
});
const grants = defineTable("network_grants", {
  device_node_id: text().notNull(),
  app_node_id: text().notNull().references("network_members", "node_id", { onDelete: "CASCADE" }),
}, table => ({ constraints: [primaryKey([table.device_node_id, table.app_node_id])] }));
const transfer = defineTable("network_owner_transfer", {
  id: enumText("singleton").primaryKey().references("network_group", "id", { onDelete: "CASCADE" }),
  operation_id: text().notNull(),
  from_node_id: text().notNull(),
  to_node_id: text().notNull(),
  phase: enumText("prepare", "relinquished", "activated").notNull(),
});
const groupTables = Object.freeze({
  networkGroup: publishCurrentTable(group),
  networkMemberHosts: publishCurrentTable(memberHosts),
  networkMemberPublication: publishCurrentTable(memberPublication),
  networkGrants: publishCurrentTable(grants),
  networkOwnerTransfer: publishCurrentTable(transfer),
});
export const workbenchNetworkTables = Object.freeze({ ...originalTables, ...modeTables, ...groupTables });

export function workbenchNetworkHistory(schemaVersion: number, modeVersion: number, groupVersion: number) {
  return [
    ...Object.values(originalTables).map(table => defineTableHistory({
    current: table,
    versions: [tableVersion({ schemaVersion, table, migration: createTable(table) })],
    })),
    ...Object.values(modeTables).map(table => defineTableHistory({
      current: table,
      versions: [tableVersion({ schemaVersion: modeVersion, table, migration: createTable(table) })],
    })),
    ...Object.values(groupTables).map(table => defineTableHistory({
      current: table,
      versions: [tableVersion({ schemaVersion: groupVersion, table, migration: createTable(table) })],
    })),
  ];
}
