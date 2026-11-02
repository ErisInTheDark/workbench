/*
 * No exports. Two isolated installations with fake Codex models; installation A's app also reaches installation B's daemon,
 * standing in for a tailnet. Threads on A and B network only through that app relay and B's own grants.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkbenchComposerProfile, WorkbenchComposerProfileTargetSelection } from "../../shared/types";
import { WorkspaceThreadActionResultSchema } from "../../shared/workbench/workspace/workspace-commands";
import IsolatedWorkbench from "./IsolatedWorkbench";
import FakeThreadModelServer, { type FakeThreadAction } from "./FakeThreadModelServer";
import ProviderThreadJourney from "./ProviderThreadJourney";
import { fakeCodexTool, SCENARIO_COMPLETION } from "./provider-boundary-journey";

const STALL_MS = 120_000;

/** The installed Codex model cache names a model the fake endpoint answers for. */
async function codexProfile(): Promise<WorkbenchComposerProfile> {
  const cache = JSON.parse(await fs.readFile(
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json"), "utf8",
  )) as { models?: Array<{ slug?: unknown; visibility?: unknown; supported_reasoning_levels?: Array<{ effort?: unknown }> }> };
  const model = cache.models?.find(entry => typeof entry.slug === "string" && entry.visibility === "list"
    && entry.supported_reasoning_levels?.some(level => level.effort === "low"))?.slug;
  assert.ok(typeof model === "string", "The installed Codex model cache must list a model supporting low effort");
  const now = Date.now();
  return {
    id: randomUUID(), name: "codex fake networking", description: "Fake Codex profile for cross-daemon networking.",
    scope: { kind: "global" }, harness: "codex", model, reasoningEffort: "low", serviceTier: null, agentPath: null, agentSource: null,
    createdAt: now, updatedAt: now,
  };
}

/**
 * One scripted turn. Its last tool marks the task completed, so its end never wakes an unfinished-turn continuation.
 * `incoming` must be in the message that started it.
 */
function turn({ incoming = [], steps = [], text }: {
  incoming?: readonly string[]; steps?: readonly FakeThreadAction[]; text: string;
}): FakeThreadAction[] {
  const [first, ...rest] = [...steps, { tool: { nameSuffix: "thread_state", arguments: SCENARIO_COMPLETION } }, { text }] as FakeThreadAction[];
  return [incoming.length ? { ...first!, requiredPromptText: incoming } : first!, ...rest];
}

/** What each answered call of `tool` returned, oldest first, read from the thread's durable transcript. */
async function toolResults(journey: ProviderThreadJourney, tool: string) {
  return (await journey.durable()).turns.flatMap(turn => turn.items).flatMap(entry => {
    const { tool: name, result, error } = entry as { tool?: unknown; result?: unknown; error?: unknown };
    return name === tool && (result !== null || error !== null) ? [JSON.stringify({ result, error })] : [];
  });
}

/** What the thread's latest answered call of `tool` returned. */
async function toolResult(journey: ProviderThreadJourney, tool: string) {
  const result = (await toolResults(journey, tool)).at(-1);
  assert.ok(result, `The thread must have called ${tool}`);
  return result;
}

/** A rejected request fails the scenario at once rather than leaving a wait to run out the deadline. */
function throwFakeFailure(fakes: readonly FakeThreadModelServer[]) {
  for (const fake of fakes) if (fake.lastFailure) throw fake.lastFailure;
}

/** Re-reads until `ready`; for facts whose changes reach the scenario through no event it waits on. */
async function poll<T>(read: () => Promise<T>, ready: (value: T) => boolean, signal: AbortSignal, fakes: readonly FakeThreadModelServer[] = []) {
  for (;;) {
    throwFakeFailure(fakes);
    const value = await read();
    if (ready(value)) return value;
    await delay(250, undefined, { signal });
  }
}

