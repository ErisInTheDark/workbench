/*
 * Exports:
 * - StatsMergeSource: one daemon's answer for a stats section.
 * - StatsMergeContext: maps a daemon's physical project onto its logical project and tells multi-root workspaces apart.
 * - mergeStatsSections: combine one section from every daemon into a single answer whose rows name their daemon.
 */
import type {
  WorkbenchStatsImportProgress, WorkbenchStatsResponse, WorkbenchStatsSection, WorkbenchStatsSectionData,
} from "./workbench-stats-contract.ts";
import { WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT } from "./workbench-stats-feedback-contract.ts";

export interface StatsMergeSource<Data = WorkbenchStatsResponse> {
  readonly attached: boolean;
  readonly daemonId: string;
  readonly hostname: string;
  readonly data: Data;
}

export interface StatsMergeContext {
  logicalProject(daemonId: string, projectId: string): string | null;
  /** Multi-root workspaces need the root id to tell files apart; other projects match by path alone. */
  isWorkspace(daemonId: string, projectId: string): boolean;
}

type Section<Name extends WorkbenchStatsSection> = WorkbenchStatsSectionData<Name>;

function sum<Item>(items: readonly Item[], value: (item: Item) => number) {
  return items.reduce((total, item) => total + value(item), 0);
}

/** Addition of every numeric field of equally shaped records. */
function addFields<Shape extends Record<string, number>>(target: Shape, source: Shape) {
  for (const key of Object.keys(source) as Array<keyof Shape>) target[key] = (target[key] + source[key]) as Shape[keyof Shape];
  return target;
}

/** The attached daemon's view decides the frame (buckets, range, catalogue), since that is the build in use. */
function frameSource<Data>(sources: readonly StatsMergeSource<Data>[]) {
  return sources.find(({ attached }) => attached) ?? sources[0]!;
}

/**
 * Buckets align by start; daemons with a skewed clock may name a bucket the frame lacks, which is dropped
 * rather than shifting the window.
 */
function alignBuckets<Bucket extends { startedAt: number }>(
  frame: readonly Bucket[], others: ReadonlyArray<readonly Bucket[]>, add: (target: Bucket, source: Bucket) => void,
) {
  const merged = frame.map((bucket) => structuredClone(bucket));
  const byStart = new Map(merged.map((bucket) => [bucket.startedAt, bucket]));
  for (const buckets of others) for (const bucket of buckets) {
    const target = byStart.get(bucket.startedAt);
    if (target) add(target, bucket);
  }
  return merged;
}

function shareKeyed<Row extends { costUsd: number; threadCount: number; tokens: number; unpricedTokens: number }>(
  rows: readonly Row[], key: (row: Row) => string, extra: (target: Row, row: Row) => void = () => {},
) {
  const merged = new Map<string, Row>();
  for (const row of rows) {
    const current = merged.get(key(row));
    if (!current) { merged.set(key(row), { ...row }); continue; }
    current.costUsd += row.costUsd;
    current.threadCount += row.threadCount;
    current.tokens += row.tokens;
    current.unpricedTokens += row.unpricedTokens;
    extra(current, row);
  }
  return [...merged.values()].sort((left, right) => right.tokens - left.tokens);
}

const money = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const cacheRate = (input: number, cached: number) => input ? cached / input * 100 : null;

