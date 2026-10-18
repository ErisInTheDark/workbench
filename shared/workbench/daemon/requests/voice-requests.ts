/*
 * Exports:
 * - voiceDaemonRequests: daemon requests for voice configuration, agents and capture sessions.
 */
import { z } from "zod";
import type { WorkbenchAgentOption } from "../../../types.ts";
import { VoiceConfigurationSchema, type VoiceAudio, type VoiceConfiguration, type VoiceStart } from "../../voice/voice-session-contract.ts";
import { defineDaemonRequest } from "../define-daemon-request.ts";

const ok = z.object({ ok: z.literal(true) }).strict();

export const voiceDaemonRequests = {
  "voice/configuration/read": defineDaemonRequest<object, VoiceConfiguration>()({ route: "installation", result: VoiceConfigurationSchema }),
  "voice/configuration/write": defineDaemonRequest<VoiceConfiguration, { ok: true }>()({ route: "installation", result: ok }),
  "voice/agents": defineDaemonRequest<object, { data: WorkbenchAgentOption[] }>()({
    route: "installation",
    result: z.object({ data: z.array(z.object({
      name: z.string(), path: z.string(), description: z.string(), source: z.literal("library"), sourceLabel: z.string(),
    }).passthrough()) }),
  }),
  "voice/prepare": defineDaemonRequest<object, { ok: true }>()({ route: "installation", result: ok }),
  "voice/start": defineDaemonRequest<VoiceStart, { ok: true }>()({ route: "installation", result: ok }),
  "voice/audio": defineDaemonRequest<VoiceAudio, { ok: true }>()({ route: "session", result: ok }),
  "voice/finish": defineDaemonRequest<{ sessionId: string }, { ok: true }>()({ route: "session", result: ok }),
  "voice/cancel": defineDaemonRequest<{ sessionId: string }, { ok: true }>()({ route: "session", result: ok }),
};
