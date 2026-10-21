/*
 * Exports:
 * - OPENCODE_CONSOLE_INTEGRATION: OpenCode's own console login, the provider row's main sign-in.
 * - openCodeAccountIntegrations: map OpenCode integrations to Workbench sign-in choices, console first.
 * - OpenCodeSignInClient: the OpenCode client calls sign-in needs.
 * - default OpenCodeSignInController: connect and disconnect OpenCode integrations through its service's integration API.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { IntegrationInfo, OpenCodeClient } from "@opencode/client";
import type { ProviderAccountIntegration, ProviderSignInMethod } from "workbench-shared/workbench/provider/provider-account-sign-in";
import type { ProviderSignInAdapter, ProviderSignInFlow } from "../ProviderSignInSession";

export const OPENCODE_CONSOLE_INTEGRATION = "opencode";
const KEY_METHOD = "key";
const STATUS_POLL_MS = 2_000;

export type OpenCodeSignInClient = Pick<OpenCodeClient, "integration" | "credential">;

function methods(info: IntegrationInfo): ProviderSignInMethod[] {
  return info.methods.flatMap((method): ProviderSignInMethod[] => {
    if (method.type === "oauth") return [{ id: method.id, label: method.label, kind: "browser" }];
    if (method.type === "key") return [{ id: KEY_METHOD, label: method.label ?? "API key", kind: "key" }];
    // Command, external and environment methods need the daemon machine's own terminal or shell.
    return [];
  });
}

export function openCodeAccountIntegrations(infos: readonly IntegrationInfo[]): ProviderAccountIntegration[] {
  return infos.flatMap((info): ProviderAccountIntegration[] => {
    const choices = methods(info);
    if (!choices.length && !info.connections.length) return [];
    const connection = info.connections[0];
    return [{
      id: info.id, label: info.name, primary: info.id === OPENCODE_CONSOLE_INTEGRATION,
      signedIn: info.connections.length > 0,
      accountLabel: !connection ? null : connection.type === "credential" ? connection.label || null : connection.name,
      methods: choices,
    }];
  }).sort((left, right) => Number(right.primary) - Number(left.primary)
    || Number(right.signedIn) - Number(left.signedIn) || left.label.localeCompare(right.label));
}

export default class OpenCodeSignInController implements ProviderSignInAdapter {
  constructor(private readonly acquire: () => Promise<OpenCodeSignInClient>) {}

  async read() {
    return openCodeAccountIntegrations((await (await this.acquire()).integration.list()).data);
  }

  async begin(integrationID: string, methodID: string, signal: AbortSignal): Promise<ProviderSignInFlow> {
    const client = await this.acquire();
    const { data: attempt } = await client.integration.oauth.connect({ integrationID, methodID });
    const { attemptID } = attempt;
    return {
      url: attempt.url, userCode: null, acceptsCode: attempt.mode === "code",
      // OpenCode reports its own expiry through status, which ends the attempt sooner.
      expiresAt: null,
      settled: this.follow(client, integrationID, attemptID, signal),
      submitCode: async code => { await client.integration.oauth.complete({ integrationID, attemptID, code }); },
      cancel: async () => { await client.integration.oauth.cancel({ integrationID, attemptID }); },
    };
  }

  async connectKey(integrationID: string, methodId: string, key: string) {
    if (methodId !== KEY_METHOD) throw new Error("Unknown OpenCode sign-in method.");
    await (await this.acquire()).integration.connect.key({ integrationID, key });
  }

  async signOut(integrationID: string) {
    const client = await this.acquire();
    const { data } = await client.integration.get({ integrationID });
    for (const connection of data.connections) {
      if (connection.type === "credential") await client.credential.remove({ credentialID: connection.id });
    }
  }

  /** OpenCode exposes attempt progress only as status reads; the attempt's signal ends polling. */
  private async follow(client: OpenCodeSignInClient, integrationID: string, attemptID: string, signal: AbortSignal) {
    for (;;) {
      await delay(STATUS_POLL_MS, undefined, { signal });
      const { data } = await client.integration.oauth.status({ integrationID, attemptID });
      if (data.status === "complete") return;
      if (data.status === "failed") throw new Error(data.message || "OpenCode sign-in failed.");
      if (data.status === "expired") throw new Error("Sign-in expired. Try again.");
    }
  }
}
