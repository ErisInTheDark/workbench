/*
 * Exports:
 * - default WorkbenchNetworkRepository: own private app-local network configuration and membership transactions.
 */
import { isIP } from "node:net";
import { WorkbenchNetworkConfigurationSchema, workbenchNetworkMode, type WorkbenchNetworkConfiguration } from "workbench-shared/http/workbench-network";
import { deleteRows, insertRow, selectRows, type WorkbenchDatabaseMutation } from "workbench-shared/database/workbench-database-statements";
import { workbenchNetworkTables as tables } from "workbench-shared/state/workbench-network-state-schema";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";

export default class WorkbenchNetworkRepository {
  constructor(private readonly database: Pick<WorkbenchAppStateRepository, "query" | "executeTransaction">) {}

  read(): WorkbenchNetworkConfiguration {
    const host = this.database.query(selectRows(tables.networkHostServe))[0];
    const privateAccess = this.database.query(selectRows(tables.networkPrivateAccess))[0];
    const issuer = this.database.query(selectRows(tables.networkPrivateIssuer))[0];
    const selected = this.database.query(selectRows(tables.networkMode))[0];
    const identity = this.database.query(selectRows(tables.networkIdentity))[0];
    const rename = this.database.query(selectRows(tables.networkRename))[0];
    const reservations = this.database.query(selectRows(tables.networkMemberRenames));
    const members = this.database.query(selectRows(tables.networkMembers, { orderBy: [{ column: "node_id" }] }));
    const addresses = this.database.query(selectRows(tables.networkMemberAddresses, { orderBy: [{ column: "family" }] }));
    if (privateAccess?.role === "member" && !issuer) throw new Error("Private network issuer metadata is incomplete.");
    // Version 10 flags are only a read-repair input until the first mode write.
    const mode = selected?.mode ?? (privateAccess?.enabled === 1 ? "tailnet-service" : host?.enabled === 1 ? "tailnet-ip" : "localhost");
    return WorkbenchNetworkConfigurationSchema.parse({
      mode,
      hostServe: { enabled: mode !== "localhost", port: host?.port ?? 8080 },
      privateAccess: privateAccess ? {
        enabled: mode === "tailnet-service" && privateAccess.role !== "unconfigured",
        label: privateAccess.label,
        nodeLabel: identity?.node_label ?? privateAccess.label,
        role: privateAccess.role,
        ...(privateAccess.role === "member" && issuer ? { issuer: { address: issuer.address, hostname: issuer.hostname } } : {}),
      } : null,
      ...(rename ? { rename: { id: rename.operation_id, from: rename.previous_label, to: rename.next_label, phase: rename.phase } } : {}),
      members: members.map(member => {
        const reservation = reservations.find(item => item.node_id === member.node_id);
        return {
          nodeId: member.node_id,
          label: member.label,
          keyFingerprint: member.key_fingerprint,
          addresses: addresses.filter(address => address.node_id === member.node_id).map(address => address.address),
          ...(reservation ? { rename: { id: reservation.operation_id, from: reservation.previous_label, to: reservation.next_label } } : {}),
        };
      }),
    });
  }

