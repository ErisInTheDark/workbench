/* Exports:
 * - default WorkbenchVoiceNode: reloadable private voice runtime and configuration.
 */
import path from "node:path";
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import VoiceRecognizerProcess from "./voice/VoiceRecognizerProcess";
import WorkbenchVoiceController from "./voice/WorkbenchVoiceController";
import { buildWorkbenchPromptInstructions } from "./lib/workbench/instructions/workbench-prompt-assembly";
import { filterWorkbenchInstructionContent, formatWorkbenchInstructionFilterWarning } from "./lib/workbench/instructions/instruction-context-filter";
import { listWorkbenchLibraryAgents } from "./lib/workbench-library";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent", children: [WorkbenchWebSocketNode], lifecycle: "atomic",
  scope: "server:voice", safeAll: true,
  description: "Reload native recognition, voice model selection and transformer sessions.",
  provides: ["voice"],
  requires: ["voiceSettings"],
  sources: ["daemon/server/WorkbenchVoiceNode.ts", "daemon/server/voice/**", "shared/workbench/voice/**"].join("\n"),
  create(context, { get, run }) {
    const settings = get("voiceSettings");
    const providers = new WorkbenchProviderDispatcher(run);
    let controller!: WorkbenchVoiceController;
    const recognizer = new VoiceRecognizerProcess(
      path.resolve(context.daemonPackageRoot, "../.workbench/native-voice/runtime.json"),
      event => controller.native(event), error => controller.fail(error),
    );
    controller = new WorkbenchVoiceController({
      recognizer, resolveSettings: () => settings.resolve(),
      provider: selection => {
        const key = installedProviderKeys.find(key => key === selection.harness);
        if (!key) throw new Error("The selected voice provider is not installed.");
        const capability = providers.get(key).singleFile;
        if (!capability) throw new Error("The selected provider does not support single-file editing.");
        return capability;
      },
      async instructions(selection) {
        const prompt = await buildWorkbenchPromptInstructions({ role: "voice-to-text", harness: selection.harness });
        const filtered = filterWorkbenchInstructionContent(prompt.baseInstructions, {
          role: "voice-to-text", harness: selection.harness, model: selection.model,
          shell: process.platform === "win32" ? "pwsh" : "bash", available: new Set(),
          field: "voice AGENTS.md", onWarning: warning => console.warn(formatWorkbenchInstructionFilterWarning(warning)),
        });
        if (!filtered) throw new Error("Voice instructions are empty.");
        return filtered;
      },
    });
    return {
      registrations: { voice: { controller, settings, agents: listWorkbenchLibraryAgents } },
      start() {},
      dispose: () => controller.dispose(),
    };
  },
});