function mergeUsage(sources: readonly StatsMergeSource<Section<"usage">>[], context: StatsMergeContext): Section<"usage"> {
  const frame = frameSource(sources).data;
  const others = sources.filter((source) => source.data !== frame).map(({ data }) => data);
  const all = sources.map(({ data }) => data);
  const tokenBuckets = alignBuckets(frame.tokens.buckets, others.map(({ tokens }) => tokens.buckets), (target, bucket) => {
    for (const key of ["all", "cachedInput", "cacheWriteInput", "input", "output", "uncachedInput"] as const) target[key] += bucket[key];
  });
  const totals = all.reduce((total, data) => addFields(total, { ...data.tokens.totals }), {
    all: 0, cachedInput: 0, cacheWriteInput: 0, input: 0, output: 0, uncachedInput: 0,
  });
  const cacheBuckets = alignBuckets(frame.cacheEfficiency.buckets, others.map(({ cacheEfficiency }) => cacheEfficiency.buckets), (target, bucket) => {
    target.inputTokens += bucket.inputTokens;
    target.cachedInputTokens += bucket.cachedInputTokens;
    target.cacheHitPercent = cacheRate(target.inputTokens, target.cachedInputTokens);
  });
  const cacheInput = sum(all, ({ cacheEfficiency }) => cacheEfficiency.totals.inputTokens);
  const cacheCached = sum(all, ({ cacheEfficiency }) => cacheEfficiency.totals.cachedInputTokens);
  const costBuckets = alignBuckets(frame.cost.buckets, others.map(({ cost }) => cost.buckets), (target, bucket) => {
    target.totalUsd = money(target.totalUsd + bucket.totalUsd);
    addFields(target.byTokenType, bucket.byTokenType);
  });
  const byTokenType = all.reduce((total, data) => addFields(total, { ...data.cost.byTokenType }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  const basis = all.reduce((total, data) => addFields(total, { ...data.cost.basis }), {
    exactModelTokens: 0, projectInferredModelTokens: 0, threadInferredModelTokens: 0, unpricedTokens: 0,
  });
  const unpriced = new Map<string, Section<"usage">["cost"]["unpricedModels"][number]>();
  for (const row of all.flatMap(({ cost }) => cost.unpricedModels)) {
    const key = `${row.provider}\0${row.model ?? ""}`;
    const current = unpriced.get(key);
    if (current) current.tokens += row.tokens;
    else unpriced.set(key, { ...row });
  }
  // Each daemon sends its own top 12, and threads never span daemons, so the merged top 12 is exact.
  const topThreads = sources.flatMap(({ daemonId, data }) => data.topThreads.map((thread) => ({ ...thread, daemonId: thread.daemonId ?? daemonId })))
    .sort((left, right) => right.tokens - left.tokens || left.title.localeCompare(right.title))
    .slice(0, 12)
    .map((thread) => ({ ...thread, sharePercent: totals.all ? Math.min(100, thread.tokens / totals.all * 100) : 0 }));
  const worstThreads = sources.flatMap(({ daemonId, data }) => data.cacheEfficiency.worstThreads.map((thread) => ({ ...thread, daemonId: thread.daemonId ?? daemonId })))
    .sort((left, right) => left.cacheHitPercent - right.cacheHitPercent || right.inputTokens - left.inputTokens)
    .slice(0, 12);
  // One repository checked out on several machines is one project.
  const projects = shareKeyed(sources.flatMap(({ daemonId, data }) => data.projects.map((project) => ({
    ...project, daemonId: project.daemonId ?? daemonId,
    logicalProjectId: project.logicalProjectId ?? context.logicalProject(daemonId, project.projectId),
  }))), (project) => project.logicalProjectId ?? `${project.daemonId}/${project.projectId}`).slice(0, 100);
  const previous = all.reduce((total, data) => addFields(total, { ...data.previous }), { costUsd: 0, threadCount: 0, tokens: 0, turnCount: 0 });
  return {
    ...frame,
    cacheEfficiency: {
      buckets: cacheBuckets,
      totals: { cachedInputTokens: cacheCached, inputTokens: cacheInput, cacheHitPercent: cacheRate(cacheInput, cacheCached) },
      worstThreads,
    },
    cost: {
      basis,
      buckets: costBuckets,
      byTokenType,
      totalUsd: money(sum(all, ({ cost }) => cost.totalUsd)),
      unpricedModels: [...unpriced.values()].sort((left, right) => right.tokens - left.tokens).slice(0, 50),
    },
    generatedAt: Math.max(...all.map(({ generatedAt }) => generatedAt)),
    models: shareKeyed(all.flatMap(({ models }) => models), (row) => `${row.provider}\0${row.model ?? ""}`, (target, row) => {
      target.inferredModelTokens += row.inferredModelTokens;
    }).slice(0, 100),
    previous: { ...previous, costUsd: money(previous.costUsd) },
    projectIds: null,
    projects,
    providers: shareKeyed(all.flatMap(({ providers }) => providers), (row) => row.provider),
    summary: {
      buckets: alignBuckets(frame.summary.buckets, others.map(({ summary }) => summary.buckets), (target, bucket) => {
        target.threadCount += bucket.threadCount;
        target.turnCount += bucket.turnCount;
      }),
      threadCount: sum(all, ({ summary }) => summary.threadCount),
      turnCount: sum(all, ({ summary }) => summary.turnCount),
    },
    tokens: { buckets: tokenBuckets, totals },
    topThreads,
    usageFilters: {
      models: [...new Set(all.flatMap(({ usageFilters }) => usageFilters.models))].sort().slice(0, 100),
      providers: [...new Set(all.flatMap(({ usageFilters }) => usageFilters.providers))].sort(),
    },
  };
}

/** One account seen from two machines reports the same limits; the freshest reading wins. */
function mergeLimits(sources: readonly StatsMergeSource<Section<"limits">>[]): Section<"limits"> {
  const series = new Map<string, Section<"limits">["rateLimits"][number]>();
  for (const limit of sources.flatMap(({ data }) => data.rateLimits)) {
    const key = `${limit.harness}\0${limit.limitId}`;
    const current = series.get(key);
    if (!current || (limit.samples.at(-1)?.observedAt ?? 0) > (current.samples.at(-1)?.observedAt ?? 0)) series.set(key, limit);
  }
  return { ...frameSource(sources).data, generatedAt: Math.max(...sources.map(({ data }) => data.generatedAt)), rateLimits: [...series.values()] };
}

function mergeClaims(sources: readonly StatsMergeSource<Section<"claims">>[], context: StatsMergeContext): Section<"claims"> {
  type Hotspot = Section<"claims">["claimHotspots"][number] & { attached: boolean };
  const merged = new Map<string, Hotspot>();
  for (const { attached, daemonId, data } of sources) for (const hotspot of data.claimHotspots) {
    const logical = hotspot.logicalProjectId ?? context.logicalProject(daemonId, hotspot.projectId);
    // Root ids are folder names, so the same repository can carry different ones on different machines.
    const path = context.isWorkspace(daemonId, hotspot.projectId) ? `${hotspot.rootId}:${hotspot.path}` : hotspot.path;
    const key = `${logical ?? `${daemonId}/${hotspot.projectId}`}\0${path}`;
    const threads = hotspot.threads.map((thread) => ({ ...thread, daemonId: thread.daemonId ?? daemonId }));
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...hotspot, attached, daemonId: hotspot.daemonId ?? daemonId, logicalProjectId: logical, threads });
      continue;
    }
    // Threads never span daemons, so claimants add up; the attached copy owns the link target when there is one.
    const owner = attached && !current.attached ? { ...hotspot, attached, daemonId, logicalProjectId: logical } : current;
    merged.set(key, {
      ...owner,
      threadCount: current.threadCount + hotspot.threadCount,
      threads: [...current.threads, ...threads].sort((left, right) => right.tokens - left.tokens).slice(0, 12),
    });
  }
  return {
    ...frameSource(sources).data,
    claimHotspots: [...merged.values()]
      .sort((left, right) => right.threadCount - left.threadCount || left.path.localeCompare(right.path))
      .slice(0, 20)
      .map(({ attached: _attached, ...hotspot }) => hotspot),
    generatedAt: Math.max(...sources.map(({ data }) => data.generatedAt)),
    historyFailures: sources.flatMap(({ data, hostname }) => data.historyFailures.map((failure) => `${hostname}: ${failure}`.slice(0, 500))).slice(0, 20),
  };
}

