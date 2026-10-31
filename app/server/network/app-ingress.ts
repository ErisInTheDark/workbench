/*
 * Exports:
 * - isForwardedRequest: whether the network relay forwarded a request from a device rather than the browser connecting directly.
 * - admitsAppConnection: whether an app listener may serve a request: a loopback socket, and forwarded only with valid ingress proof.
 */
import type { IncomingMessage } from "node:http";
import { isLoopbackConnection } from "workbench-shared/http/loopback-connection";
import type WorkbenchNetworkController from "./WorkbenchNetworkController.ts";

export function isForwardedRequest(request: IncomingMessage) {
  return Object.keys(request.headers).some(key => key.startsWith("x-workbench-network-") && key !== "x-workbench-network-request");
}

/** Device access was decided by the relay before forwarding; the ingress token proves the relay did the forwarding. */
export function admitsAppConnection(request: IncomingMessage, network: Pick<WorkbenchNetworkController, "ingress"> | undefined) {
  return Boolean(isLoopbackConnection(request.socket) && (!isForwardedRequest(request) || network?.ingress(request.headers)));
}
