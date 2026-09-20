/*
 * Exports:
 * - ThreadItem: Workbench transcript item contract, independent of provider schemas.
 * - JsonValue: opaque structured provider/tool evidence.
 * - UserInput/TextElement/ImageDetail: persisted user content and annotated spans.
 * - FunctionCallOutputContentItem/FunctionCallOutputBody/TurnToolOutput: tool-produced content.
 * - CommandAction/CommandExecutionSource/CommandExecutionStatus: command presentation facts.
 * - FileUpdateChange/PatchChangeKind/PatchApplyStatus: attempted file changes.
 * - DynamicToolCallOutputContentItem/DynamicToolCallStatus: callable tool output.
 * - McpToolCallAppContext/McpToolCallError/McpToolCallResult/McpToolCallStatus: MCP presentation.
 * - MessagePhase/AgentMessageDelivery/AsyncUserInputQuestion: assistant delivery metadata.
 * - MemoryCitation/MemoryCitationEntry: cited source locations.
 * - WebSearchAction/WebSearchItem: search requests and preserved results.
 * - CollabAgentTool/CollabAgentToolCallStatus/CollabAgentState/CollabAgentStatus: retained collaboration facts.
 * - SubAgentActivityKind/HookPromptFragment: retained activity and prompt evidence.
 * - ImageGenerationItem/ImageGenerationFailure/SleepItem: image generation and waits.
 */
import type { ToolPatchPreviewFile } from "./tool-patch-preview.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key in string]?: JsonValue };
export type ImageDetail = "auto" | "low" | "high" | "original";
export type TextElement = {
  byteRange: { start: number; end: number };
  placeholder: string | null;
}
export type UserInput =
  | { type: "text"; text: string; text_elements: TextElement[] }
  | { type: "image"; detail?: ImageDetail; url: string }
  | { type: "localImage"; detail?: ImageDetail; path: string }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type FunctionCallOutputContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: ImageDetail }
  | { type: "input_audio"; audio_url: string }
  | { type: "encrypted_content"; encrypted_content: string };
export type FunctionCallOutputBody = string | FunctionCallOutputContentItem[];
export type TurnToolOutput = {
  name: string;
  namespace: string | null;
  output: FunctionCallOutputBody;
}

export type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };
export type CommandExecutionSource = "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";
export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";
export type PatchChangeKind = { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
export type FileUpdateChange = { path: string; kind: PatchChangeKind; diff: string };
export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined";
export type DynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string }
  | { type: "inputAudio"; audioUrl: string };
export type DynamicToolCallStatus = "inProgress" | "completed" | "failed";
export type McpToolCallStatus = "inProgress" | "completed" | "failed";
export type McpToolCallAppContext = {
  connectorId: string;
  linkId: string | null;
  resourceUri: string | null;
  appName: string | null;
  actionName: string | null;
}
export type McpToolCallError = { message: string };
export type McpToolCallResult = {
  content: JsonValue[];
  structuredContent: JsonValue | null;
  _meta: JsonValue | null;
}
export type MessagePhase = "commentary" | "final_answer";
export type AgentMessageDelivery = "async";
export type AsyncUserInputQuestion = { title: string; options: string[] | null };
export type MemoryCitationEntry = { path: string; lineStart: number; lineEnd: number; note: string };
export type MemoryCitation = { entries: MemoryCitationEntry[]; threadIds: string[] };
export type WebSearchAction =
  | { type: "search"; query: string | null; queries: string[] | null }
  | { type: "openPage"; url: string | null }
  | { type: "findInPage"; url: string | null; pattern: string | null }
  | { type: "other" };
export type WebSearchItem = {
  id: string;
  query: string;
  action: WebSearchAction | null;
  results: JsonValue[] | null;
}
export type CollabAgentTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | "sendMessage" | "followupTask" | "interruptAgent" | "listAgents";
export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed" | "interrupted";
export type CollabAgentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound";
export type CollabAgentState = { status: CollabAgentStatus; message: string | null };
export type SubAgentActivityKind = "started" | "interacted" | "interrupted" | "completed";
export type HookPromptFragment = { text: string; hookRunId: string };
export type ImageGenerationFailure = { type: "usageLimitExceeded"; limitId: string; resetsAt: number | null };
export type ImageGenerationItem = {
  id: string;
  status: string;
  revisedPrompt: string | null;
  result: string;
  transparentBackground?: boolean;
  failure: ImageGenerationFailure | null;
  savedPath?: string;
}
export type SleepItem = { id: string; durationMs: number };

// Field spellings preserve the established wire/storage contract, not a dependency
// on a provider's generated schema. Providers translate into this owned shape.
export type ThreadItem =
  | { type: "generic"; id: string; nativeType: string; safeValue: JsonValue }
  | { type: "userMessage"; id: string; clientId: string | null; content: UserInput[] }
  | { type: "hookPrompt"; id: string; fragments: HookPromptFragment[] }
  | {
    type: "agentMessage"; id: string; text: string; phase: MessagePhase | null;
    memoryCitation: MemoryCitation | null; delivery: AgentMessageDelivery | null; questions: AsyncUserInputQuestion[] | null;
  }
  | ({ type: "functionCallOutput"; id: string } & TurnToolOutput)
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
    type: "commandExecution"; id: string; pluginId: string | null; scriptPath: string | null;
    command: string; cwd: string; processId: string | null; source: CommandExecutionSource;
    status: CommandExecutionStatus; commandActions: CommandAction[]; aggregatedOutput: string | null;
    exitCode: number | null; durationMs: number | null;
  }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: PatchApplyStatus }
  | {
    type: "mcpToolCall"; id: string; server: string; tool: string; status: McpToolCallStatus; arguments: JsonValue;
    appContext: McpToolCallAppContext | null; mcpAppResourceUri?: string; pluginId: string | null;
    readOnlyHint: boolean | null; result: McpToolCallResult | null; error: McpToolCallError | null; durationMs: number | null;
    toolCallGroupId?: string;
  }
  | {
    type: "dynamicToolCall"; id: string; namespace: string | null; tool: string; arguments: JsonValue;
    status: DynamicToolCallStatus; contentItems: DynamicToolCallOutputContentItem[] | null; success: boolean | null; durationMs: number | null;
    toolCallGroupId?: string;
    metadata?: JsonValue;
    /** Live presentation only; callable-source persistence deliberately excludes this field. */
    patchPreview?: ToolPatchPreviewFile[];
  }
  | {
    type: "collabAgentToolCall"; id: string; tool: CollabAgentTool; status: CollabAgentToolCallStatus;
    senderThreadId: string; receiverThreadIds: string[]; prompt: string | null; model: string | null;
    reasoningEffort: string | null;
    agentsStates: { [key: string]: CollabAgentState | undefined };
  }
  | { type: "subAgentActivity"; id: string; kind: SubAgentActivityKind; agentThreadId: string; agentPath: string }
  | ({ type: "webSearch" } & WebSearchItem)
  | { type: "imageView"; id: string; path: string }
  | ({ type: "sleep" } & SleepItem)
  | ({ type: "imageGeneration" } & ImageGenerationItem)
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string };