function mergeFeedback(sources: readonly StatsMergeSource<Section<"feedback">>[]): Section<"feedback"> {
  const counts = new Map<string, number>();
  for (const { category, count } of sources.flatMap(({ data }) => data.feedback.counts)) counts.set(category, (counts.get(category) ?? 0) + count);
  const frame = frameSource(sources).data;
  return {
    ...frame,
    feedback: {
      counts: [...counts.entries()].map(([category, count]) => ({ category: category as Section<"feedback">["feedback"]["counts"][number]["category"], count })),
      items: sources.flatMap(({ daemonId, data }) => data.feedback.items.map((item) => ({ ...item, daemonId: item.daemonId ?? daemonId })))
        .sort((left, right) => right.importance - left.importance || right.createdAt - left.createdAt)
        .slice(0, WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT),
      total: sum(sources, ({ data }) => data.feedback.total),
      workbenchProjectId: frame.feedback.workbenchProjectId ?? sources.find(({ data }) => data.feedback.workbenchProjectId)?.data.feedback.workbenchProjectId ?? null,
    },
    generatedAt: Math.max(...sources.map(({ data }) => data.generatedAt)),
  };
}

function mergeTools(sources: readonly StatsMergeSource<Section<"tools">>[]): Section<"tools"> {
  const frame = frameSource(sources).data.tools;
  // Prompt cost describes the running build, so the attached daemon's catalogue prices every tool.
  const priced = sources.find(({ attached, data }) => attached && data.tools.catalogue)
    ?? sources.find(({ data }) => data.tools.catalogue) ?? null;
  const prices = new Map((priced?.data.tools.workbench ?? []).map((row) => [row.tool, row]));
  const threads: Section<"tools">["tools"]["threads"] = [];
  const rows = new Map<string, Section<"tools">["tools"]["workbench"][number]>();
  const position = new Map(frame.bucketStarts.map((startedAt, index) => [startedAt, index]));
  for (const { daemonId, data } of sources) {
    const offset = threads.length;
    threads.push(...data.tools.threads.map((thread) => ({ ...thread, daemonId: thread.daemonId ?? daemonId })));
    for (const row of data.tools.workbench) {
      const price = priced ? prices.get(row.tool) : row;
      const target = rows.get(row.tool) ?? {
        ...row, buckets: frame.bucketStarts.map(() => 0), bucketThreads: frame.bucketStarts.map(() => []),
        calls: 0, docsTokens: price?.docsTokens ?? 0, failed: 0, specTokens: price?.specTokens ?? null, threads: 0,
      };
      rows.set(row.tool, target);
      target.calls += row.calls;
      target.failed += row.failed;
      target.threads += row.threads;
      data.tools.bucketStarts.forEach((startedAt, index) => {
        const at = position.get(startedAt);
        if (at === undefined) return;
        target.buckets[at] = (target.buckets[at] ?? 0) + (row.buckets[index] ?? 0);
        target.bucketThreads[at] = [...target.bucketThreads[at] ?? [], ...(row.bucketThreads[index] ?? [])
          .map(({ calls, thread }) => ({ calls, thread: thread + offset }))];
      });
    }
  }
  // Catalogued tools nobody called on any machine still belong in the list.
  for (const row of priced?.data.tools.workbench ?? []) {
    if (!rows.has(row.tool)) rows.set(row.tool, { ...row, buckets: frame.bucketStarts.map(() => 0), bucketThreads: [], calls: 0, failed: 0, threads: 0 });
  }
  const workbench = [...rows.values()].map((row) => ({
    ...row,
    bucketThreads: row.bucketThreads.map((callers) => [...callers].sort((left, right) => right.calls - left.calls).slice(0, 3)),
  })).sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool));
  // Drop thread entries no surviving top-caller list points at, keeping indexes dense.
  const used = [...new Set(workbench.flatMap(({ bucketThreads }) => bucketThreads.flat().map(({ thread }) => thread)))].sort((a, b) => a - b);
  const index = new Map(used.map((old, next) => [old, next]));
  return {
    ...frameSource(sources).data,
    generatedAt: Math.max(...sources.map(({ data }) => data.generatedAt)),
    tools: {
      bucketStarts: frame.bucketStarts,
      catalogue: priced?.data.tools.catalogue ?? null,
      threadCount: sum(sources, ({ data }) => data.tools.threadCount),
      threads: used.map((old) => threads[old]!),
      workbench: workbench.map((row) => ({
        ...row, bucketThreads: row.bucketThreads.map((callers) => callers.map(({ calls, thread }) => ({ calls, thread: index.get(thread)! }))),
      })),
    },
  };
}

