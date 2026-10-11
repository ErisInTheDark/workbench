/*
 * Exports:
 * - extractSnapshotSubtree: retain one referenced accessibility subtree.
 * - formatRuntimeException: surface useful bounded JavaScript exception detail.
 * - patchBrowseDriverCommandSchema: admit Workbench commands through Browse's closed daemon protocol.
 * - patchBrowseDriverExtensions: add Workbench browser commands behind the upstream driver boundary.
 */
const MAX_ERROR_LENGTH = 8_000;
const MAX_TRACE_EVENT_NAMES = 100;
const traceStates = new WeakMap();
const WORKBENCH_DRIVER_COMMANDS = [
  "workbench.emulateDevice",
  "workbench.initScript",
  "workbench.throttleCpu",
  "workbench.throttleNetwork",
  "workbench.touchScroll",
  "workbench.trace",
];

const DEVICE_PRESETS = {
  "iphone-14": {
    height: 844,
    mobile: true,
    scale: 3,
    touch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1",
    width: 390,
  },
  "pixel-7": {
    height: 915,
    mobile: true,
    scale: 2.625,
    touch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
    width: 412,
  },
};

const NETWORK_PRESETS = {
  "fast-3g": { downloadThroughput: 180_000, latency: 150, offline: false, uploadThroughput: 90_000 },
  "offline": { downloadThroughput: 0, latency: 0, offline: true, uploadThroughput: 0 },
  "slow-3g": { downloadThroughput: 50_000, latency: 400, offline: false, uploadThroughput: 50_000 },
};

export function formatRuntimeException(exceptionDetails) {
  const detail = exceptionDetails?.exception?.description
    ?? exceptionDetails?.exception?.value
    ?? exceptionDetails?.text
    ?? "JavaScript evaluation failed.";
  return String(detail).slice(0, MAX_ERROR_LENGTH);
}

export function patchBrowseDriverCommandSchema(typesModule) {
  const schema = typesModule.DriverCommandNameSchema;
  const entries = schema?._def?.entries;
  const values = schema?._zod?.values;
  if (!entries || !(values instanceof Set)) {
    throw new Error("Browse driver command schema shape changed; Workbench extensions cannot be installed.");
  }
  for (const command of WORKBENCH_DRIVER_COMMANDS) {
    entries[command] = command;
    values.add(command);
  }
}

function lineDepth(line) {
  return Math.floor((line.match(/^\s*/u)?.[0].length ?? 0) / 2);
}

function keepLinesWithAncestors(lines, shouldKeep) {
  const keep = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!shouldKeep(lines[index] ?? "")) continue;
    keep.add(index);
    let depth = lineDepth(lines[index] ?? "");
    for (let ancestor = index - 1; ancestor >= 0; ancestor -= 1) {
      const ancestorDepth = lineDepth(lines[ancestor] ?? "");
      if (ancestorDepth >= depth) continue;
      keep.add(ancestor);
      depth = ancestorDepth;
      if (depth === 0) break;
    }
  }
  return lines.filter((_, index) => keep.has(index));
}

