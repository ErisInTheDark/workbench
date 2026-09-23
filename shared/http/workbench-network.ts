/*
 * Exports:
 * - WORKBENCH_NETWORK_PATH/WORKBENCH_NETWORK_PROTOCOL: HTTP and bundled-sidecar protocol identities.
 * - WorkbenchNetworkMemberSchema/WorkbenchNetworkConfigurationSchema: private app-owned configuration.
 * - WorkbenchNetworkRuntimeSchema/WorkbenchNetworkSnapshotSchema: validated runtime and settings projection.
 * - WorkbenchNetworkActionSchema/WorkbenchNetworkResultSchema: bounded user intents and action results.
 * - WorkbenchNetworkVerificationSchema: browser proof of the expected private node over trusted HTTPS.
 * - WorkbenchNetworkSidecarConfigurationSchema/WorkbenchNetworkPipeResponseSchema/WorkbenchNetworkCommandSchema: subprocess boundary.
 * - WorkbenchNetworkMember/WorkbenchNetworkConfiguration/WorkbenchNetworkRuntime/WorkbenchNetworkSnapshot: inferred state contracts.
 * - WorkbenchNetworkAction/WorkbenchNetworkResult/WorkbenchNetworkSidecarConfiguration/WorkbenchNetworkCommand: inferred intent/process contracts.
 * - WorkbenchNetworkModeSchema/workbenchNetworkMode: selected exposure mode and legacy flag conversion.
 * - WorkbenchNetworkRenameSchema: durable URL transition intent and activation phase.
 * - WorkbenchNetworkGroupSchema/WorkbenchNetworkGroup: directory authority, DNS selection and remote app grants.
 * - WorkbenchNetworkSettingsSchema/WorkbenchNetworkSettings: one explicit connection-settings draft.
 */
import { z } from "zod";
import { WorkbenchDaemonDiscoverySchema, WorkbenchDaemonIdentitySchema } from "./workbench-daemon-discovery.ts";

export const WORKBENCH_NETWORK_PATH = "/api/workbench-network";
export const WORKBENCH_NETWORK_PROTOCOL = 1;
export const WorkbenchNetworkVerificationSchema = z.object({
  hostname: z.string().max(253),
  nodeId: z.string().min(1).max(256),
}).strict();

const label = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/u);
export const WorkbenchNetworkModeSchema = z.enum(["localhost", "tailnet-ip", "tailnet-service"]);
const renameReservation = z.object({ id: z.uuid(), from: label, to: label }).strict();
export const WorkbenchNetworkRenameSchema = renameReservation.extend({
  phase: z.enum(["prepare", "activate", "retire"]),
}).strict();
const port = z.number().int().min(1).max(65_535);
const address = z.union([z.ipv4(), z.ipv6()]);
export const WorkbenchNetworkSettingsSchema = z.object({
  mode: WorkbenchNetworkModeSchema, localPort: port, tailnetPort: port,
  label: label.optional(), removeRegistration: z.boolean().default(false).optional(),
}).strict();
const issuer = z.object({
  address,
  hostname: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?\.wb\.inthedark\.boo$/u),
}).strict();
const privateConfiguration = z.discriminatedUnion("role", [
  z.object({ role: z.literal("unconfigured"), enabled: z.literal(false), label, nodeLabel: label.optional() }).strict(),
  z.object({ role: z.literal("authority"), enabled: z.boolean(), label, nodeLabel: label.optional() }).strict(),
  z.object({ role: z.literal("member"), enabled: z.boolean(), label, nodeLabel: label.optional(), issuer }).strict(),
]);

export const WorkbenchNetworkMemberSchema = z.object({
  nodeId: z.string().min(1).max(256),
  hostNodeId: z.string().min(1).max(256).optional(),
  published: z.boolean().optional(),
  label,
  keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  addresses: z.array(address).min(1).max(2),
  rename: renameReservation.optional(),
}).strict();

const nodeId = z.string().min(1).max(256);
export const WorkbenchNetworkGroupSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  ownerNodeId: nodeId,
  dnsNodeId: nodeId,
  access: z.enum(["all", "selected"]),
  grants: z.array(z.object({ deviceNodeId: nodeId, appNodeId: nodeId }).strict()).max(4096),
  transfer: z.object({
    id: z.uuid(),
    fromNodeId: nodeId,
    toNodeId: nodeId,
    phase: z.enum(["prepare", "relinquished", "activated"]),
  }).strict().optional(),
}).strict();

export const WorkbenchNetworkConfigurationSchema = z.object({
  mode: WorkbenchNetworkModeSchema.optional(),
  hostServe: z.object({ enabled: z.boolean(), port }).strict(),
  privateAccess: privateConfiguration.nullable(),
  members: z.array(WorkbenchNetworkMemberSchema).max(256),
  rename: WorkbenchNetworkRenameSchema.optional(),
  group: WorkbenchNetworkGroupSchema.optional(),
}).strict();

