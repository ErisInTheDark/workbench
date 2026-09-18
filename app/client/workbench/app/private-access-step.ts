/*
 * Default export:
 * - privateAccessStep: derive the one actionable private-network setup stage.
 */
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import type { WorkbenchHttpsVerification } from "./WorkbenchNetworkClient";

export default function privateAccessStep(snapshot: WorkbenchNetworkSnapshot, verification: WorkbenchHttpsVerification["phase"], dnsConfirmed: boolean) {
  const status = snapshot.runtime.privateAccess;
  const configuration = snapshot.configuration.privateAccess;
  if (!snapshot.executable.available || status.phase === "failed") return "failed";
  if (status.loginUrl) return "signin";
  if (status.phase === "starting") return "connecting";
  if (!configuration || status.phase === "off") return "prepare";
  if (!status.nodeId) return "connecting";
  if (configuration.role === "unconfigured") {
    if (status.discovery === "failed") return "failed";
    if (status.discovery === "conflict") return "choose";
    if (status.discovery === "none") return "create";
    return "discovering";
  }
  if (!status.rootCertificate || !snapshot.configuration.group) return "connecting";
  if (verification === "verified") return "ready";
  if (verification === "idle" || verification === "checking") return "checking";
  const group = snapshot.configuration.group;
  if (!dnsConfirmed && snapshot.capabilities?.manageNetwork && group.revision === 1 && group.ownerNodeId === status.nodeId) return "dns";
  return "trust";
}
