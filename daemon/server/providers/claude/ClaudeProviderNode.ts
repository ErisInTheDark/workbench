/*
 * Exports:
 * - default ClaudeProviderNode: expose native Claude sessions, managed tools, Browse screenshot delivery, unfinished-turn continuation, model choices with context bounds, plan limits, account sign-in, and session-log usage hydration.
 */
import ReloadableNode from "../../runtime/ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import createWorkbenchSandboxShell, { WORKBENCH_SANDBOX_SHELL_REQUIRES } from "../../exec/WorkbenchSandboxShell";
import ClaudeToolsController from "./ClaudeToolsController";
import ClaudeSignInController from "./ClaudeSignInController";
import ProviderSignInSession from "../ProviderSignInSession";
import { resolveProviderRuntime } from "../provider-runtimes";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (context, { get }) => {
    const threads = get("claudeThreadOperations");
    const tools = new ClaudeToolsController({
      threads, transcript: get("claudeTranscriptAdapter"),
      prepareExecution: createWorkbenchSandboxShell(context, { get }),
    });
    const configuration = get("claudeConfiguration");
    const signIn = new ProviderSignInSession({
      provider: "claude",
      adapter: new ClaudeSignInController({
        resolveExecutable: () => resolveProviderRuntime(context.dataRootPath, "claude", context.providerRuntimePins.claude()).executable,
      }),
    });
    return {
      registrations: {
        claudeProvider: {
          threads, tools, interactions: threads.interactions, context: threads.context, browse: threads.browse,
          usage: threads.usage,
          account: { limits: { read: () => configuration.accountLimits() }, signIn },
          configuration: {
            modelContext: { read: () => configuration.modelContext() },
            models: { read: () => configuration.models() },
            guidance: { contains: async sections => sections.map(() => false) },
          },
        },
      },
      start: () => undefined,
      dispose: () => signIn.dispose(),
    };
  },
  description: "Reload Claude provider definition.",
  lifecycle: "atomic",
  provides: ["claudeProvider"],
  requires: ["claudeConfiguration", "claudeThreadOperations", "claudeTranscriptAdapter", ...WORKBENCH_SANDBOX_SHELL_REQUIRES],
  safeAll: true,
  scope: "server:claude/def",
});