function mergeStatus(sources: readonly StatsMergeSource<Section<"status">>[]): Section<"status"> {
  const progress = sources.map(({ data }) => data.historyImport);
  const source = (key: "claims" | "usage") => progress.reduce((total, item) => addFields(total, { ...item[key] }),
    { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 });
  const usage = source("usage");
  const claims = source("claims");
  const total = usage.total + claims.total;
  const historyImport: WorkbenchStatsImportProgress = {
    claims,
    percent: total ? Math.min(100, (usage.processed + claims.processed) / total * 100) : 100,
    recentFailures: progress.flatMap(({ recentFailures }) => recentFailures).slice(-20),
    revision: sum(progress, ({ revision }) => revision),
    state: progress.some(({ state }) => state === "running") ? "running" : progress.some(({ state }) => state === "complete") ? "complete" : "idle",
    unsupportedClaimCheckpoints: sum(progress, ({ unsupportedClaimCheckpoints }) => unsupportedClaimCheckpoints),
    usage,
    version: 2,
  };
  return {
    ...frameSource(sources).data,
    failures: sources.flatMap(({ data, hostname }) => data.failures.map((failure) => ({
      ...failure, message: (sources.length > 1 ? `${hostname}: ${failure.message}` : failure.message).slice(0, 500),
    }))).slice(-20),
    generatedAt: Math.max(...sources.map(({ data }) => data.generatedAt)),
    historyImport,
  };
}

/** Every source must answer the same section; mixed sections are a caller defect. */
export function mergeStatsSections(sources: readonly StatsMergeSource[], context: StatsMergeContext): WorkbenchStatsResponse | null {
  if (!sources.length) return null;
  const section = sources[0]!.data.section;
  if (sources.some(({ data }) => data.section !== section)) throw new Error("Stats sections from different reads cannot merge.");
  const typed = <Name extends WorkbenchStatsSection>() => sources as unknown as readonly StatsMergeSource<Section<Name>>[];
  switch (section) {
    case "usage": return mergeUsage(typed<"usage">(), context);
    case "limits": return mergeLimits(typed<"limits">());
    case "claims": return mergeClaims(typed<"claims">(), context);
    case "feedback": return mergeFeedback(typed<"feedback">());
    case "tools": return mergeTools(typed<"tools">());
    case "status": return mergeStatus(typed<"status">());
  }
}