export function workbenchNetworkMode(configuration: WorkbenchNetworkConfiguration) {
  return configuration.mode ?? (configuration.privateAccess?.enabled
    ? "tailnet-service" : configuration.hostServe.enabled ? "tailnet-ip" : "localhost");
}

const modeStatus = z.object({
  phase: z.enum(["off", "starting", "login", "setup", "ready", "failed"]),
  message: z.string().max(512).nullable(),
  url: z.url().nullable(),
}).strict();

export const WorkbenchNetworkRuntimeSchema = z.object({
  hostServe: modeStatus,
  daemonServe: modeStatus.optional(),
  host: z.object({ hostname: z.string().max(253).nullable(), address: address.nullable(), nodeId: nodeId.nullable().optional() }).strict().optional(),
  privateAccess: modeStatus.extend({
    daemonUrl: z.url().nullable().optional(),
    hostname: z.string().max(253).nullable(),
    loginUrl: z.url().nullable(),
    nodeId: z.string().max(256).nullable(),
    keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).nullable().default(null),
    addresses: z.array(address).max(2),
    rootCertificate: z.string().max(16_384).nullable(),
    rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
    certificateExpiresAt: z.string().datetime().nullable(),
    pending: z.array(z.object({ id: z.string().min(1).max(64), member: WorkbenchNetworkMemberSchema }).strict()).max(4),
    discovery: z.enum(["searching", "none", "joined", "conflict", "failed"]).optional(),
    networks: z.array(z.object({ id: z.uuid(), ownerNodeId: nodeId, label }).strict()).max(256).optional(),
    devices: z.array(z.object({ nodeId, name: z.string().max(253), online: z.boolean() }).strict()).max(4096).optional(),
    pendingUpdates: z.array(nodeId).max(256).optional(),
  }).strict(),
}).strict();

export const WorkbenchNetworkSnapshotSchema = z.object({
  discovery: WorkbenchDaemonDiscoverySchema.optional(),
  daemon: WorkbenchDaemonIdentitySchema.optional(),
  configuration: WorkbenchNetworkConfigurationSchema,
  runtime: WorkbenchNetworkRuntimeSchema,
  executable: z.object({ available: z.boolean(), message: z.string().max(512).nullable() }).strict(),
  hostPlatform: z.string().max(32),
  busy: z.boolean(),
  failure: z.string().max(512).nullable(),
  localUrl: z.url().nullable().optional(),
  localPort: z.object({
    appOrigin: z.url(), currentPort: port, editable: z.boolean(), source: z.enum(["environment", "random", "setting"]),
  }).strict().optional(),
  change: z.object({
    phase: z.enum(["preparing", "prepared", "applying", "finalising", "failed", "returning"]),
    sourceOrigin: z.url(), destinationOrigin: z.url(),
  }).strict().nullable().optional(),
  capabilities: z.object({
    manageApp: z.boolean(), manageNetwork: z.boolean(), trustHost: z.boolean().default(false),
    localConnection: z.boolean().default(false).optional(), settingsApply: z.boolean().default(false).optional(),
  }).strict().optional(),
}).strict();

export const WorkbenchNetworkActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("daemon-discovery-refresh") }).strict(),
  z.object({ action: z.literal("daemon-wake-retry") }).strict(),
  z.object({ action: z.literal("access-prepare"), revision: z.number().int().min(1), access: z.enum(["all", "selected"]), grants: WorkbenchNetworkGroupSchema.shape.grants }).strict(),
  z.object({ action: z.literal("settings-prepare"), settings: WorkbenchNetworkSettingsSchema }).strict(),
  z.object({ action: z.literal("settings-finish"), token: z.uuid() }).strict(),
  z.object({ action: z.literal("settings-cancel"), token: z.uuid() }).strict(),
  z.object({ action: z.literal("settings-resume") }).strict(),
  z.object({ action: z.literal("mode"), mode: WorkbenchNetworkModeSchema }).strict(),
  z.object({ action: z.literal("tailnet-port"), port }).strict(),
  z.object({ action: z.literal("machine-name"), label }).strict(),
  z.object({ action: z.literal("host-serve"), enabled: z.boolean(), port }).strict(),
  z.object({ action: z.literal("prepare"), label }).strict(),
  z.object({ action: z.literal("private-access"), enabled: z.boolean() }).strict(),
  z.object({
    action: z.literal("create-setup"),
    clientId: z.string().trim().min(1).max(1024).optional(),
    clientSecret: z.string().trim().min(1).max(4096).optional(),
  }).strict(),
  z.object({ action: z.literal("discover") }).strict(),
  z.object({ action: z.literal("select-network"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("dns-app"), nodeId }).strict(),
  z.object({ action: z.literal("transfer-owner"), nodeId }).strict(),
  z.object({ action: z.literal("access"), revision: z.number().int().min(1), access: z.enum(["all", "selected"]), grants: WorkbenchNetworkGroupSchema.shape.grants }).strict(),
  z.object({ action: z.literal("pair-code") }).strict(),
  z.object({ action: z.literal("join"), code: z.string().min(1).max(32_768) }).strict(),
  z.object({ action: z.literal("approve"), requestId: z.string().min(1).max(64), approved: z.boolean() }).strict(),
  z.object({ action: z.literal("reconnect"), code: z.string().min(1).max(32_768) }).strict(),
  z.object({ action: z.literal("trust-host") }).strict(),
  z.object({ action: z.literal("remove-registration") }).strict(),
  z.object({ action: z.literal("retry") }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
]);

