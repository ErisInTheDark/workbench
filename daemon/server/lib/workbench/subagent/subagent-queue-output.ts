/*
 * Exports:
 * - renderSubagentQueueInfo: markdown status of one queue (holder, waiters, freeze, last release).
 * - renderSubagentQueueGranted: join result once the caller holds the queue.
 * - renderSubagentQueueLeft: result when the caller leaves or is removed from a queue.
 * - renderSubagentQueueNotice: agent-message notices sent by a queue to a member.
 * - renderSubagentQueueReleaseNote: line appended to the parent's subagent_wait result.
 */
import type { SubagentQueueMember, SubagentQueueState } from "../../../WorkbenchSubagentQueueController";

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function dequeueCall(queue: string, name?: string) {
  return `subagent_dequeue({ queue: "${queue}"${name ? `, name: "${name}"` : ""} })`;
}

function memberLine(member: SubagentQueueMember, index: number, now: number) {
  const state = member.holdStartedAt === null
    ? `waiting ${formatDuration(now - member.enqueuedAt)}`
    : `holding ${formatDuration(now - member.holdStartedAt)}${member.pausedReason ? ` (paused: ${member.pausedReason})` : ""}`;
  return `${index + 1}. **${member.name}**: ${state} - ${member.description}`;
}

export function renderSubagentQueueInfo(queue: SubagentQueueState, now: number, declared = false) {
  const lines = [`## queue \`${queue.name}\``];
  if (declared) lines.push(`Declared queue \`${queue.name}\`. Give subagents this exact name.`);
  if (queue.frozen) lines.push("Frozen: the parent agent is not working, so nobody is promoted until it resumes.");
  lines.push(...(queue.members.length ? queue.members.map((member, index) => memberLine(member, index, now)) : ["No members."]));
  const holder = queue.members[0];
  if (holder?.pausedReason) {
    lines.push(`Paused until ${holder.name} resumes, or the parent runs ${dequeueCall(queue.name, holder.name)}.`);
  }
  if (queue.lastRelease) {
    lines.push(`Last release: ${queue.lastRelease.name} (${queue.lastRelease.reason}, ${formatDuration(now - queue.lastRelease.at)} ago).`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderSubagentQueueGranted(queue: SubagentQueueState, now: number) {
  const next = queue.members[1];
  return [
    `You hold queue \`${queue.name}\`. Do the held work, then call ${dequeueCall(queue.name)} right away.`,
    ...(queue.lastRelease ? [`Previous holder: ${queue.lastRelease.name} (${queue.lastRelease.reason}).`] : []),
    next
      ? `Next up: ${next.name} - ${next.description}${queue.members.length > 2 ? ` (${queue.members.length - 2} more waiting)` : ""}.`
      : "Nobody is waiting behind you.",
    "",
    renderSubagentQueueInfo(queue, now),
  ].join("\n");
}

export function renderSubagentQueueLeft(queue: SubagentQueueState, reason: "left" | "removed" | "stopped", now: number) {
  const headline = reason === "left"
    ? `You left queue \`${queue.name}\`.`
    : reason === "removed"
      ? `The parent agent removed you from queue \`${queue.name}\`. Do not run the held work; join again only if the parent asks.`
      : `You were removed from queue \`${queue.name}\` because your thread stopped.`;
  return `${headline}\n\n${renderSubagentQueueInfo(queue, now)}`;
}

export function renderSubagentQueueNotice(queue: string, kind: "front" | "resumed" | "removed" | "moved") {
  switch (kind) {
    case "moved":
      return {
        message: `The parent agent moved you back in queue \`${queue}\`, so you no longer hold it. Stop the held work, then call subagent_queue({ queue: "${queue}", description }) to wait for your turn again; you keep your new place.`,
        userVisibleSimpleVersion: `The parent moved this agent back in the ${queue} queue.`,
      };
    case "front":
      return {
        message: `You reached the front of queue \`${queue}\` and now hold it. Do the held work now, then call ${dequeueCall(queue)}.`,
        userVisibleSimpleVersion: `It is this agent's turn in the ${queue} queue.`,
      };
    case "resumed":
      return {
        message: `You still hold queue \`${queue}\`; it was paused while your turn was over. Finish the held work, then call ${dequeueCall(queue)}.`,
        userVisibleSimpleVersion: `This agent still holds the ${queue} queue.`,
      };
    case "removed":
      return {
        message: `The parent agent removed you from queue \`${queue}\`. Stop any held work; join again only if the parent asks.`,
        userVisibleSimpleVersion: `The parent removed this agent from the ${queue} queue.`,
      };
  }
}

export function renderSubagentQueueReleaseNote(queue: string, member: string, event: { kind: "paused" | "left"; reason: string }) {
  return event.kind === "paused"
    ? `${member} still holds queue \`${queue}\` but stopped working (${event.reason}); the queue is paused until ${member} resumes or you run ${dequeueCall(queue, member)}.`
    : `${member} left queue \`${queue}\`: ${event.reason} while waiting.`;
}
