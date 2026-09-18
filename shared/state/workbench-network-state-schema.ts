/*
 * Exports:
 * - workbenchNetworkTables: typed app-local network configuration, issuer and authorised-member tables.
 * - workbenchNetworkHistory: preserve initial storage and append mode/identity/rename tables.
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

export const workbenchNetworkTables = Object.freeze({ ...originalTables, ...modeTables });

export function workbenchNetworkHistory(schemaVersion: number, modeVersion: number) {
  return [
    ...Object.values(originalTables).map(table => defineTableHistory({
    current: table,
    versions: [tableVersion({ schemaVersion, table, migration: createTable(table) })],
    })),
    ...Object.values(modeTables).map(table => defineTableHistory({
      current: table,
      versions: [tableVersion({ schemaVersion: modeVersion, table, migration: createTable(table) })],
    })),
  ];
}