  write(configuration: WorkbenchNetworkConfiguration) {
    const parsed = WorkbenchNetworkConfigurationSchema.parse(configuration);
    const mode = workbenchNetworkMode(parsed);
    const next = {
      ...parsed, mode,
      hostServe: { ...parsed.hostServe, enabled: mode !== "localhost" },
      privateAccess: parsed.privateAccess ? {
        ...parsed.privateAccess,
        enabled: parsed.privateAccess.role !== "unconfigured" && mode === "tailnet-service",
        nodeLabel: parsed.privateAccess.nodeLabel ?? parsed.privateAccess.label,
      } : null,
    };
    const current = this.read();
    if (current.rename) {
      const previous = current.rename;
      const rename = next.rename;
      const validPhase = previous.phase === rename?.phase
        || (previous.phase === "prepare" && rename?.phase === "activate")
        || (previous.phase === "activate" && rename?.phase === "retire");
      if (rename
        ? rename.id !== previous.id || rename.from !== previous.from || rename.to !== previous.to || !validPhase
        : previous.phase !== "retire") {
        throw new Error("Finish the pending URL rename without replacing or discarding its operation.");
      }
    }
    for (const previous of current.members) {
      if (!previous.rename) continue;
      const member = next.members.find(candidate => candidate.nodeId === previous.nodeId);
      if (!member || member.keyFingerprint !== previous.keyFingerprint || (member.rename
        ? member.rename.id !== previous.rename.id || member.rename.from !== previous.rename.from || member.rename.to !== previous.rename.to
        : member.label !== previous.rename.to)) {
        throw new Error("Finish the member's pending URL rename before replacing its registration.");
      }
    }
    if (current.privateAccess && next.privateAccess?.nodeLabel !== current.privateAccess.nodeLabel) {
      throw new Error("The installation's internal node name cannot change.");
    }
    if (current.privateAccess && next.privateAccess?.label !== current.privateAccess.label
      && !(current.rename?.to === next.privateAccess?.label && current.rename?.phase === "activate" && next.rename?.phase === "retire")) {
      throw new Error("Prepare and activate the URL rename before changing its address.");
    }
    if (next.rename && (!next.privateAccess || next.rename.from === next.rename.to
      || next.privateAccess.label !== (next.rename.phase === "retire" ? next.rename.to : next.rename.from))) {
      throw new Error("Pending URL rename does not match the installation's active address.");
    }
    const labels = new Map<string, string>();
    for (const member of next.members) {
      for (const label of [member.label, ...(member.rename ? [member.rename.from, member.rename.to] : [])]) {
        if (labels.has(label) && labels.get(label) !== member.nodeId) throw new Error("That machine label belongs to another installation.");
        labels.set(label, member.nodeId);
      }
      if (member.rename && member.label !== member.rename.from) throw new Error("Member rename must reserve its current address.");
    }
    const statements: WorkbenchDatabaseMutation[] = [
      deleteRows(tables.networkMode, { id: "singleton" }),
      deleteRows(tables.networkHostServe, { id: "singleton" }),
      deleteRows(tables.networkPrivateAccess, { id: "singleton" }),
      ...current.members.map(member => deleteRows(tables.networkMembers, { node_id: member.nodeId })),
      insertRow(tables.networkMode, { id: "singleton", mode }),
      // Superseded flags no longer store independent intent.
      insertRow(tables.networkHostServe, { id: "singleton", enabled: 0, port: next.hostServe.port }),
    ];
    if (next.privateAccess) {
      statements.push(insertRow(tables.networkPrivateAccess, {
        id: "singleton",
        enabled: 0,
        label: next.privateAccess.label,
        role: next.privateAccess.role,
      }));
      statements.push(insertRow(tables.networkIdentity, { id: "singleton", node_label: next.privateAccess.nodeLabel }));
      if (next.rename) statements.push(insertRow(tables.networkRename, {
        id: "singleton", operation_id: next.rename.id, previous_label: next.rename.from, next_label: next.rename.to, phase: next.rename.phase,
      }));
      if (next.privateAccess.role === "member") {
        statements.push(insertRow(tables.networkPrivateIssuer, {
          id: "singleton", role: "member", ...next.privateAccess.issuer,
        }));
      }
    }
    for (const member of next.members) {
      statements.push(insertRow(tables.networkMembers, {
        node_id: member.nodeId, label: member.label, key_fingerprint: member.keyFingerprint,
      }));
      if (member.rename) statements.push(insertRow(tables.networkMemberRenames, {
        node_id: member.nodeId, operation_id: member.rename.id, previous_label: member.rename.from, next_label: member.rename.to,
      }));
      for (const address of member.addresses) statements.push(insertRow(tables.networkMemberAddresses, {
        node_id: member.nodeId, family: isIP(address) === 4 ? "ipv4" : "ipv6", address,
      }));
    }
    this.database.executeTransaction(statements);
  }
}