export const WorkbenchNetworkResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settings-pending"), token: z.uuid(), origin: z.url(), message: z.string().max(512) }).strict(),
  z.object({ kind: z.literal("handoff"), token: z.uuid(), origin: z.url(), returning: z.boolean() }).strict(),
  z.object({ kind: z.literal("settings-saved"), origin: z.url() }).strict(),
  z.object({ kind: z.literal("ok") }).strict(),
  z.object({ kind: z.literal("pairing-code"), code: z.string().max(32_768) }).strict(),
  z.object({
    kind: z.literal("setup"),
    privateAccess: privateConfiguration,
    members: z.array(WorkbenchNetworkMemberSchema).max(256),
    group: WorkbenchNetworkGroupSchema.optional(),
  }).strict(),
]);

export const WorkbenchNetworkSidecarConfigurationSchema = z.object({
  configuration: WorkbenchNetworkConfigurationSchema,
  appOrigin: z.url().nullable(),
  daemonOrigin: z.url().nullable(),
  daemonPort: port.nullable(),
  publishDaemon: z.boolean().optional(),
  privateAppAllowed: z.boolean().optional(),
  preparing: z.boolean(),
  ingressToken: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  daemonIngressToken: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  retainedHostPort: port.optional(),
}).strict();

export const WorkbenchNetworkPipeResponseSchema = z.union([
  z.object({ event: z.literal("daemon-discovery"), snapshot: WorkbenchDaemonDiscoverySchema }).strict(),
  z.object({ event: z.literal("status"), snapshot: WorkbenchNetworkRuntimeSchema }).strict(),
  z.object({
    event: z.literal("persist-member"), id: z.string().min(1).max(64),
    previous: WorkbenchNetworkMemberSchema.nullable(), member: WorkbenchNetworkMemberSchema,
  }).strict(),
  z.object({
    event: z.literal("persist-network"), id: z.string().min(1).max(64),
    previousRevision: z.number().int().min(1).nullable(),
    configuration: WorkbenchNetworkConfigurationSchema,
  }).strict(),
  z.object({ id: z.string().min(1).max(64), result: WorkbenchNetworkResultSchema }).strict(),
  z.object({ id: z.string().min(1).max(64), error: z.string().min(1).max(512) }).strict(),
]);

export const WorkbenchNetworkCommandSchema = z.union([
  WorkbenchNetworkActionSchema,
  WorkbenchNetworkSidecarConfigurationSchema.extend({ action: z.literal("configure") }).strict(),
  z.object({
    action: z.literal("approve-member"),
    requestId: z.string().min(1).max(64),
    member: WorkbenchNetworkMemberSchema.nullable(),
  }).strict(),
  renameReservation.extend({ action: z.enum(["rename-prepare", "rename-activate", "rename-retire"]) }).strict(),
]);

export type WorkbenchNetworkMember = z.infer<typeof WorkbenchNetworkMemberSchema>;
export type WorkbenchNetworkSettings = z.infer<typeof WorkbenchNetworkSettingsSchema>;
export type WorkbenchNetworkGroup = z.infer<typeof WorkbenchNetworkGroupSchema>;
export type WorkbenchNetworkConfiguration = z.infer<typeof WorkbenchNetworkConfigurationSchema>;
export type WorkbenchNetworkRuntime = z.infer<typeof WorkbenchNetworkRuntimeSchema>;
export type WorkbenchNetworkSnapshot = z.infer<typeof WorkbenchNetworkSnapshotSchema>;
export type WorkbenchNetworkAction = z.infer<typeof WorkbenchNetworkActionSchema>;
export type WorkbenchNetworkResult = z.infer<typeof WorkbenchNetworkResultSchema>;
export type WorkbenchNetworkSidecarConfiguration = z.infer<typeof WorkbenchNetworkSidecarConfigurationSchema>;
export type WorkbenchNetworkCommand = z.infer<typeof WorkbenchNetworkCommandSchema>;