/** Every fake consumed its script. */
async function drained(fakes: readonly FakeThreadModelServer[], signal: AbortSignal) {
  for (;;) {
    throwFakeFailure(fakes);
    if (fakes.every(fake => fake.queuedActions === 0)) return;
    await delay(100, undefined, { signal });
  }
}

/**
 * The turn that ended with `finalText` completed and nothing runs after it. Another thread's message may start or steer
 * a turn at any moment, and durable status trails the provider, so the scripted last words mark the end.
 */
async function settled(fakes: readonly FakeThreadModelServer[], journey: ProviderThreadJourney, finalText: string) {
  await journey.waitForFact(() => journey.durable(), projection => {
    throwFakeFailure(fakes);
    return projection.turns.some(turn => turn.status === "completed" && JSON.stringify(turn.items).includes(finalText))
      && projection.turns.every(turn => turn.status !== "inProgress");
  });
  await journey.waitProviderIdle();
}

interface Followed { name: string; runtime: IsolatedWorkbench; projectId: string; threadId: string; journey: ProviderThreadJourney }

/** Each thread's durable turns in brief, so a failed run shows which thread did what; reads with their own deadline. */
async function describeThreads(followed: readonly Followed[]) {
  for (const { name, runtime, projectId, threadId } of followed) {
    const journey = new ProviderThreadJourney(runtime, "codex", projectId, threadId, AbortSignal.timeout(30_000));
    try {
      const turns = (await journey.durable()).turns.map(turn => `${turn.status}: ${turn.items.map(item => {
        const { type, tool, text, result, error, arguments: args } = item as Record<string, unknown>;
        const brief = JSON.stringify({ tool, args, text, result, error }).replace(/\\n/gu, " ");
        return `${String(type)} ${brief.slice(0, 600)}`;
      }).join("\n    ")}`);
      console.error(`[threads] ${name}\n  ${turns.join("\n  ")}`);
    } catch (error) {
      console.error(`[threads] ${name}: unreadable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

/** The thread id the thread's `index`th `subagent_create` returned, once that call has answered. */
async function createdSubagent(journey: ProviderThreadJourney, index: number, signal: AbortSignal, fakes: readonly FakeThreadModelServer[]) {
  const answered = await poll(() => toolResults(journey, "subagent_create"), results => results.length > index, signal, fakes);
  const id = answered[index]!.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u)?.[0];
  assert.ok(id, `subagent_create must return the created thread id: ${answered[index]!.slice(0, 300)}`);
  return id;
}

function selection(profile: WorkbenchComposerProfile): WorkbenchComposerProfileTargetSelection {
  const { agentPath, agentSource, harness, model, reasoningEffort, serviceTier, contextWindowTokens } = profile;
  return { kind: "profile", profileId: profile.id, settings: { agentPath, agentSource, harness, model, reasoningEffort, serviceTier, contextWindowTokens } };
}

test("threads on two daemons network only through the app relay and the target's own grants", async t => {
  const source = path.resolve(process.cwd(), "..");
  const profile = await codexProfile();
  const fakeA = await FakeThreadModelServer.start({});
  const fakeB = await FakeThreadModelServer.start({});
  const fakes = [fakeA, fakeB];
  // A scripted step never takes minutes, so a phase where neither fake moves has hung; fail it with diagnostics.
  // Installations keep only the deadline, so a stalled run can still read their transcripts for diagnostics.
  const deadline = AbortSignal.any([t.signal, AbortSignal.timeout(900_000)]);
  const stalled = new AbortController();
  const signal = AbortSignal.any([deadline, stalled.signal]);
  let phase: string | null = null;
  let progress = "";
  let quietSince = Date.now();
  const watchdog = setInterval(() => {
    const now = `${phase}|${fakeA.queuedActions}|${fakeB.queuedActions}`;
    if (now !== progress) [progress, quietSince] = [now, Date.now()];
    else if (phase && Date.now() - quietSince > STALL_MS) stalled.abort(new Error(`Scenario stalled in phase: ${phase}`));
  }, 1_000);
  const runtimes: IsolatedWorkbench[] = [];
  const followed: Followed[] = [];
  let failed = false;
  const follow = async (name: string, runtime: IsolatedWorkbench, projectId: string, threadId: string) => {
    const journey = new ProviderThreadJourney(runtime, "codex", projectId, threadId, signal);
    await journey.subscribe();
    followed.push({ name, runtime, projectId, threadId, journey });
    return journey;
  };
  try {
    const b = await IsolatedWorkbench.create(source, deadline, { codexModelEndpoint: fakeB.baseUrl });
    runtimes.push(b);
    const a = await IsolatedWorkbench.create(source, deadline, { codexModelEndpoint: fakeA.baseUrl });
    runtimes.push(a);
    await b.start([profile], "networking-b");
    a.reachPeers([b.peerDaemon("tower")]);
    await a.start([profile], "networking-a");
    // Each installation's library folder is the one folder pair that forms a single project across both daemons.
    const library = async (runtime: IsolatedWorkbench) => {
      const rootPath = path.join(runtime.root, "library");
      const project = (await runtime.waitForProjects([rootPath])).find(candidate =>
        path.resolve(candidate.rootPath).toLowerCase() === path.resolve(rootPath).toLowerCase());
      assert.ok(project, "Each installation must catalogue its library folder");
      return project;
    };
    const projectA = await library(a);
    const projectB = await library(b);
    // Folder targets resolve within A's logical project, so A's app must have grouped B's folder into it.
    await a.until(() => {
      const locations = a.presentation.snapshot().data?.locations ?? [];
      const logical = (daemonId: string, projectId: string) => locations.find(item =>
        item.target.daemonId === daemonId && item.target.projectId === projectId)?.logicalProjectId;
      const own = logical(a.daemonId, projectA.id);
      return !!own && own === logical(b.daemonId, projectB.id);
    }, AbortSignal.any([signal, AbortSignal.timeout(90_000)]));
    const mark = (name: string) => { phase = name; a.markPhase(name); };

    // U waits on B; T on A asks to message it, which B refuses until the user approves through A's app.
    mark("U starts on B");
    fakeB.enqueue(turn({ text: "U is ready." }));
    const u = await b.launchDraft(projectB.id, selection(profile), "Wait for a message.");
    const uJourney = await follow("U (B)", b, projectB.id, u);
    await drained(fakes, signal);
    await settled(fakes, uJourney, "U is ready.");

    mark("T messages U and needs approval");
    fakeA.enqueue(turn({ steps: [
      { tool: { nameSuffix: "message_agent", arguments: { threadId: u, message: "hello from T", userVisibleSimpleVersion: "Hello." } } },
    ], text: "Sent to U." }));
    const tId = await a.launchDraft(projectA.id, selection(profile), "Message U.");
    const tJourney = await follow("T (A)", a, projectA.id, tId);
    const prompt = await tJourney.pending("decision");
    assert.equal(prompt.request.networkAccess?.target.kind, "thread", "The prompt must name the remote thread it reaches");

    mark("approval writes B's grant; U receives T's message marked untrusted and replies without a prompt");
    fakeB.enqueue(turn({ incoming: ["UNTRUSTED", "hello from T"], text: "U read T's message." }));
    await a.workspace.approveNetwork(tId, prompt.requestKey);
    await drained(fakes, signal);
    await settled(fakes, tJourney, "Sent to U.");
    await settled(fakes, uJourney, "U read T's message.");
    // U replies only once both turns ended; a reply racing T's ending turn would steer it instead of starting one.
    fakeB.enqueue(turn({ steps: [
      { tool: { nameSuffix: "message_agent", arguments: { threadId: tId, message: "reply from U", userVisibleSimpleVersion: "Reply." } } },
    ], text: "Replied to T." }));
    fakeA.enqueue(turn({ incoming: ["UNTRUSTED", "reply from U"], text: "T read the reply." }));
    await uJourney.waitTurn(await uJourney.submit("Reply to T."));
    await drained(fakes, signal);
    await settled(fakes, tJourney, "T read the reply.");

    mark("the thread grant covers recall; settling U drops it, so the next recall asks again, and a denial reads nothing");
    fakeA.enqueue(turn({ steps: [fakeCodexTool("thread_recall", { threadId: u })], text: "Read U." }));
    await tJourney.waitTurn(await tJourney.submit("Recall U."));
    const recalled = await toolResult(tJourney, "thread_recall");
    assert.ok(recalled.includes("UNTRUSTED") && recalled.includes("Wait for a message."), "T must read U's history, marked untrusted");
    assert.ok(WorkspaceThreadActionResultSchema.parse(await a.workspace.rpc.requestRaw({
      method: "workspace/thread/action", params: { threadId: u, intent: { kind: "settle" } },
    })).accepted, "U must settle");
    await poll(() => b.threadSummary(u, signal), summary => summary?.summary.row.lifecycle.settled === true, signal, fakes);
    fakeA.enqueue(turn({ steps: [fakeCodexTool("thread_recall", { threadId: u })], text: "Denied as expected." }));
    const again = await tJourney.submit("Recall U again.");
    const retry = await tJourney.pending("decision");
    assert.equal(retry.request.networkAccess?.target.kind, "thread");
    assert.equal((await tJourney.answer(retry, "decision", "Deny")).ok, true);
    await tJourney.waitTurn(again);
    await drained(fakes, signal);
    const denied = await toolResult(tJourney, "thread_recall");
    assert.ok(!denied.includes("Thread Recall History"), `A denied recall must read nothing: ${denied.slice(0, 400)}`);

    // A parent cannot end a turn while a child is unsettled, so T orchestrates both children in one turn, waiting in tools
    // while they work. T and its local child Ada share A's fake, each on its own lane.
    mark("a folder grant lets T list B's profiles and create Bea there");
    const tool = (nameSuffix: string, args: Record<string, unknown>): FakeThreadAction => ({ tool: { nameSuffix, arguments: args } });
    fakeA.enqueueLane("Message U.", [
      tool("subagent_profiles", { folder: "tower" }),
      tool("subagent_create", {
        folder: "tower", profileId: profile.id, name: "Bea", title: "Remote child", message: "Say done.", userVisibleSimpleVersion: "Say done.",
      }),
      fakeCodexTool("subagent_wait", { names: ["Bea"] }),
      tool("subagent_list", {}),
      tool("subagent_create", {
        profileId: profile.id, name: "Ada", title: "Local child", message: "Wait for Bea.", userVisibleSimpleVersion: "Wait for Bea.",
      }),
      tool("message_agent", { name: "Bea", message: "Message Ada.", userVisibleSimpleVersion: "Message Ada." }),
      fakeCodexTool("message_wait", { names: ["Ada"] }),
      fakeCodexTool("subagent_wait", { names: ["Ada"] }),
      fakeCodexTool("subagent_wait", { names: ["Bea"] }),
      tool("subagent_settle", { names: ["Bea", "Ada"] }),
      ...turn({ text: "Children settled." }),
    ]);
    fakeB.enqueue([
      ...turn({ incoming: ["Say done."], text: "Bea is done." }),
      ...turn({ incoming: ["Message Ada."], steps: [tool("message_agent", { name: "Ada", message: "hi Ada", userVisibleSimpleVersion: "Hi." })],
        text: "Bea messaged Ada." }),
    ]);
    fakeA.enqueueLane("Wait for Bea.", [
      ...turn({ incoming: ["Wait for Bea."], text: "Ada waits." }),
      ...turn({ text: "Ada heard Bea." }),
      ...turn({ steps: [tool("message_agent", { parent: true, message: "Bea reached me.", userVisibleSimpleVersion: "Bea reached me." })],
        text: "Ada told T." }),
    ]);
    const orchestration = await tJourney.submit("Orchestrate children across daemons.");
    const folderPrompt = await tJourney.pending("decision");
    assert.equal(folderPrompt.request.networkAccess?.target.kind, "folder", "The prompt must name the folder it reaches");
    await a.workspace.approveNetwork(tId, folderPrompt.requestKey);
    const bea = await createdSubagent(tJourney, 0, signal, fakes);
    assert.ok((await toolResult(tJourney, "subagent_profiles")).includes(profile.name), "T must list B's profiles");

    mark("Bea is networked with A: B's own app sees only her summary, A's app opens her");
    await poll(() => b.threadSummary(bea, signal), summary => !!summary?.summary.facts.networkDaemonIds?.includes(a.daemonId), signal, fakes);
    await assert.rejects(b.transcripts.read({ threadId: bea, turnLimit: 1 }), "B's app must not open a thread networked beyond its reach");
    const beaJourney = await follow("Bea (B, via A's app)", a, projectB.id, bea);
    const listed = await poll(() => toolResults(tJourney, "subagent_list"), results => results.length > 0, signal, fakes);
    assert.ok(listed[0]!.includes("Bea") && listed[0]!.includes("completed"), `T's subagent list must show Bea's lifecycle from B: ${listed[0]!.slice(0, 600)}`);

    mark("a local sibling on A is on Bea's roster, so Bea reaches it by name without any grant");
    const ada = await createdSubagent(tJourney, 1, signal, fakes);
    const adaJourney = await follow("Ada (A)", a, projectA.id, ada);
    await settled(fakes, adaJourney, "Ada heard Bea.");
    assert.match(JSON.stringify(await adaJourney.durable()), /hi Ada[\s\S]*UNTRUSTED|UNTRUSTED[\s\S]*hi Ada/u,
      "Ada must receive Bea's message marked untrusted");

    // T is still waiting for Ada, so Bea is alive and unsettled while a stranger tries her.
    mark("a thread outside the family cannot reach Bea without a grant");
    fakeA.enqueue(turn({ steps: [tool("message_agent", { threadId: bea, message: "forged", userVisibleSimpleVersion: "Forged." })],
      text: "Refused as expected." }));
    const strangerId = await a.launchDraft(projectA.id, selection(profile), "Message Bea.");
    const stranger = await follow("stranger (A)", a, projectA.id, strangerId);
    const strangerPrompt = await stranger.pending("decision");
    assert.equal(strangerPrompt.request.networkAccess?.target.kind, "thread", "A stranger needs its own grant to reach Bea");
    assert.equal((await stranger.answer(strangerPrompt, "decision", "Deny")).ok, true);
    await settled(fakes, stranger, "Refused as expected.");
    assert.ok(!JSON.stringify(await beaJourney.durable()).includes("forged"), "Bea must not receive a message from outside its family");

    mark("Ada reports back, and T settles both children before completing");
    await adaJourney.waitTurn(await adaJourney.submit("Tell T."));
    await tJourney.waitTurn(orchestration);
    await drained(fakes, signal);
    const settle = await toolResult(tJourney, "subagent_settle");
    assert.ok(!/fail|cannot/iu.test(settle), `T must settle both children: ${settle.slice(0, 400)}`);
    await poll(() => b.threadSummary(bea, signal), summary => summary?.summary.row.lifecycle.settled === true, signal);
  } catch (error) {
    failed = true;
    await describeThreads(followed);
    throw error;
  } finally {
    clearInterval(watchdog);
    await Promise.allSettled(followed.map(({ journey }) => journey.unsubscribe()));
    await Promise.allSettled(runtimes.map(runtime => runtime.close({ preserveDiagnostics: failed })));
    await Promise.allSettled([fakeA.close(), fakeB.close()]);
  }
});