function createSnapshotMatcher(pattern) {
  const regexMatch = String(pattern).match(/^\/(.+)\/([a-z]*)$/iu);
  if (regexMatch) {
    try {
      const regex = new RegExp(regexMatch[1] ?? "", regexMatch[2] ?? "");
      return (line) => regex.test(line);
    } catch {
      // Invalid regex-like filters remain literal text, matching upstream.
    }
  }
  const needle = String(pattern).toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

function formatScopedSnapshot(tree, { compact, filter, maxDepth }) {
  let lines = tree.split("\n");
  if (maxDepth !== undefined) lines = lines.filter((line) => lineDepth(line) <= maxDepth);
  if (filter) lines = keepLinesWithAncestors(lines, createSnapshotMatcher(filter));
  if (compact) {
    const compacted = keepLinesWithAncestors(lines, (line) =>
      /\[\d+-\d+\]/u.test(line)
      || line.includes(": ")
      || /\b(button|link|textbox|checkbox|radio|combobox)\b/iu.test(line));
    if (compacted.length) lines = compacted;
  }
  return lines.join("\n").trim();
}

export function extractSnapshotSubtree(tree, ref) {
  const lines = String(tree ?? "").split("\n");
  const targetIndex = lines.findIndex((line) => line.includes(`[${ref}]`));
  if (targetIndex < 0) throw new Error(`Snapshot target @${ref} was not found. Run an unscoped snapshot to refresh refs.`);
  const targetDepth = lineDepth(lines[targetIndex] ?? "");
  let endIndex = targetIndex + 1;
  while (endIndex < lines.length && lineDepth(lines[endIndex] ?? "") > targetDepth) endIndex += 1;
  const indentation = "  ".repeat(targetDepth);
  return lines.slice(targetIndex, endIndex)
    .map((line) => line.startsWith(indentation) ? line.slice(indentation.length) : line)
    .join("\n")
    .trim();
}

function parseRef(target) {
  const match = String(target ?? "").match(/^@?(?:\[)?(\d+-\d+)(?:\])?$/u);
  return match?.[1] ?? null;
}

function canonicalXPath(xpath) {
  return String(xpath ?? "").toLowerCase().replace(/\[1\]/gu, "").replace(/^\/+/u, "");
}

async function resolveSnapshotRef(manager, page, target, xpathMap) {
  const directRef = parseRef(target);
  if (directRef) return directRef;
  const selector = manager.resolveSelector(target);
  const expression = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const parts = [];
    for (let node = element; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index += 1;
      }
      parts.unshift(node.tagName.toLowerCase() + "[" + index + "]");
    }
    return "/" + parts.join("/");
  })()`;
  const xpath = await page.evaluate(expression);
  if (!xpath) throw new Error(`Snapshot selector ${target} did not match an element.`);
  const expected = canonicalXPath(xpath);
  const match = Object.entries(xpathMap ?? {}).find(([, candidate]) => canonicalXPath(candidate) === expected);
  if (!match) throw new Error(`Snapshot selector ${target} was not represented in the accessibility snapshot.`);
  return match[0];
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function touchFrameCount(deltaX, deltaY, speed) {
  const distance = Math.hypot(deltaX, deltaY);
  const durationMs = distance / Math.max(1, speed) * 1_000;
  return Math.max(2, Math.min(60, Math.ceil(durationMs / (1_000 / 60))));
}

async function dispatchTouchScroll(page, params) {
  const deltaX = params.deltaX ?? 0;
  const deltaY = params.deltaY ?? 0;
  const fling = params.fling === true;
  const hasFlingFrame = fling && (deltaX !== 0 || deltaY !== 0);
  const frames = touchFrameCount(deltaX, deltaY, params.speed ?? 800);
  const repeat = Math.max(1, params.repeat ?? 1);
  await page.sendCDP("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    for (let repetition = 0; repetition < repeat; repetition += 1) {
      if (repetition > 0) await delay(params.intervalMs ?? 0);
      await page.sendCDP("Input.dispatchTouchEvent", {
        touchPoints: [{ x: params.x, y: params.y }],
        type: "touchStart",
      });
      for (let frame = 1; frame <= frames; frame += 1) {
        const progress = frame / frames;
        await page.sendCDP("Input.dispatchTouchEvent", {
          touchPoints: [{
            x: params.x - deltaX * progress,
            y: params.y - deltaY * progress,
          }],
          type: "touchMove",
        });
      }
      if (hasFlingFrame) {
        await page.sendCDP("Input.dispatchTouchEvent", {
          touchPoints: [{
            x: params.x - deltaX * 1.25,
            y: params.y - deltaY * 1.25,
          }],
          type: "touchMove",
        });
      }
      await page.sendCDP("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
    }
  } catch (error) {
    try {
      await page.sendCDP("Input.dispatchTouchEvent", { touchPoints: [], type: "touchCancel" });
    } catch (cancelError) {
      throw new AggregateError(
        [error, cancelError],
        "Touch scroll failed and the active gesture could not be cancelled.",
        { cause: error },
      );
    }
    throw error;
  }
  return { fling, frames: frames + (hasFlingFrame ? 1 : 0), repeat };
}

async function evaluate(page, expression) {
  const response = await page.sendCDP("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) throw new Error(formatRuntimeException(response.exceptionDetails));
  return { result: response.result?.value };
}

async function emulateDevice(page, preset) {
  if (preset === "clear") {
    await page.sendCDP("Emulation.clearDeviceMetricsOverride");
    await page.sendCDP("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.sendCDP("Emulation.setUserAgentOverride", { userAgent: "" });
    return { device: "clear" };
  }
  const device = DEVICE_PRESETS[preset];
  if (!device) throw new Error(`Unsupported device preset: ${preset}`);
  await page.sendCDP("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: device.scale,
    height: device.height,
    mobile: device.mobile,
    width: device.width,
  });
  await page.sendCDP("Emulation.setTouchEmulationEnabled", { enabled: device.touch, maxTouchPoints: 5 });
  await page.sendCDP("Emulation.setUserAgentOverride", { mobile: true, userAgent: device.userAgent });
  return { device: preset };
}

async function throttleNetwork(page, preset) {
  const conditions = preset === "clear"
    ? { downloadThroughput: -1, latency: 0, offline: false, uploadThroughput: -1 }
    : NETWORK_PRESETS[preset];
  if (!conditions) throw new Error(`Unsupported network preset: ${preset}`);
  await page.sendCDP("Network.enable");
  await page.sendCDP("Network.emulateNetworkConditions", { ...conditions, connectionType: preset === "clear" ? "none" : "cellular3g" });
  return { network: preset };
}

function sessionForEvents(page) {
  const session = page.mainSession;
  if (!session || typeof session.on !== "function" || typeof session.off !== "function") {
    throw new Error("Trace capture is unavailable in this browser driver.");
  }
  return session;
}

async function runTrace(manager, page, operation) {
  if (operation === "start") {
    if (traceStates.has(manager)) throw new Error("A trace is already running for this session.");
    const session = sessionForEvents(page);
    const summary = { eventCount: 0, names: new Map() };
    const onData = ({ value = [] } = {}) => {
      for (const event of value) {
        summary.eventCount += 1;
        const name = typeof event?.name === "string" ? event.name : "unknown";
        if (summary.names.has(name) || summary.names.size < MAX_TRACE_EVENT_NAMES) {
          summary.names.set(name, (summary.names.get(name) ?? 0) + 1);
        }
      }
    };
    session.on("Tracing.dataCollected", onData);
    const state = { onComplete: null, onData, session, summary };
    traceStates.set(manager, state);
    try {
      await page.sendCDP("Tracing.start", {
        categories: "-*,devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,loading",
        transferMode: "ReportEvents",
      });
    } catch (error) {
      clearTraceState(manager, state);
      throw error;
    }
    return { tracing: true };
  }

  const state = traceStates.get(manager);
  if (!state) throw new Error("No trace is running for this session.");
  const completed = new Promise((resolve) => {
    state.onComplete = resolve;
    state.session.on("Tracing.tracingComplete", state.onComplete);
  });
  try {
    await page.sendCDP("Tracing.end");
    await completed;
    return {
      eventCount: state.summary.eventCount,
      events: Object.fromEntries([...state.summary.names.entries()].sort((left, right) => right[1] - left[1])),
      tracing: false,
      truncatedEventNames: state.summary.names.size >= MAX_TRACE_EVENT_NAMES,
    };
  } finally {
    clearTraceState(manager, state);
  }
}

function clearTraceState(manager, state) {
  state.session.off("Tracing.dataCollected", state.onData);
  if (state.onComplete) state.session.off("Tracing.tracingComplete", state.onComplete);
  if (traceStates.get(manager) === state) traceStates.delete(manager);
}

async function disposeTrace(manager) {
  const state = traceStates.get(manager);
  if (!state) return;
  clearTraceState(manager, state);
}

export function patchBrowseDriverExtensions(sessionManagerModule) {
  const prototype = sessionManagerModule.DriverSessionManager?.prototype;
  if (!prototype || typeof prototype.execute !== "function" || prototype.execute.workbenchPatched) return;
  const originalExecute = prototype.execute;
  const originalClose = prototype.close;
  const patchedExecute = async function execute(command, params = {}) {
    const page = async () => await this.activePage();
    if (command === "eval") return await evaluate(await page(), String(params.expression ?? ""));
    if (command === "snapshot" && params.target) {
      const result = await originalExecute.call(this, command, {});
      const activePage = await page();
      const ref = await resolveSnapshotRef(this, activePage, params.target, result.xpathMap ?? this.getRefMaps().xpathMap);
      const tree = formatScopedSnapshot(extractSnapshotSubtree(result.tree, ref), params);
      return params.compact ? { tree } : { ...result, tree };
    }
    if (command === "mouse.scroll" && (params.repeat > 1 || params.intervalMs > 0 || params.park)) {
      let result;
      for (let index = 0; index < Math.max(1, params.repeat ?? 1); index += 1) {
        if (index > 0) await delay(params.intervalMs ?? 0);
        result = await originalExecute.call(this, command, params);
      }
      if (params.park) {
        await (await page()).sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x: -1, y: -1 });
      }
      return { ...result, parked: params.park === true, repeat: Math.max(1, params.repeat ?? 1) };
    }
    if (command === "workbench.touchScroll") {
      return await dispatchTouchScroll(await page(), params);
    }
    if (command === "workbench.emulateDevice") return await emulateDevice(await page(), params.preset);
    if (command === "workbench.throttleCpu") {
      await (await page()).sendCDP("Emulation.setCPUThrottlingRate", { rate: params.rate });
      return { cpuRate: params.rate };
    }
    if (command === "workbench.throttleNetwork") return await throttleNetwork(await page(), params.preset);
    if (command === "workbench.initScript") {
      const result = await (await page()).sendCDP("Page.addScriptToEvaluateOnNewDocument", { source: params.expression });
      return { identifier: result.identifier, installed: true };
    }
    if (command === "workbench.trace") return await runTrace(this, await page(), params.operation);
    return await originalExecute.call(this, command, params);
  };
  patchedExecute.workbenchPatched = true;
  prototype.execute = patchedExecute;
  prototype.close = async function close(...args) {
    await disposeTrace(this);
    return await originalClose.apply(this, args);
  };
}
