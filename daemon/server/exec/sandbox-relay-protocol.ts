/*
 * Exports:
 * - RELAY_SIDECAR_ARTIFACT: committed Linux sandbox relay sidecar description.
 * - RELAY_ENV_KEY: environment variable carrying one command's broker address and token into the relay.
 * - RELAY_MESSAGE_BYTES: longest newline-delimited message either side accepts.
 * - RelayMessageSchema/RelayMessage: what a relay sends on its control connection or as a data connection's first line.
 * - BrokerMessage/encodeBrokerMessage: what the broker sends a relay, as one newline-delimited JSON line.
 * Mirrors `daemon/relay/protocol.go`.
 */
import { z } from "zod";
import type { NativeSidecarArtifact } from "workbench-shared/native/native-sidecar-artifact";

export const RELAY_SIDECAR_ARTIFACT: NativeSidecarArtifact = {
  label: "relay", buildScript: "build:relay", source: "daemon/relay", executable: "workbench-relay", protocol: 1,
};

export const RELAY_ENV_KEY = "WB_RELAY";
export const RELAY_MESSAGE_BYTES = 64 * 1024;

const port = z.number().int().min(1).max(65_535);
const token = z.string().min(1);

export const RelayMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token }),
  z.object({ type: z.literal("sandboxPorts"), ports: z.array(port) }),
  z.object({ type: z.literal("accept"), token, id: z.string().min(1) }),
]);
export type RelayMessage = z.infer<typeof RelayMessageSchema>;

export type BrokerMessage =
  | { type: "hostPorts"; ports: number[] }
  | { type: "open"; id: string; port: number };

export function encodeBrokerMessage(message: BrokerMessage) {
  return `${JSON.stringify(message)}\n`;
}
