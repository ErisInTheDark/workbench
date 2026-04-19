import type {
    ChangeSummary,
    ExplorerSnapshot,
    FilePayload,
    ProjectSnapshot,
    SaveConflictPayload,
    SaveFilePayload,
    TreeNode,
    WorkbenchBindings,
    WorkbenchControls,
} from "./types";

type EditorMode = "rich" | "plain";

interface ParsedListItem {
  text: string;
  children: ParsedBlock[];
}

type ParsedBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "blockquote"; text: string }
  | { type: "ul"; items: ParsedListItem[] }
  | { type: "ol"; items: ParsedListItem[] }
  | { type: "list-break"; count: number }
  | { type: "break"; count: number }
  | { type: "hr" }
  | { type: "code"; language: string; text: string }
  | { type: "comment"; text: string }
  | { type: "paragraph"; text: string };

interface SaveGuardIssue {
  markdown: string;
  currentMarkup: string;
  roundTripMarkup: string;
}

interface DraftBuffer {
  baselineContent: string;
  content: string;
  dirty: boolean;
  editorState: string;
  expectedMtimeMs: number | null;
  mode: EditorMode;
  pendingWriteConflict: SaveConflictPayload | null;
  saveIssue: SaveGuardIssue | null;
}

interface PersistedDraftRecord {
  path: string;
  baselineContent: string;
  content: string;
  expectedMtimeMs: number | null;
  mode: EditorMode;
}

interface SerializedBlock {
  isComment: boolean;
  text: string;
}

type SerializedMarkdownToken =
  | { type: "block"; block: SerializedBlock }
  | { type: "break"; count: number };

interface WorkbenchState {
  baselineContent: string;
  changes: Record<string, ChangeSummary>;
  currentContent: string;
  currentPath: string;
  draftBuffers: Map<string, DraftBuffer>;
  dirty: boolean;
  expectedMtimeMs: number | null;
  root: string;
  tree: TreeNode[];
  mode: EditorMode;
  fontSize: number;
  lastLoggedSaveIssue: SaveGuardIssue | null;
  pendingWriteConflict: SaveConflictPayload | null;
  saveIssue: SaveGuardIssue | null;
  expandedDirectories: Set<string>;
}

const DEFAULT_EDITOR_FONT_SIZE = 1.08;
const MIN_EDITOR_FONT_SIZE = 0.84;
const MAX_EDITOR_FONT_SIZE = 1.72;
const EDITOR_FONT_STEP = 0.08;
const AUTO_REFRESH_INTERVAL_MS = 1500;
const CURRENT_FILE_SEARCH_PARAM = "file";
const DRAFT_DATABASE_NAME = "workbench";
const DRAFT_DATABASE_VERSION = 1;
const DRAFT_STORE_NAME = "drafts";
const EXPANDED_DIRECTORIES_STORAGE_KEY = "workbench:expanded-directories";
const FONT_SIZE_STORAGE_KEY = "workbench:font-size";

export async function initWorkbench(bindings: WorkbenchBindings = {}): Promise<() => void> {
  const state: WorkbenchState = {
    baselineContent: "",
    changes: {},
    currentContent: "",
    currentPath: "",
    draftBuffers: new Map(),
    dirty: false,
    expectedMtimeMs: null,
    root: "Project",
    tree: [],
    mode: "rich",
    fontSize: readStoredFontSize(),
    lastLoggedSaveIssue: null,
    pendingWriteConflict: null,
    saveIssue: null,
    expandedDirectories: new Set(readStoredExpandedDirectories()),
  };

  const blockTags = new Set([
    "P",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "UL",
    "OL",
    "PRE",
    "BLOCKQUOTE",
    "HR",
  ]);

  const editor = document.querySelector<HTMLDivElement>("#editor");
  const floatingToolbar = document.querySelector<HTMLDivElement>("#floating-toolbar");
  const filePathLabel = document.querySelector<HTMLElement>("#file-path");
  const saveFileButton = document.querySelector<HTMLButtonElement>("#save-file");
  const saveConflictDialog = document.querySelector<HTMLDivElement>("#save-conflict-dialog");
  const saveConflictSummary = document.querySelector<HTMLElement>("#save-conflict-summary");
  const saveConflictExpected = document.querySelector<HTMLElement>("#save-conflict-expected");
  const saveConflictActual = document.querySelector<HTMLElement>("#save-conflict-actual");
  const saveConflictKeepEditingButton = document.querySelector<HTMLButtonElement>("#save-conflict-keep-editing");
  const saveConflictReloadButton = document.querySelector<HTMLButtonElement>("#save-conflict-reload");
  const saveConflictOverwriteButton = document.querySelector<HTMLButtonElement>("#save-conflict-overwrite");
  const zoomOutButton = document.querySelector<HTMLButtonElement>("#zoom-out");
  const zoomInButton = document.querySelector<HTMLButtonElement>("#zoom-in");
  const statusLine = document.querySelector<HTMLElement>("#status-line");

  if (
    !editor ||
    !floatingToolbar ||
    !filePathLabel ||
    !saveFileButton ||
    !saveConflictDialog ||
    !saveConflictSummary ||
    !saveConflictExpected ||
    !saveConflictActual ||
    !saveConflictKeepEditingButton ||
    !saveConflictReloadButton ||
    !saveConflictOverwriteButton ||
    !zoomOutButton ||
    !zoomInButton ||
    !statusLine
  ) {
    return () => {};
  }

  const abortController = new AbortController();
  const { signal } = abortController;
  let autoRefreshTimeoutId: number | null = null;
  let autoRefreshStopped = false;
  const draftDatabasePromise = openDraftDatabase();
  let draftPersistenceQueue = Promise.resolve();

  document.execCommand?.("defaultParagraphSeparator", false, "p");

  saveFileButton.addEventListener("click", async () => {
    await saveCurrentFile();
  }, { signal });

  zoomOutButton.addEventListener("click", () => {
    changeEditorFontSize(-EDITOR_FONT_STEP);
  }, { signal });

  zoomInButton.addEventListener("click", () => {
    changeEditorFontSize(EDITOR_FONT_STEP);
  }, { signal });

  saveConflictKeepEditingButton.addEventListener("click", () => {
    hideSaveConflictDialog();
    editor.focus();
  }, { signal });

  saveConflictReloadButton.addEventListener("click", async () => {
    hideSaveConflictDialog();
    if (!state.currentPath) {
      return;
    }
    await openFile(state.currentPath, { ignoreDirty: true, source: "reload" });
  }, { signal });

  saveConflictOverwriteButton.addEventListener("click", async () => {
    hideSaveConflictDialog();
    await saveCurrentFile({ force: true });
  }, { signal });

  document.addEventListener("keydown", async (event) => {
    if (event.key === "Escape" && !saveConflictDialog.hidden) {
      hideSaveConflictDialog();
      return;
    }

    if (event.defaultPrevented) {
      return;
    }

    const isPrimaryModifier = event.metaKey || event.ctrlKey;
    if (!isPrimaryModifier || event.key.toLowerCase() !== "s") {
      return;
    }

    event.preventDefault();
    await saveCurrentFile();
  }, { signal });

  editor.addEventListener("input", (event) => {
    const transformedListItem = maybeTransformParagraphIntoListItem(event);
    syncStructuredBlockStyles();
    if (transformedListItem) {
      restoreListItemSelection([transformedListItem], { collapsed: true });
    }
    inspectCurrentDraft();
    syncCurrentDraftBuffer();
    updateStatusLine();
    window.requestAnimationFrame(updateFloatingToolbar);
  }, { signal });

  editor.addEventListener("keydown", async (event) => {
    if (!state.currentPath || state.mode !== "rich") {
      return;
    }

    if (event.key === "Tab") {
      if (handleListTab(event)) {
        return;
      }
    }

    if (event.key === "Backspace") {
      if (handleListItemBackspace(event)) {
        return;
      }
    }

    if (event.key === "Enter") {
      if (handleEmptyListItemEnter(event)) {
        return;
      }
    }

    const isPrimaryModifier = event.metaKey || event.ctrlKey;
    if (!isPrimaryModifier) {
      return;
    }

    if (event.key.toLowerCase() === "b") {
      event.preventDefault();
      runEditorCommand("bold");
      return;
    }

    if (event.key.toLowerCase() === "i") {
      event.preventDefault();
      runEditorCommand("italic");
      return;
    }

    if (event.code === "Backquote" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      wrapSelection("code");
      return;
    }

    if (event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      wrapSelection("del");
      return;
    }

    if (event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      wrapSelection("ins");
    }
  }, { signal });

  document.addEventListener("selectionchange", () => {
    window.requestAnimationFrame(updateFloatingToolbar);
  }, { signal });

  saveConflictDialog.addEventListener("click", (event) => {
    if (event.target === saveConflictDialog) {
      hideSaveConflictDialog();
    }
  }, { signal });

  floatingToolbar.addEventListener("mousedown", (event) => {
    event.preventDefault();
  }, { signal });

  floatingToolbar.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-command]")
      : null;
    if (!button) {
      return;
    }

    editor.focus();
    applyToolbarCommand(button.dataset.command);
  }, { signal });

  editor.addEventListener("click", (event) => {
    const summaryText = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-summary-text="true"]')
      : null;
    if (!summaryText || !editor.contains(summaryText)) {
      return;
    }

    const summary = summaryText.closest<HTMLElement>("summary");
    if (!summary) {
      return;
    }

    event.preventDefault();
    placeCaretInElement(summaryText, event.clientX, event.clientY);
  }, { signal });

  window.addEventListener("beforeunload", (event) => {
    const hasMarkupMismatch = Boolean(state.saveIssue) || Array.from(state.draftBuffers.values()).some((buffer) => Boolean(buffer.saveIssue));
    if (!hasMarkupMismatch) {
      return;
    }

    event.preventDefault();
    event.returnValue = "";
  }, { signal });

  function readStoredExpandedDirectories() {
    try {
      const rawValue = window.localStorage.getItem(EXPANDED_DIRECTORIES_STORAGE_KEY);
      if (!rawValue) {
        return [""];
      }

      const parsedValue = JSON.parse(rawValue);
      if (!Array.isArray(parsedValue)) {
        return [""];
      }

      const normalizedPaths = parsedValue
        .filter((value): value is string => typeof value === "string")
        .sort((left, right) => left.localeCompare(right));

      return normalizedPaths.length > 0 ? normalizedPaths : [""];
    } catch {
      return [""];
    }
  }

  function persistExpandedDirectories() {
    try {
      const serialized = JSON.stringify(Array.from(state.expandedDirectories).sort((left, right) => left.localeCompare(right)));
      window.localStorage.setItem(EXPANDED_DIRECTORIES_STORAGE_KEY, serialized);
    } catch {
      // Ignore storage failures and keep the in-memory explorer state working.
    }
  }

  function readStoredFontSize() {
    try {
      const rawValue = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
      if (!rawValue) {
        return DEFAULT_EDITOR_FONT_SIZE;
      }

      const numericValue = Number.parseFloat(rawValue);
      if (Number.isNaN(numericValue)) {
        return DEFAULT_EDITOR_FONT_SIZE;
      }

      return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, numericValue));
    } catch {
      return DEFAULT_EDITOR_FONT_SIZE;
    }
  }

  function persistFontSize() {
    try {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(state.fontSize));
    } catch {
      // Ignore storage failures and keep the in-memory zoom state working.
    }
  }

  function getRequestedPathFromUrl() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get(CURRENT_FILE_SEARCH_PARAM) ?? "";
    } catch {
      return "";
    }
  }

  function syncCurrentPathToUrl(filePath: string) {
    try {
      const url = new URL(window.location.href);
      if (filePath) {
        url.searchParams.set(CURRENT_FILE_SEARCH_PARAM, filePath);
      } else {
        url.searchParams.delete(CURRENT_FILE_SEARCH_PARAM);
      }

      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState(window.history.state, "", nextUrl);
    } catch {
      // Ignore URL update failures and keep the editor working.
    }
  }

  function wrapIndexedDbRequest<T>(request: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("IndexedDB request failed."));
      };
    });
  }

  function waitForTransaction(transaction: IDBTransaction) {
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      };
    });
  }

  function openDraftDatabase() {
    if (typeof window.indexedDB === "undefined") {
      return Promise.resolve<IDBDatabase | null>(null);
    }

    return new Promise<IDBDatabase | null>((resolve) => {
      const request = window.indexedDB.open(DRAFT_DATABASE_NAME, DRAFT_DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
          database.createObjectStore(DRAFT_STORE_NAME, { keyPath: "path" });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        resolve(null);
      };

      request.onblocked = () => {
        resolve(null);
      };
    });
  }

  async function getPersistedDraftRecords() {
    const database = await draftDatabasePromise;
    if (!database) {
      return [] as PersistedDraftRecord[];
    }

    const transaction = database.transaction(DRAFT_STORE_NAME, "readonly");
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const request = store.getAll();
    const result = await wrapIndexedDbRequest(request as IDBRequest<PersistedDraftRecord[]>);
    await waitForTransaction(transaction);
    return result;
  }

  async function putPersistedDraftRecord(record: PersistedDraftRecord) {
    const database = await draftDatabasePromise;
    if (!database) {
      return;
    }

    const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    await wrapIndexedDbRequest(store.put(record));
    await waitForTransaction(transaction);
  }

  async function deletePersistedDraftRecord(filePath: string) {
    const database = await draftDatabasePromise;
    if (!database) {
      return;
    }

    const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    await wrapIndexedDbRequest(store.delete(filePath));
    await waitForTransaction(transaction);
  }

  function enqueueDraftPersistence(operation: () => Promise<void>) {
    draftPersistenceQueue = draftPersistenceQueue
      .catch(() => {
        // Keep later persistence operations flowing after a transient failure.
      })
      .then(operation);

    return draftPersistenceQueue;
  }

  function buildPersistedDraftRecord(filePath: string, buffer: DraftBuffer): PersistedDraftRecord {
    return {
      path: filePath,
      baselineContent: buffer.baselineContent,
      content: buffer.content,
      expectedMtimeMs: buffer.expectedMtimeMs,
      mode: buffer.mode,
    };
  }

  function createEditorStateFromContent(content: string, mode: EditorMode) {
    return mode === "rich"
      ? markdownToHtml(content)
      : content;
  }

  function hydrateDraftBuffers(records: PersistedDraftRecord[]) {
    state.draftBuffers = new Map(
      records.map((record) => {
        const buffer: DraftBuffer = {
          baselineContent: record.baselineContent,
          content: record.content,
          dirty: record.content !== record.baselineContent,
          editorState: createEditorStateFromContent(record.content, record.mode),
          expectedMtimeMs: record.expectedMtimeMs,
          mode: record.mode,
          pendingWriteConflict: null,
          saveIssue: null,
        };

        return [record.path, buffer];
      }),
    );
  }

  function persistDraftBuffer(filePath: string, buffer: DraftBuffer | null) {
    return enqueueDraftPersistence(async () => {
      if (!buffer || !buffer.dirty) {
        await deletePersistedDraftRecord(filePath);
        return;
      }

      await putPersistedDraftRecord(buildPersistedDraftRecord(filePath, buffer));
    });
  }

  function treeContainsFilePath(nodes: TreeNode[], filePath: string): boolean {
    for (const node of nodes) {
      if (node.type === "file" && node.path === filePath) {
        return true;
      }
      if (node.type === "directory" && treeContainsFilePath(node.children, filePath)) {
        return true;
      }
    }

    return false;
  }

  function formatTimestamp(value: string) {
    if (!value) {
      return "";
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function isMarkdownFile(filePath: string) {
    return /\.md(?:own)?$/i.test(filePath);
  }

  function isTextLikeFile(filePath: string) {
    return /\.(?:md|txt|json|js|mjs|cjs|css|html|yml|yaml|toml|gitignore)$/i.test(filePath) || !/\.[a-z0-9]+$/i.test(filePath);
  }

  function getFirstFile(nodes: TreeNode[], predicate: (filePath: string) => boolean = () => true) {
    for (const node of nodes) {
      if (node.type === "file" && predicate(node.path)) {
        return node.path;
      }
      if (node.type === "directory") {
        const nested = getFirstFile(node.children, predicate);
        if (nested) {
          return nested;
        }
      }
    }
    return "";
  }

  function describeChange(filePath: string) {
    const entry = state.changes[filePath];
    if (!entry) {
      return "";
    }

    const parts = [];
    if (entry.additions) {
      parts.push(`+${entry.additions}`);
    }
    if (entry.deletions) {
      parts.push(`-${entry.deletions}`);
    }
    return parts.join(" ");
  }

  function isBlockCommentLine(text: string) {
    const trimmed = text.trim();
    return trimmed.startsWith("<!--") && trimmed.endsWith("-->");
  }

  function isSingleBreakParagraph(element: HTMLElement) {
    if (element.tagName !== "P") {
      return false;
    }

    let breakCount = 0;

    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent ?? "").trim()) {
          return false;
        }
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return false;
      }

      const childElement = node as Element;
      if (childElement.tagName !== "BR") {
        return false;
      }

      breakCount += 1;
    }

    return breakCount === 1;
  }

  function getLastNonBreakBlock(blocks: ParsedBlock[]) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index].type !== "break") {
        return blocks[index];
      }
    }

    return null;
  }

  function maybePushCommentBreak(blocks: ParsedBlock[], blankLineCount: number, nextBlockType: ParsedBlock["type"]) {
    if (!blankLineCount) {
      return;
    }

    const previousBlock = getLastNonBreakBlock(blocks);
    if (nextBlockType === "comment" || previousBlock?.type === "comment") {
      blocks.push({ type: "break", count: blankLineCount });
    }
  }

  function isListElement(element: Element) {
    return element.tagName === "UL" || element.tagName === "OL";
  }

  function getDirectChildListElements(element: Element) {
    return Array.from(element.children).filter((child): child is HTMLUListElement | HTMLOListElement => isListElement(child));
  }

  function getDirectChildDetailsElement(element: Element) {
    return Array.from(element.children).find((child): child is HTMLDetailsElement => child.tagName === "DETAILS");
  }

  function getDirectChildSummaryElement(element: Element) {
    return Array.from(element.children).find((child): child is HTMLElement => child.tagName === "SUMMARY");
  }

  function getDirectChildSummaryTextElement(element: Element) {
    return Array.from(element.children).find((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.summaryText === "true");
  }

  function ensureSummaryTextWrapper(summary: HTMLElement) {
    const existingWrapper = getDirectChildSummaryTextElement(summary);
    if (existingWrapper) {
      return existingWrapper;
    }

    const wrapper = document.createElement("span");
    wrapper.dataset.summaryText = "true";

    while (summary.firstChild) {
      wrapper.append(summary.firstChild);
    }

    if (!wrapper.childNodes.length) {
      wrapper.append(document.createElement("br"));
    }

    summary.append(wrapper);
    return wrapper;
  }

  function trimBoundaryBreaks(container: HTMLElement) {
    const hasMeaningfulContent = Array.from(container.childNodes).some((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return Boolean((node.textContent ?? "").trim());
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return false;
      }

      return (node as Element).tagName !== "BR";
    });

    if (!hasMeaningfulContent) {
      return;
    }

    let firstMeaningfulNode = container.firstChild;
    while (
      firstMeaningfulNode?.nodeType === Node.TEXT_NODE
      && !(firstMeaningfulNode.textContent ?? "").trim()
    ) {
      firstMeaningfulNode = firstMeaningfulNode.nextSibling;
    }
    while (firstMeaningfulNode instanceof HTMLBRElement) {
      const nextNode = firstMeaningfulNode.nextSibling;
      firstMeaningfulNode.remove();
      firstMeaningfulNode = nextNode;
      while (
        firstMeaningfulNode?.nodeType === Node.TEXT_NODE
        && !(firstMeaningfulNode.textContent ?? "").trim()
      ) {
        firstMeaningfulNode = firstMeaningfulNode.nextSibling;
      }
    }

    let lastMeaningfulNode = container.lastChild;
    while (
      lastMeaningfulNode?.nodeType === Node.TEXT_NODE
      && !(lastMeaningfulNode.textContent ?? "").trim()
    ) {
      lastMeaningfulNode = lastMeaningfulNode.previousSibling;
    }
    while (lastMeaningfulNode instanceof HTMLBRElement) {
      const previousNode = lastMeaningfulNode.previousSibling;
      lastMeaningfulNode.remove();
      lastMeaningfulNode = previousNode;
      while (
        lastMeaningfulNode?.nodeType === Node.TEXT_NODE
        && !(lastMeaningfulNode.textContent ?? "").trim()
      ) {
        lastMeaningfulNode = lastMeaningfulNode.previousSibling;
      }
    }
  }

  function hasMeaningfulListItemContent(item: HTMLLIElement) {
    return (item.textContent ?? "").replaceAll("\u00a0", "").length > 0
      || item.querySelector("br, details, ul, ol, pre, blockquote, hr") !== null;
  }

  function normalizeSummaryListArtifacts(details: HTMLDetailsElement, summaryText: HTMLElement) {
    const embeddedLists = Array.from(summaryText.querySelectorAll("ul, ol")).filter((list) => {
      const ancestorList = list.parentElement?.closest("ul, ol");
      return !ancestorList || !summaryText.contains(ancestorList);
    });

    for (const list of embeddedLists) {
      details.append(list);
    }

    const strayListItems = Array.from(summaryText.querySelectorAll("li")).filter((item) => !item.closest("ul, ol"));
    if (!strayListItems.length) {
      return;
    }

    const meaningfulItems = strayListItems.filter(hasMeaningfulListItemContent);
    for (const item of strayListItems) {
      if (!hasMeaningfulListItemContent(item)) {
        item.remove();
      }
    }

    if (!meaningfulItems.length) {
      return;
    }

    const targetList = getOrCreateDirectChildList(details, "UL");
    const insertionPoint = targetList.firstChild;
    for (const item of meaningfulItems) {
      targetList.insertBefore(item, insertionPoint);
    }
  }

  function getCaretRangeFromPoint(clientX: number, clientY: number) {
    if (typeof document.caretPositionFromPoint === "function") {
      const caretPosition = document.caretPositionFromPoint(clientX, clientY);
      if (!caretPosition) {
        return null;
      }

      const range = document.createRange();
      range.setStart(caretPosition.offsetNode, caretPosition.offset);
      range.collapse(true);
      return range;
    }

    if (typeof document.caretRangeFromPoint === "function") {
      return document.caretRangeFromPoint(clientX, clientY);
    }

    return null;
  }

  function placeCaretInElement(container: HTMLElement, clientX: number, clientY: number) {
    editor.focus();
    const selection = window.getSelection();
    const range = getCaretRangeFromPoint(clientX, clientY);

    if (selection && range && container.contains(range.startContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }

    const fallbackRange = document.createRange();
    fallbackRange.selectNodeContents(container);
    fallbackRange.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(fallbackRange);
  }

  function getDirectEditorParagraph(node: Node | null) {
    let current: Node | null = node;

    while (current && current !== editor) {
      if (current instanceof HTMLLIElement) {
        return null;
      }

      if (
        current instanceof HTMLElement
        && current.parentNode === editor
        && /^(p|div)$/i.test(current.tagName)
      ) {
        return current;
      }

      current = current.parentNode;
    }

    return null;
  }

  function getTextBeforeSelectionInElement(selection: Selection, element: HTMLElement) {
    if (!selection.rangeCount) {
      return "";
    }

    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) {
      return "";
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(element);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    return beforeRange.toString().replaceAll("\u00a0", " ");
  }

  function getTextPositionAtOffset(root: Node, offset: number) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let currentNode = walker.nextNode();

    if (!currentNode) {
      return offset === 0 ? { node: root, offset: 0 } : null;
    }

    while (currentNode) {
      const textNode = currentNode as Text;
      const textLength = textNode.textContent?.length ?? 0;
      if (remaining <= textLength) {
        return { node: textNode, offset: remaining };
      }

      remaining -= textLength;
      currentNode = walker.nextNode();
    }

    return null;
  }

  function deleteLeadingTextFromElement(element: HTMLElement, characterCount: number) {
    const endPosition = getTextPositionAtOffset(element, characterCount);
    if (!endPosition) {
      return false;
    }

    const range = document.createRange();
    range.setStart(element, 0);
    range.setEnd(endPosition.node, endPosition.offset);
    range.deleteContents();
    return true;
  }

  function ensureListItemHasEditableContent(item: HTMLLIElement) {
    const hasMeaningfulContent = (item.textContent ?? "").replaceAll("\u00a0", "").length > 0
      || item.querySelector("br, details, ul, ol, pre, blockquote, hr") !== null;

    if (hasMeaningfulContent) {
      return;
    }

    item.replaceChildren(document.createElement("br"));
  }

  function ensureParagraphHasEditableContent(paragraph: HTMLElement) {
    if ((paragraph.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
      return;
    }

    if (paragraph.querySelector("br, ul, ol, pre, blockquote, hr") !== null) {
      return;
    }

    paragraph.replaceChildren(document.createElement("br"));
  }

  function isIntentionalListBreakParagraph(element: Element | null): element is HTMLElement {
    return element instanceof HTMLElement
      && element.dataset.listBreak === "true"
      && isSingleBreakParagraph(element);
  }

  function insertListItemAtParagraphPosition(paragraph: HTMLElement, item: HTMLLIElement) {
    const previousList = paragraph.previousElementSibling instanceof HTMLUListElement
      ? paragraph.previousElementSibling
      : null;
    const nextList = paragraph.nextElementSibling instanceof HTMLUListElement
      ? paragraph.nextElementSibling
      : null;

    if (previousList) {
      previousList.append(item);
      paragraph.remove();

      if (nextList) {
        while (nextList.firstChild) {
          previousList.append(nextList.firstChild);
        }
        nextList.remove();
      }
      return;
    }

    if (nextList) {
      nextList.prepend(item);
      paragraph.remove();
      return;
    }

    const list = document.createElement("ul");
    list.append(item);
    paragraph.replaceWith(list);
  }

  function maybeTransformParagraphIntoListItem(event: Event) {
    if (!(event instanceof InputEvent) || state.mode !== "rich") {
      return null;
    }

    if (event.inputType !== "insertText" || event.data !== " ") {
      return null;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return null;
    }

    const paragraph = getDirectEditorParagraph(selection.getRangeAt(0).startContainer);
    if (!paragraph || paragraph.dataset.blockComment === "true") {
      return null;
    }

    const beforeText = getTextBeforeSelectionInElement(selection, paragraph);
    if (beforeText !== "- ") {
      return null;
    }

    if (!deleteLeadingTextFromElement(paragraph, 2)) {
      return null;
    }

    const item = document.createElement("li");
    while (paragraph.firstChild) {
      item.append(paragraph.firstChild);
    }

    item.normalize();
    ensureListItemHasEditableContent(item);
    insertListItemAtParagraphPosition(paragraph, item);
    return item;
  }

  function createParagraphFromTopLevelListItem(item: HTMLLIElement, { preserveEmptyListBreak }: { preserveEmptyListBreak: boolean }) {
    const paragraph = document.createElement("p");
    const details = getDirectChildDetailsElement(item);

    if (details) {
      const summary = getDirectChildSummaryElement(details);
      const summaryText = summary
        ? getDirectChildSummaryTextElement(summary) ?? summary
        : null;

      if (summaryText) {
        while (summaryText.firstChild) {
          paragraph.append(summaryText.firstChild);
        }
      }
    } else {
      const contentNodes = Array.from(item.childNodes).filter((node) => {
        return !(node instanceof Element && isListElement(node));
      });

      for (const node of contentNodes) {
        paragraph.append(node);
      }
    }

    paragraph.normalize();
    ensureParagraphHasEditableContent(paragraph);

    if (preserveEmptyListBreak && isSingleBreakParagraph(paragraph)) {
      paragraph.dataset.listBreak = "true";
    }

    return paragraph;
  }

  function getNestedListBreakoutNodes(item: HTMLLIElement) {
    const details = getDirectChildDetailsElement(item);
    if (details) {
      return getDirectChildListElements(details);
    }

    return getDirectChildListElements(item);
  }

  function unwrapTopLevelListItemToParagraph(item: HTMLLIElement) {
    const parentList = getParentListElement(item);
    if (!parentList) {
      return null;
    }

    const previousSibling = item.previousElementSibling instanceof HTMLLIElement
      ? item.previousElementSibling
      : null;
    const nextSibling = item.nextElementSibling instanceof HTMLLIElement
      ? item.nextElementSibling
      : null;
    const preserveEmptyListBreak = Boolean(previousSibling && nextSibling);
    const paragraph = createParagraphFromTopLevelListItem(item, { preserveEmptyListBreak });
    const nestedBreakoutNodes = getNestedListBreakoutNodes(item);
    const trailingItems: HTMLLIElement[] = [];
    let trailingNode = item.nextElementSibling;

    while (trailingNode) {
      const nextTrailingNode = trailingNode.nextElementSibling;
      if (trailingNode instanceof HTMLLIElement) {
        trailingItems.push(trailingNode);
      }
      trailingNode = nextTrailingNode;
    }

    const trailingList = trailingItems.length
      ? document.createElement(parentList.tagName.toLowerCase()) as HTMLUListElement | HTMLOListElement
      : null;

    if (trailingList) {
      for (const trailingItem of trailingItems) {
        trailingList.append(trailingItem);
      }
    }

    const insertionParent = parentList.parentNode;
    if (!insertionParent) {
      return paragraph;
    }

    const parentListNextSibling = parentList.nextSibling;
    item.remove();
    const hasLeadingItems = parentList.children.length > 0;
    if (!hasLeadingItems) {
      parentList.remove();
    }

    const insertionAnchor = hasLeadingItems
      ? parentList.nextSibling
      : parentListNextSibling;
    insertionParent.insertBefore(paragraph, insertionAnchor);

    let nextInsertionPoint = paragraph.nextSibling;
    for (const breakoutNode of nestedBreakoutNodes) {
      insertionParent.insertBefore(breakoutNode, nextInsertionPoint);
      nextInsertionPoint = breakoutNode.nextSibling;
    }

    if (trailingList) {
      insertionParent.insertBefore(trailingList, nextInsertionPoint);
    }

    return paragraph;
  }

  function normalizeListItemHierarchy(item: HTMLLIElement) {
    const details = getDirectChildDetailsElement(item);
    const directLists = getDirectChildListElements(item);

    if (!details && !directLists.length) {
      return;
    }

    if (!details) {
      const nextDetails = document.createElement("details");
      nextDetails.open = true;
      const summary = document.createElement("summary");
      const summaryText = ensureSummaryTextWrapper(summary);
      const summaryNodes = Array.from(item.childNodes).filter((node) => {
        return !(node instanceof Element && directLists.some((list) => list === node));
      });

      for (const node of summaryNodes) {
        summaryText.append(node);
      }
      normalizeSummaryListArtifacts(nextDetails, summaryText);
      trimBoundaryBreaks(summaryText);

      if (!summaryText.childNodes.length) {
        summaryText.append(document.createElement("br"));
      }

      nextDetails.append(summary);
      for (const list of directLists) {
        nextDetails.append(list);
      }
      item.append(nextDetails);
      return;
    }

    const summary = getDirectChildSummaryElement(details) ?? document.createElement("summary");
    if (summary.parentElement !== details) {
      details.prepend(summary);
    }
    const summaryText = ensureSummaryTextWrapper(summary);

    const externalNodes = Array.from(item.childNodes).filter((node) => node !== details);
    for (const node of externalNodes) {
      summaryText.append(node);
    }

    const strayDetailNodes = Array.from(details.childNodes).filter((node) => {
      if (node === summary) {
        return false;
      }

      return !(node instanceof Element && isListElement(node));
    });
    for (const node of strayDetailNodes) {
      summaryText.append(node);
    }
    normalizeSummaryListArtifacts(details, summaryText);
    trimBoundaryBreaks(summaryText);

    const nestedLists = getDirectChildListElements(details);
    if (!nestedLists.length) {
      while (summaryText.firstChild) {
        item.insertBefore(summaryText.firstChild, details);
      }
      details.remove();
      if (!item.childNodes.length) {
        item.append(document.createElement("br"));
      }
      return;
    }

    if (!summaryText.childNodes.length) {
      summaryText.append(document.createElement("br"));
    }
  }

  function normalizeNestedListHierarchy(root: ParentNode = editor) {
    const listItems = root instanceof HTMLLIElement
      ? [root]
      : Array.from(root.querySelectorAll("li"));

    for (const item of listItems) {
      if (item instanceof HTMLLIElement) {
        normalizeListItemHierarchy(item);
      }
    }
  }

  function isMergeableListElement(node: Node | null): node is HTMLUListElement | HTMLOListElement {
    return node instanceof HTMLUListElement || node instanceof HTMLOListElement;
  }

  function isListMergeSeparatorNode(node: Node | null) {
    if (!node) {
      return false;
    }

    if (node instanceof HTMLBRElement) {
      return true;
    }

    return node instanceof HTMLElement
      && isSingleBreakParagraph(node)
      && !isIntentionalListBreakParagraph(node);
  }

  function getNextMeaningfulSibling(node: ChildNode | null) {
    let current = node;

    while (current?.nodeType === Node.TEXT_NODE && !(current.textContent ?? "").trim()) {
      const nextSibling = current.nextSibling;
      current.remove();
      current = nextSibling;
    }

    return current;
  }

  function mergeAdjacentSiblingLists(root: ParentNode = editor) {
    const childElements = root instanceof Element || root instanceof DocumentFragment
      ? Array.from(root.children)
      : [];

    for (const childElement of childElements) {
      mergeAdjacentSiblingLists(childElement);
    }

    let current = getNextMeaningfulSibling(root.firstChild);

    while (current) {
      if (!isMergeableListElement(current)) {
        current = getNextMeaningfulSibling(current.nextSibling);
        continue;
      }

      const separator = getNextMeaningfulSibling(current.nextSibling);
      const nextList = isListMergeSeparatorNode(separator)
        ? getNextMeaningfulSibling(separator.nextSibling)
        : separator;

      if (isMergeableListElement(nextList) && nextList.tagName === current.tagName) {
        while (nextList.firstChild) {
          current.append(nextList.firstChild);
        }

        nextList.remove();
        if (separator && isListMergeSeparatorNode(separator)) {
          separator.remove();
        }
        continue;
      }

      current = getNextMeaningfulSibling(current.nextSibling);
    }
  }

  function syncStructuredBlockStyles(root: ParentNode = editor) {
    normalizeNestedListHierarchy(root);
    mergeAdjacentSiblingLists(root);

    const candidates = root instanceof HTMLDivElement && root === editor
      ? Array.from(root.children)
      : Array.from(root.querySelectorAll("p, div"));

    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      const isCommentCandidate = /^(p|div)$/i.test(element.tagName);
      if (!isCommentCandidate) {
        element.removeAttribute("data-block-comment");
        element.removeAttribute("data-single-break");
        continue;
      }

      if (isSingleBreakParagraph(element)) {
        element.dataset.singleBreak = "true";
      } else {
        element.removeAttribute("data-single-break");
      }

      if (isBlockCommentLine(element.textContent ?? "")) {
        element.dataset.blockComment = "true";
      } else {
        element.removeAttribute("data-block-comment");
      }
    }
  }

  function updateSaveButtonState() {
    saveFileButton.dataset.invalid = state.saveIssue ? "true" : "false";
  }

  function hideSaveConflictDialog() {
    saveConflictDialog.hidden = true;
  }

  function clearWriteConflict() {
    state.pendingWriteConflict = null;
    hideSaveConflictDialog();
  }

  function showWriteConflict(conflict: SaveConflictPayload) {
    state.pendingWriteConflict = conflict;
    saveConflictSummary.textContent = `${conflict.path} changed on disk after you opened it. Reload from disk to discard your unsaved editor state, or overwrite anyway to write what is currently in the editor.`;
    saveConflictExpected.textContent = `Opened version: ${formatTimestamp(conflict.expectedUpdatedAt)}`;
    saveConflictActual.textContent = `Current disk version: ${formatTimestamp(conflict.actualUpdatedAt)}`;
    saveConflictDialog.hidden = false;
    window.requestAnimationFrame(() => {
      saveConflictKeepEditingButton.focus();
    });
  }

  function getCurrentEditorState() {
    return state.mode === "rich"
      ? editor.innerHTML
      : editor.textContent ?? "";
  }

  function hasBufferedDraftState(buffer: DraftBuffer) {
    return buffer.dirty || Boolean(buffer.saveIssue) || Boolean(buffer.pendingWriteConflict);
  }

  function getLocallyModifiedPaths() {
    const modifiedPaths = new Set<string>();

    if (state.currentPath && state.dirty) {
      modifiedPaths.add(state.currentPath);
    }

    for (const [filePath, buffer] of state.draftBuffers) {
      if (buffer.dirty) {
        modifiedPaths.add(filePath);
      }
    }

    return Array.from(modifiedPaths).sort((left, right) => left.localeCompare(right));
  }

  function getExplorerSnapshot(): ExplorerSnapshot {
    return {
      root: state.root,
      tree: state.tree,
      changes: state.changes,
      currentPath: state.currentPath,
      expandedDirectories: Array.from(state.expandedDirectories).sort((left, right) => left.localeCompare(right)),
      locallyModifiedPaths: getLocallyModifiedPaths(),
    };
  }

  function emitExplorerStateChange() {
    bindings.onExplorerStateChange?.(getExplorerSnapshot());
  }

  function toggleDirectory(path: string) {
    if (!path) {
      return;
    }

    if (state.expandedDirectories.has(path)) {
      state.expandedDirectories.delete(path);
    } else {
      state.expandedDirectories.add(path);
    }

    persistExpandedDirectories();
    emitExplorerStateChange();
  }

  function syncCurrentDraftBuffer() {
    if (!state.currentPath) {
      return;
    }

    const previousModified = state.draftBuffers.get(state.currentPath)?.dirty ?? false;
    const nextBuffer: DraftBuffer = {
      baselineContent: state.baselineContent,
      content: state.currentContent,
      dirty: state.dirty,
      editorState: getCurrentEditorState(),
      expectedMtimeMs: state.expectedMtimeMs,
      mode: state.mode,
      pendingWriteConflict: state.pendingWriteConflict
        ? { ...state.pendingWriteConflict }
        : null,
      saveIssue: state.saveIssue
        ? { ...state.saveIssue }
        : null,
    };

    if (!hasBufferedDraftState(nextBuffer)) {
      state.draftBuffers.delete(state.currentPath);
      void persistDraftBuffer(state.currentPath, null);
      if (previousModified) {
        emitExplorerStateChange();
      }
      return;
    }

    state.draftBuffers.set(state.currentPath, nextBuffer);
    void persistDraftBuffer(state.currentPath, nextBuffer);
    if (previousModified !== nextBuffer.dirty) {
      emitExplorerStateChange();
    }
  }

  function restoreDraftBuffer(filePath: string, buffer: DraftBuffer) {
    clearWriteConflict();
    state.currentPath = filePath;
    state.expectedMtimeMs = buffer.expectedMtimeMs;
    state.mode = buffer.mode;
    editor.dataset.placeholder = buffer.mode === "rich"
      ? "Select a markdown file to start editing."
      : "Plain text mode";
    filePathLabel.textContent = filePath;

    if (buffer.mode === "rich") {
      editor.innerHTML = buffer.editorState;
    } else {
      editor.textContent = buffer.editorState;
    }

    applyEditorFontSize();
    syncStructuredBlockStyles();
    editor.scrollTop = 0;
    state.baselineContent = buffer.baselineContent;
    state.currentContent = buffer.content;
    state.dirty = buffer.dirty;
    state.pendingWriteConflict = buffer.pendingWriteConflict
      ? { ...buffer.pendingWriteConflict }
      : null;
    state.saveIssue = buffer.saveIssue
      ? { ...buffer.saveIssue }
      : null;
    state.lastLoggedSaveIssue = buffer.saveIssue
      ? { ...buffer.saveIssue }
      : null;
    updateSaveButtonState();
    updateStatusLine();
  }

  function isSameSaveGuardIssue(left: SaveGuardIssue | null, right: SaveGuardIssue | null) {
    if (!left || !right) {
      return left === right;
    }

    return left.markdown === right.markdown
      && left.currentMarkup === right.currentMarkup
      && left.roundTripMarkup === right.roundTripMarkup;
  }

  function applyEditorFontSize() {
    editor.style.fontSize = `${state.fontSize}rem`;
  }

  function changeEditorFontSize(delta: number) {
    const nextFontSize = Math.min(
      MAX_EDITOR_FONT_SIZE,
      Math.max(MIN_EDITOR_FONT_SIZE, Number((state.fontSize + delta).toFixed(2))),
    );

    if (nextFontSize === state.fontSize) {
      return;
    }

    state.fontSize = nextFontSize;
    applyEditorFontSize();
    persistFontSize();
  }

  function escapeHtml(value: string) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function findClosingToken(source: string, token: string, fromIndex: number) {
    for (let index = fromIndex; index < source.length; index += 1) {
      if (source[index - 1] === "\\") {
        continue;
      }
      if (source.startsWith(token, index)) {
        return index;
      }
    }
    return -1;
  }

  function renderInline(markdown: string) {
    let html = "";
    let index = 0;

    while (index < markdown.length) {
      if (markdown[index] === "\\") {
        html += escapeHtml(markdown.slice(index + 1, index + 2));
        index += 2;
        continue;
      }

      if (markdown.startsWith("<del>", index)) {
        const closeIndex = markdown.indexOf("</del>", index + 5);
        if (closeIndex !== -1) {
          html += `<del>${renderInline(markdown.slice(index + 5, closeIndex))}</del>`;
          index = closeIndex + 6;
          continue;
        }
      }

      if (markdown.startsWith("<ins>", index)) {
        const closeIndex = markdown.indexOf("</ins>", index + 5);
        if (closeIndex !== -1) {
          html += `<ins>${renderInline(markdown.slice(index + 5, closeIndex))}</ins>`;
          index = closeIndex + 6;
          continue;
        }
      }

      if (markdown.startsWith("**", index) || markdown.startsWith("__", index)) {
        const marker = markdown.slice(index, index + 2);
        const closeIndex = findClosingToken(markdown, marker, index + 2);
        if (closeIndex !== -1) {
          html += `<strong>${renderInline(markdown.slice(index + 2, closeIndex))}</strong>`;
          index = closeIndex + 2;
          continue;
        }
      }

      if (markdown.startsWith("~~", index)) {
        const closeIndex = findClosingToken(markdown, "~~", index + 2);
        if (closeIndex !== -1) {
          html += `<del>${renderInline(markdown.slice(index + 2, closeIndex))}</del>`;
          index = closeIndex + 2;
          continue;
        }
      }

      if (markdown[index] === "*" || markdown[index] === "_") {
        const marker = markdown[index];
        const closeIndex = findClosingToken(markdown, marker, index + 1);
        if (closeIndex !== -1) {
          html += `<em>${renderInline(markdown.slice(index + 1, closeIndex))}</em>`;
          index = closeIndex + 1;
          continue;
        }
      }

      if (markdown[index] === "`") {
        const closeIndex = findClosingToken(markdown, "`", index + 1);
        if (closeIndex !== -1) {
          html += `<code>${escapeHtml(markdown.slice(index + 1, closeIndex))}</code>`;
          index = closeIndex + 1;
          continue;
        }
      }

      if (markdown[index] === "[") {
        const labelEnd = findClosingToken(markdown, "]", index + 1);
        if (labelEnd !== -1 && markdown[labelEnd + 1] === "(") {
          const urlEnd = findClosingToken(markdown, ")", labelEnd + 2);
          if (urlEnd !== -1) {
            const label = markdown.slice(index + 1, labelEnd);
            const url = markdown.slice(labelEnd + 2, urlEnd);
            html += `<a href="${escapeHtml(url)}">${renderInline(label)}</a>`;
            index = urlEnd + 1;
            continue;
          }
        }
      }

      if (markdown[index] === "\n") {
        html += "<br>";
        index += 1;
        continue;
      }

      html += escapeHtml(markdown[index]);
      index += 1;
    }

    return html;
  }

  function parseListLine(line: string) {
    const expandedLine = line.replaceAll("\t", "  ");
    const match = expandedLine.match(/^(\s*)([-*+]|\d+[.)])(?:\s+(.*))?$/);
    if (!match) {
      return null;
    }

    return {
      indent: match[1].length,
      text: match[3] ?? "",
      type: /^\d+[.)]$/.test(match[2]) ? "ol" : "ul" as "ol" | "ul",
    };
  }

  function parseSpecificListBlock(lines: string[], startIndex: number, indent: number, type: "ul" | "ol") {
    const items: ParsedListItem[] = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = parseListLine(lines[index]);
      if (!line || line.indent !== indent || line.type !== type) {
        break;
      }

      const item: ParsedListItem = {
        text: line.text,
        children: [],
      };
      index += 1;

      while (index < lines.length) {
        const nestedLine = parseListLine(lines[index]);
        if (!nestedLine || nestedLine.indent <= indent) {
          break;
        }

        const nestedBlock = parseSpecificListBlock(lines, index, nestedLine.indent, nestedLine.type);
        item.children.push(nestedBlock.block);
        index = nestedBlock.nextIndex;
      }

      items.push(item);
    }

    return {
      block: { type, items } satisfies Extract<ParsedBlock, { type: "ul" | "ol" }>,
      nextIndex: index,
    };
  }

  function parseListBlock(lines: string[], startIndex: number) {
    const firstLine = parseListLine(lines[startIndex]);
    if (!firstLine) {
      return null;
    }

    return parseSpecificListBlock(lines, startIndex, firstLine.indent, firstLine.type);
  }

  function parseBlocks(markdown: string): ParsedBlock[] {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const blocks: ParsedBlock[] = [];
    let blankLineCount = 0;

    for (let index = 0; index < lines.length;) {
      const line = lines[index];

      if (!line.trim()) {
        blankLineCount += 1;
        index += 1;
        continue;
      }

      if (isBlockCommentLine(line)) {
        maybePushCommentBreak(blocks, blankLineCount, "comment");
        blankLineCount = 0;
        blocks.push({ type: "comment", text: line });
        index += 1;
        continue;
      }

      const fenceMatch = line.match(/^```(.*)$/);
      if (fenceMatch) {
        maybePushCommentBreak(blocks, blankLineCount, "code");
        blankLineCount = 0;
        const language = fenceMatch[1].trim();
        const codeLines = [];
        index += 1;

        while (index < lines.length && !lines[index].startsWith("```")) {
          codeLines.push(lines[index]);
          index += 1;
        }

        if (index < lines.length) {
          index += 1;
        }

        blocks.push({ type: "code", language, text: codeLines.join("\n") });
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        maybePushCommentBreak(blocks, blankLineCount, "heading");
        blankLineCount = 0;
        blocks.push({
          type: "heading",
          level: headingMatch[1].length,
          text: headingMatch[2],
        });
        index += 1;
        continue;
      }

      if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        maybePushCommentBreak(blocks, blankLineCount, "hr");
        blankLineCount = 0;
        blocks.push({ type: "hr" });
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        maybePushCommentBreak(blocks, blankLineCount, "blockquote");
        blankLineCount = 0;
        const quoteLines = [];

        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^>\s?/, ""));
          index += 1;
        }

        blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
        continue;
      }

      const listBlock = parseListBlock(lines, index);
      if (listBlock) {
        const previousBlock = getLastNonBreakBlock(blocks);
        if (
          blankLineCount > 0
          && previousBlock
          && (previousBlock.type === "ul" || previousBlock.type === "ol")
        ) {
          blocks.push({ type: "list-break", count: blankLineCount });
        } else {
          maybePushCommentBreak(blocks, blankLineCount, listBlock.block.type);
        }
        blankLineCount = 0;
        blocks.push(listBlock.block);
        index = listBlock.nextIndex;
        continue;
      }

      const paragraphLines = [];
      maybePushCommentBreak(blocks, blankLineCount, "paragraph");
      blankLineCount = 0;
      while (
        index < lines.length &&
        lines[index].trim() &&
        !isBlockCommentLine(lines[index]) &&
        !/^```/.test(lines[index]) &&
        !/^(#{1,6})\s+/.test(lines[index]) &&
        !/^>\s?/.test(lines[index]) &&
        !/^[-*+]\s+/.test(lines[index]) &&
        !/^\d+[.)]\s+/.test(lines[index]) &&
        !/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])
      ) {
        paragraphLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
    }

    if (blankLineCount > 0 && getLastNonBreakBlock(blocks)?.type === "comment") {
      blocks.push({ type: "break", count: blankLineCount });
    }

    return blocks;
  }

  function renderListBlock(block: Extract<ParsedBlock, { type: "ul" | "ol" }>) {
    return `<${block.type}>${block.items.map((item) => renderListItem(item)).join("")}</${block.type}>`;
  }

  function renderListItem(item: ParsedListItem) {
    const content = renderInline(item.text) || "<br>";
    if (!item.children.length) {
      return `<li>${content}</li>`;
    }

    const childContent = item.children
      .map((child) => child.type === "ul" || child.type === "ol" ? renderListBlock(child) : "")
      .join("");

    return `<li><details open><summary>${content}</summary>${childContent}</details></li>`;
  }

  function markdownToHtml(markdown: string) {
    const blocks = parseBlocks(markdown);
    const html = blocks
      .map((block) => {
        switch (block.type) {
          case "list-break":
            return Array.from(
              { length: Math.max(1, block.count) },
              () => '<p data-list-break="true"><br></p>',
            ).join("");
          case "break":
            return "<br>".repeat(block.count);
          case "heading":
            return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
          case "blockquote":
            return `<blockquote>${renderInline(block.text)}</blockquote>`;
          case "comment":
            return `<p data-block-comment="true">${escapeHtml(block.text)}</p>`;
          case "ul":
          case "ol":
            return renderListBlock(block);
          case "hr":
            return "<hr>";
          case "code":
            return `<pre data-language="${escapeHtml(block.language)}"><code>${escapeHtml(block.text)}</code></pre>`;
          case "paragraph":
          default:
            return `<p>${renderInline(block.text)}</p>`;
        }
      })
      .join("");

    return html || "<p><br></p>";
  }

  function replaceTag(root: ParentNode, sourceTag: string, targetTag: string) {
    for (const node of root.querySelectorAll(sourceTag)) {
      const replacement = document.createElement(targetTag);
      for (const attribute of node.getAttributeNames()) {
        replacement.setAttribute(attribute, node.getAttribute(attribute) ?? "");
      }
      replacement.innerHTML = node.innerHTML;
      node.replaceWith(replacement);
    }
  }

  function unwrapTransparentSpans(root: ParentNode) {
    for (const span of Array.from(root.querySelectorAll("span"))) {
      if (!(span instanceof HTMLElement)) {
        continue;
      }

      if (span.dataset.summaryText === "true") {
        continue;
      }

      if (span.getAttributeNames().length > 0) {
        continue;
      }

      while (span.firstChild) {
        span.parentNode?.insertBefore(span.firstChild, span);
      }
      span.remove();
    }
  }

  function normalizeEditorMarkup(root: ParentNode = editor) {
    replaceTag(root, "b", "strong");
    replaceTag(root, "i", "em");
    replaceTag(root, "strike", "del");
    replaceTag(root, "s", "del");
    unwrapTransparentSpans(root);
    normalizeNestedListHierarchy(root);
    mergeAdjacentSiblingLists(root);
    (root as Node).normalize();
  }

  function createMarkupSignature(root: ParentNode) {
    return Array.from(root.childNodes)
      .map((node) => serializeMarkupNode(node))
      .filter(Boolean)
      .join("");
  }

  function serializeMarkupNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replaceAll("\u00a0", " ");
      return text ? `text(${JSON.stringify(text)})` : "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const attributes = [];

    if (element instanceof HTMLElement && isSingleBreakParagraph(element)) {
      return "<br>";
    }

    if (tag === "a") {
      const href = element.getAttribute("href");
      if (href) {
        attributes.push(`href=${JSON.stringify(href)}`);
      }
    }

    if (tag === "pre") {
      const language = element instanceof HTMLElement
        ? element.dataset.language ?? ""
        : element.getAttribute("data-language") ?? "";
      if (language) {
        attributes.push(`data-language=${JSON.stringify(language)}`);
      }
    }

    const children = Array.from(element.childNodes)
      .map((childNode) => serializeMarkupNode(childNode))
      .join("");
    const openingTag = attributes.length > 0
      ? `<${tag} ${attributes.join(" ")}>`
      : `<${tag}>`;

    if (tag === "br" || tag === "hr") {
      return openingTag;
    }

    return `${openingTag}${children}</${tag}>`;
  }

  function inspectSaveGuard() {
    const editorSnapshot = editor.cloneNode(true) as HTMLDivElement;
    const markdown = editorToMarkdown(editorSnapshot);
    const currentMarkup = createMarkupSignature(editorSnapshot);
    const roundTripRoot = document.createElement("div");
    roundTripRoot.innerHTML = markdownToHtml(markdown);
    normalizeEditorMarkup(roundTripRoot);

    const roundTripMarkup = createMarkupSignature(roundTripRoot);
    const issue = currentMarkup === roundTripMarkup
      ? null
      : { markdown, currentMarkup, roundTripMarkup } satisfies SaveGuardIssue;

    return { markdown, issue };
  }

  function refreshSaveGuardState() {
    if (!state.currentPath || state.mode !== "rich") {
      state.currentContent = "";
      state.saveIssue = null;
      state.lastLoggedSaveIssue = null;
      updateSaveButtonState();
      return { markdown: "", issue: null };
    }

    const inspection = inspectSaveGuard();
    state.saveIssue = inspection.issue;
    syncSaveIssueLogging(inspection.issue, "markup mismatch detected while editing");
    updateSaveButtonState();
    return inspection;
  }

  function inspectCurrentDraft() {
    if (!state.currentPath) {
      state.currentContent = "";
      state.dirty = false;
      state.expectedMtimeMs = null;
      state.saveIssue = null;
      state.lastLoggedSaveIssue = null;
      updateSaveButtonState();
      return { content: "", issue: null };
    }

    if (state.mode !== "rich") {
      state.saveIssue = null;
      state.lastLoggedSaveIssue = null;
      updateSaveButtonState();
      const content = editor.textContent ?? "";
      state.currentContent = content;
      state.dirty = content !== state.baselineContent;
      return { content, issue: null };
    }

    const inspection = refreshSaveGuardState();
    state.currentContent = inspection.markdown;
    state.dirty = inspection.markdown !== state.baselineContent;
    return {
      content: inspection.markdown,
      issue: inspection.issue,
    };
  }

  function createConsolePreview(value: string, maxLength = 320) {
    if (value.length <= maxLength) {
      return value || "(empty)";
    }

    const edgeLength = Math.max(40, Math.floor((maxLength - 5) / 2));
    return `${value.slice(0, edgeLength)}\n...\n${value.slice(-edgeLength)}`;
  }

  function logSaveGuardIssue(issue: SaveGuardIssue, trigger: string) {
    const difference = describeFirstDifference(issue.currentMarkup, issue.roundTripMarkup);
    const markdownPreview = createConsolePreview(issue.markdown);
    const report = [
      "[workbench] UNSAFE MARKDOWN SAVE BLOCKED",
      `file: ${state.currentPath}`,
      `trigger: ${trigger}`,
      "reason: serializing the current WYSIWYG editor content to markdown and rendering it again would change the editor markup.",
      `first differing character: ${difference.index}`,
      "",
      "current editor markup around the mismatch:",
      difference.currentExcerpt || "(empty)",
      "",
      "round-tripped markup around the mismatch:",
      difference.roundTripExcerpt || "(empty)",
      "",
      `markdown preview (${issue.markdown.length} chars, truncated if needed):`,
      markdownPreview,
      "",
      "Send this entire report back to Codex if you want help fixing the serializer.",
    ].join("\n");

    console.warn(report);
    console.warn("[workbench] Save blocked metadata", {
      filePath: state.currentPath,
      trigger,
      firstDifferenceIndex: difference.index,
      currentMarkupLength: issue.currentMarkup.length,
      currentMarkupExcerpt: difference.currentExcerpt || "(empty)",
      roundTripMarkupLength: issue.roundTripMarkup.length,
      roundTripMarkupExcerpt: difference.roundTripExcerpt || "(empty)",
      markdownLength: issue.markdown.length,
      markdownPreview,
    });
  }

  function syncSaveIssueLogging(issue: SaveGuardIssue | null, trigger: string, force = false) {
    if (!issue) {
      state.lastLoggedSaveIssue = null;
      return;
    }

    if (!force && isSameSaveGuardIssue(state.lastLoggedSaveIssue, issue)) {
      return;
    }

    logSaveGuardIssue(issue, trigger);
    state.lastLoggedSaveIssue = { ...issue };
  }

  function describeFirstDifference(currentMarkup: string, roundTripMarkup: string) {
    const limit = Math.min(currentMarkup.length, roundTripMarkup.length);
    let index = 0;

    while (index < limit && currentMarkup[index] === roundTripMarkup[index]) {
      index += 1;
    }

    if (index === limit && currentMarkup.length === roundTripMarkup.length) {
      index = -1;
    }

    const excerptStart = Math.max(0, (index === -1 ? limit : index) - 80);
    const excerptEnd = Math.min(
      Math.max(currentMarkup.length, roundTripMarkup.length),
      (index === -1 ? limit : index) + 120,
    );

    return {
      index,
      currentExcerpt: currentMarkup.slice(excerptStart, excerptEnd),
      roundTripExcerpt: roundTripMarkup.slice(excerptStart, excerptEnd),
    };
  }

  function escapeMarkdownText(value: string) {
    return value
      .replaceAll("\\", "\\\\")
      .replaceAll("*", "\\*")
      .replaceAll("_", "\\_")
      .replaceAll("`", "\\`")
      .replaceAll("[", "\\[")
      .replaceAll("]", "\\]");
  }

  function serializeInlineNodes(nodes: ArrayLike<Node>) {
    return Array.from(nodes).map((node) => serializeInlineNode(node)).join("");
  }

  function serializeInlineNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeMarkdownText(node.textContent ?? "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const inner = serializeInlineNodes(element.childNodes);

    switch (tag) {
      case "strong":
      case "b":
        return `**${inner}**`;
      case "em":
      case "i":
        return `*${inner}*`;
      case "code":
        return `\`${(element.textContent ?? "").replaceAll("`", "\\`")}\``;
      case "a": {
        const href = element.getAttribute("href") ?? "";
        return `[${inner || href}](${href})`;
      }
      case "del":
      case "s":
      case "strike":
        return `<del>${inner}</del>`;
      case "ins":
        return `<ins>${inner}</ins>`;
      case "br":
        return "\n";
      default:
        return inner;
    }
  }

  function serializeParagraph(node: Element) {
    return serializeInlineNodes(node.childNodes).replace(/\n{3,}/g, "\n\n");
  }

  function serializeListItemMainText(item: Element) {
    const details = getDirectChildDetailsElement(item);
    if (details) {
      const summary = getDirectChildSummaryElement(details);
      return summary ? serializeParagraph(summary).trim() : "";
    }

    const contentNodes = Array.from(item.childNodes).filter((node) => {
      return !(node instanceof Element && isListElement(node));
    });
    return serializeInlineNodes(contentNodes).replace(/\n{3,}/g, "\n\n").trimEnd().trim();
  }

  function getNestedListElementsForItem(item: Element) {
    const details = getDirectChildDetailsElement(item);
    return details
      ? getDirectChildListElements(details)
      : getDirectChildListElements(item);
  }

  function serializeListElement(node: Element, indent = 0) {
    const listType = node.tagName.toLowerCase();
    if (listType !== "ul" && listType !== "ol") {
      return "";
    }

    return Array.from(node.children)
      .filter((child): child is HTMLLIElement => child instanceof HTMLLIElement)
      .map((item, index) => {
        const prefix = listType === "ol" ? `${index + 1}. ` : "- ";
        const text = serializeListItemMainText(item);
        const line = text
          ? `${" ".repeat(indent)}${prefix}${text}`.trimEnd()
          : `${" ".repeat(indent)}${prefix}`;
        const nested = getNestedListElementsForItem(item)
          .map((childList) => serializeListElement(childList, indent + 2))
          .filter(Boolean)
          .join("\n");

        return nested ? `${line}\n${nested}` : line;
      })
      .join("\n");
  }

  function serializeBlockElement(node: Element): SerializedBlock {
    const tag = node.tagName.toLowerCase();
    const rawText = node.textContent ?? "";

    if (node instanceof HTMLElement && node.dataset.blockComment === "true" && isBlockCommentLine(rawText)) {
      return {
        isComment: true,
        text: rawText.trimEnd(),
      };
    }

    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return {
          isComment: false,
          text: `${"#".repeat(Number.parseInt(tag.slice(1), 10))} ${serializeParagraph(node).trim()}`.trimEnd(),
        };
      case "ul":
        return {
          isComment: false,
          text: serializeListElement(node),
        };
      case "ol":
        return {
          isComment: false,
          text: serializeListElement(node),
        };
      case "blockquote":
        return {
          isComment: false,
          text: serializeParagraph(node)
            .split("\n")
            .map((line) => `> ${line}`.trimEnd())
            .join("\n"),
        };
      case "pre": {
        const language = node instanceof HTMLElement ? node.dataset.language ?? "" : "";
        const code = node.textContent?.replace(/\n$/, "") ?? "";
        return {
          isComment: false,
          text: `\`\`\`${language}\n${code}\n\`\`\``,
        };
      }
      case "hr":
        return {
          isComment: false,
          text: "---",
        };
      case "div":
      case "p":
      default:
        return {
          isComment: false,
          text: serializeParagraph(node),
        };
    }
  }

  function serializeMarkdownTokens(tokens: SerializedMarkdownToken[]) {
    let markdown = "";
    let pendingBreakCount = 0;
    let previousBlock: SerializedBlock | null = null;

    for (const token of tokens) {
      if (token.type === "break") {
        pendingBreakCount += token.count;
        continue;
      }

      if (!token.block.text) {
        pendingBreakCount = 0;
        continue;
      }

      if (!previousBlock) {
        if (pendingBreakCount > 0 && token.block.isComment) {
          markdown += "\n".repeat(pendingBreakCount);
        }
        markdown += token.block.text;
      } else {
        const baseSeparator = previousBlock.isComment || token.block.isComment ? "\n" : "\n\n";
        const extraBreakCount = previousBlock.isComment || token.block.isComment
          ? pendingBreakCount
          : Math.max(0, pendingBreakCount - 1);
        markdown += `${baseSeparator}${"\n".repeat(extraBreakCount)}${token.block.text}`;
      }

      previousBlock = token.block;
      pendingBreakCount = 0;
    }

    if (pendingBreakCount > 0 && previousBlock?.isComment) {
      markdown += "\n".repeat(pendingBreakCount);
    }

    return `${markdown.trimEnd()}\n`;
  }

  function editorToMarkdown(sourceRoot: ParentNode = editor) {
    normalizeEditorMarkup(sourceRoot);
    const tokens: SerializedMarkdownToken[] = [];
    let inlineNodes: Node[] = [];
    let pendingBreakCount = 0;

    const flushPendingBreaks = () => {
      if (!pendingBreakCount) {
        return;
      }

      tokens.push({ type: "break", count: pendingBreakCount });
      pendingBreakCount = 0;
    };

    const flushInlineNodes = () => {
      if (!inlineNodes.length) {
        return;
      }

      const text = serializeInlineNodes(inlineNodes).replace(/\n{3,}/g, "\n\n").trimEnd();
      if (text) {
        flushPendingBreaks();
        tokens.push({
          type: "block",
          block: {
            isComment: isBlockCommentLine(text),
            text,
          },
        });
      }
      inlineNodes = [];
    };

    for (const node of sourceRoot.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent ?? "").trim()) {
          inlineNodes.push(node);
        }
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const element = node as Element;

      if (isIntentionalListBreakParagraph(element)) {
        flushInlineNodes();
        pendingBreakCount += 1;
        continue;
      }

      if (element.tagName === "BR") {
        flushInlineNodes();
        pendingBreakCount += 1;
        continue;
      }

      if (element instanceof HTMLElement && isSingleBreakParagraph(element)) {
        flushInlineNodes();
        pendingBreakCount += 1;
        continue;
      }

      if (blockTags.has(element.tagName)) {
        flushInlineNodes();
        flushPendingBreaks();
        const block = serializeBlockElement(element);
        if (block.text) {
          tokens.push({ type: "block", block });
        }
        continue;
      }

      inlineNodes.push(node);
    }

    flushInlineNodes();
    flushPendingBreaks();
    return serializeMarkdownTokens(tokens);
  }

  function setEditorContent(content: string, mode: EditorMode) {
    state.mode = mode;
    editor.dataset.placeholder = mode === "rich"
      ? "Select a markdown file to start editing."
      : "Plain text mode";

    if (mode === "rich") {
      editor.innerHTML = markdownToHtml(content);
    } else {
      editor.textContent = content;
    }

    applyEditorFontSize();
    syncStructuredBlockStyles();
    editor.scrollTop = 0;
    if (mode === "rich") {
      state.baselineContent = refreshSaveGuardState().markdown;
      state.currentContent = state.baselineContent;
    } else {
      state.baselineContent = content;
      state.currentContent = content;
      state.saveIssue = null;
      updateSaveButtonState();
    }
    state.dirty = false;
    updateStatusLine();
  }

  async function openFile(filePath: string, { ignoreDirty = false, source = "open" }: { ignoreDirty?: boolean; source?: "open" | "reload" } = {}) {
    if (source === "open" && filePath === state.currentPath) {
      return;
    }

    if (state.currentPath) {
      syncCurrentDraftBuffer();
    }

    if (source !== "reload") {
      const bufferedDraft = state.draftBuffers.get(filePath);
      if (bufferedDraft) {
        editor.setAttribute("contenteditable", isTextLikeFile(filePath) ? "true" : "false");
        restoreDraftBuffer(filePath, bufferedDraft);
        syncCurrentPathToUrl(filePath);
        updateStatusLine(`Opened draft ${filePath}`);
        expandPath(filePath);
        emitExplorerStateChange();
        return;
      }
    } else {
      state.draftBuffers.delete(filePath);
      void persistDraftBuffer(filePath, null);
    }

    const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, { cache: "no-store" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to open file." }));
      statusLine.textContent = error.error;
      return;
    }

    const payload = (await response.json()) as FilePayload;
    clearWriteConflict();
    state.currentPath = payload.path;
    state.expectedMtimeMs = payload.mtimeMs;
    filePathLabel.textContent = payload.path;
    const mode = isMarkdownFile(payload.path) ? "rich" : "plain";
    editor.setAttribute("contenteditable", isTextLikeFile(payload.path) ? "true" : "false");
    setEditorContent(payload.content, mode);
    syncCurrentPathToUrl(payload.path);
    updateStatusLine(`${source === "reload" ? "Reloaded" : "Opened"} ${payload.path} - ${formatTimestamp(payload.updatedAt)}`);
    expandPath(payload.path);
    emitExplorerStateChange();
  }

  function expandPath(filePath: string) {
    let didExpand = false;
    const segments = filePath.split("/");
    let current = "";

    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      if (!state.expandedDirectories.has(current)) {
        state.expandedDirectories.add(current);
        didExpand = true;
      }
    }

    if (didExpand) {
      persistExpandedDirectories();
    }
  }

  function updateStatusLine(message = "") {
    const change = describeChange(state.currentPath);

    if (message) {
      statusLine.textContent = message;
      return;
    }

    if (!state.currentPath) {
      statusLine.textContent = "Markdown files open as rich text. Save with Ctrl/Cmd+S.";
      return;
    }

    if (state.saveIssue) {
      statusLine.textContent = "Save blocked: markup mismatch. Check the console log.";
      return;
    }

    if (state.pendingWriteConflict) {
      statusLine.textContent = "File changed on disk. Reload or overwrite to save.";
      return;
    }

    if (state.dirty) {
      statusLine.textContent = "Unsaved changes.";
      return;
    }

    if (change) {
      statusLine.textContent = `Pending changes ${change}`;
      return;
    }

    statusLine.textContent = state.mode === "rich"
      ? "Saved."
      : "Plain text file.";
  }

  async function saveCurrentFile({ force = false }: { force?: boolean } = {}) {
    if (!state.currentPath) {
      return;
    }

    const inspection = inspectCurrentDraft();

    if (inspection.issue) {
      syncSaveIssueLogging(inspection.issue, "save attempt blocked by markup mismatch", true);
      updateStatusLine();
      return;
    }

    const content = inspection.content;
    const response = await fetch("/api/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: state.currentPath,
        content,
        expectedMtimeMs: state.expectedMtimeMs,
        force,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to save file." }));
      if (response.status === 409) {
        showWriteConflict(error as SaveConflictPayload);
        syncCurrentDraftBuffer();
        updateStatusLine();
        return;
      }
      statusLine.textContent = error.error;
      return;
    }

    const payload = (await response.json()) as SaveFilePayload;
    state.baselineContent = content;
    state.currentContent = content;
    state.dirty = false;
    state.expectedMtimeMs = payload.mtimeMs;
    state.changes = payload.changes;
    state.lastLoggedSaveIssue = null;
    clearWriteConflict();
    state.draftBuffers.delete(state.currentPath);
    void persistDraftBuffer(state.currentPath, null);
    state.saveIssue = null;
    updateSaveButtonState();
    updateStatusLine(`Saved ${state.currentPath} - ${formatTimestamp(payload.updatedAt)}`);
    emitExplorerStateChange();
  }

  function getClosestListItem(node: Node | null) {
    let current: Node | null = node;

    while (current) {
      if (current instanceof HTMLLIElement && editor.contains(current)) {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  function getSelectedListItems(selection: Selection) {
    if (!selection.rangeCount) {
      return [];
    }

    const range = selection.getRangeAt(0);
    if (selection.isCollapsed) {
      const listItem = getClosestListItem(range.startContainer);
      return listItem ? [listItem] : [];
    }

    const selectedItems = Array.from(editor.querySelectorAll("li")).filter((item) => range.intersectsNode(item));
    return selectedItems.filter((item) => {
      return !selectedItems.some((other) => other !== item && item.contains(other));
    });
  }

  function getListItemTextContainer(item: HTMLLIElement) {
    const details = getDirectChildDetailsElement(item);
    if (!details) {
      return item;
    }

    const summary = getDirectChildSummaryElement(details);
    if (!summary) {
      return details;
    }

    return getDirectChildSummaryTextElement(summary) ?? summary;
  }

  function getParentListElement(item: HTMLLIElement) {
    return item.parentElement instanceof HTMLUListElement || item.parentElement instanceof HTMLOListElement
      ? item.parentElement
      : null;
  }

  function getOrCreateDirectChildList(element: Element, listTagName: string) {
    const existingList = getDirectChildListElements(element).find((list) => list.tagName === listTagName);
    if (existingList) {
      return existingList;
    }

    const nextList = document.createElement(listTagName.toLowerCase());
    element.append(nextList);
    return nextList as HTMLUListElement | HTMLOListElement;
  }

  function getOrCreateNestedListForItem(item: HTMLLIElement, listTagName: string) {
    const details = getDirectChildDetailsElement(item);
    if (details) {
      return getOrCreateDirectChildList(details, listTagName);
    }

    return getOrCreateDirectChildList(item, listTagName);
  }

  function splitListItemRunsByParent(selectedItems: HTMLLIElement[]) {
    const runs: HTMLLIElement[][] = [];
    let currentRun: HTMLLIElement[] = [];

    for (const item of selectedItems) {
      const parentList = getParentListElement(item);
      if (!parentList) {
        if (currentRun.length) {
          runs.push(currentRun);
          currentRun = [];
        }
        continue;
      }

      const previousItem = currentRun[currentRun.length - 1];
      const previousParentList = previousItem ? getParentListElement(previousItem) : null;
      const isConsecutiveSibling = previousItem?.nextElementSibling === item;

      if (!currentRun.length || (previousParentList === parentList && isConsecutiveSibling)) {
        currentRun.push(item);
        continue;
      }

      runs.push(currentRun);
      currentRun = [item];
    }

    if (currentRun.length) {
      runs.push(currentRun);
    }

    return runs;
  }

  function restoreListItemSelection(items: HTMLLIElement[], { collapsed }: { collapsed: boolean }) {
    if (!items.length) {
      return;
    }

    const firstContainer = getListItemTextContainer(items[0]);
    const lastContainer = getListItemTextContainer(items[items.length - 1]);
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.setStart(firstContainer, 0);

    if (collapsed) {
      range.collapse(true);
    } else {
      range.setEnd(lastContainer, lastContainer.childNodes.length);
    }

    selection.removeAllRanges();
    selection.addRange(range);
  }

  function restoreParagraphSelection(paragraph: HTMLElement) {
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function outdentListItems(selectedItems: HTMLLIElement[]) {
    const movedItems: HTMLLIElement[] = [];

    for (const run of splitListItemRunsByParent(selectedItems)) {
      const firstItem = run[0];
      const lastItem = run[run.length - 1];
      const parentList = getParentListElement(firstItem);
      if (!parentList) {
        continue;
      }

      const parentItem = parentList.closest<HTMLLIElement>("li");
      if (!parentItem || !editor.contains(parentItem)) {
        continue;
      }

      const ancestorList = getParentListElement(parentItem);
      if (!ancestorList) {
        continue;
      }

      const insertionPoint = parentItem.nextSibling;
      const trailingSiblings: HTMLLIElement[] = [];
      let trailingNode = lastItem.nextElementSibling;

      while (trailingNode) {
        const nextTrailingNode = trailingNode.nextElementSibling;
        if (trailingNode instanceof HTMLLIElement) {
          trailingSiblings.push(trailingNode);
        }
        trailingNode = nextTrailingNode;
      }

      for (const item of run) {
        ancestorList.insertBefore(item, insertionPoint);
        movedItems.push(item);
      }

      if (trailingSiblings.length) {
        const nestedList = getOrCreateNestedListForItem(lastItem, parentList.tagName);
        for (const trailingItem of trailingSiblings) {
          nestedList.append(trailingItem);
        }
      }

      if (!parentList.children.length) {
        parentList.remove();
      }
    }

    return movedItems;
  }

  function indentListItems(selectedItems: HTMLLIElement[]) {
    const movedItems: HTMLLIElement[] = [];

    for (const run of splitListItemRunsByParent(selectedItems)) {
      const firstItem = run[0];
      const parentList = getParentListElement(firstItem);
      if (!parentList) {
        continue;
      }

      const previousSibling = firstItem.previousElementSibling instanceof HTMLLIElement
        ? firstItem.previousElementSibling
        : null;
      if (!previousSibling) {
        continue;
      }

      const nestedList = getOrCreateNestedListForItem(previousSibling, parentList.tagName);
      for (const item of run) {
        nestedList.append(item);
        movedItems.push(item);
      }

      if (!parentList.children.length) {
        parentList.remove();
      }
    }

    return movedItems;
  }

  function isSelectionAtListItemStart(selection: Selection, item: HTMLLIElement) {
    if (!selection.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const container = getListItemTextContainer(item);
    if (!container.contains(range.startContainer)) {
      return false;
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(container);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    return beforeRange.toString().replaceAll("\u00a0", " ").trim() === "";
  }

  function isTopLevelListItem(item: HTMLLIElement) {
    const parentList = getParentListElement(item);
    return Boolean(parentList && (!parentList.closest("li") || !editor.contains(parentList.closest("li"))));
  }

  function breakOutOfListItem(listItem: HTMLLIElement) {
    if (isTopLevelListItem(listItem)) {
      const paragraph = unwrapTopLevelListItemToParagraph(listItem);
      editor.focus();
      if (paragraph) {
        syncEditorAfterStructuralChange();
        restoreParagraphSelection(paragraph);
        updateFloatingToolbar();
      }
      return true;
    }

    document.execCommand("outdent", false);
    editor.focus();
    syncEditorAfterStructuralChange();
    return true;
  }

  function syncEditorAfterStructuralChange() {
    syncStructuredBlockStyles();
    inspectCurrentDraft();
    syncCurrentDraftBuffer();
    updateStatusLine();
    updateFloatingToolbar();
  }

  function handleListTab(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    const selectedItems = getSelectedListItems(selection);
    if (!selectedItems.length) {
      return false;
    }

    if (selection.isCollapsed && !isSelectionAtListItemStart(selection, selectedItems[0])) {
      return false;
    }

    const shouldCollapseSelection = selection.isCollapsed;
    event.preventDefault();

    if (event.shiftKey) {
      const movedItems = outdentListItems(selectedItems);
      editor.focus();
      if (movedItems.length) {
        syncEditorAfterStructuralChange();
        restoreListItemSelection(movedItems, { collapsed: shouldCollapseSelection });
        updateFloatingToolbar();
      }
      return true;
    }

    const movedItems = indentListItems(selectedItems);
    editor.focus();
    if (movedItems.length) {
      syncEditorAfterStructuralChange();
      restoreListItemSelection(movedItems, { collapsed: shouldCollapseSelection });
      updateFloatingToolbar();
    }
    return true;
  }

  function handleListItemBackspace(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const listItem = getClosestListItem(selection.getRangeAt(0).startContainer);
    if (!listItem || !isSelectionAtListItemStart(selection, listItem)) {
      return false;
    }

    event.preventDefault();
    return breakOutOfListItem(listItem);
  }

  function handleEmptyListItemEnter(event: KeyboardEvent) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return false;
    }

    const listItem = getClosestListItem(selection.getRangeAt(0).startContainer);
    if (!listItem || serializeListItemMainText(listItem) !== "") {
      return false;
    }

    event.preventDefault();
    return breakOutOfListItem(listItem);
  }

  function runEditorCommand(command: string, value: string | null = null) {
    if (state.mode !== "rich") {
      return;
    }

    document.execCommand(command, false, value);
    editor.focus();
    syncEditorAfterStructuralChange();
  }

  function unwrapCodeElements(root: DocumentFragment | Element) {
    const codeElements = Array.from(root.querySelectorAll("code"));

    for (const codeElement of codeElements) {
      const parent = codeElement.parentNode;
      if (!parent) {
        continue;
      }

      while (codeElement.firstChild) {
        parent.insertBefore(codeElement.firstChild, codeElement);
      }
      codeElement.remove();
    }
  }

  function removeEmptyCodeElements(root: ParentNode = editor) {
    if (!("querySelectorAll" in root)) {
      return;
    }

    for (const codeElement of Array.from(root.querySelectorAll("code"))) {
      if (!(codeElement instanceof HTMLElement)) {
        continue;
      }

      if ((codeElement.textContent ?? "").replaceAll("\u00a0", "").length > 0) {
        continue;
      }

      codeElement.remove();
    }
  }

  function getClosestCodeElement(node: Node | null) {
    let current: Node | null = node;

    while (current && current !== editor) {
      if (current instanceof HTMLElement && current.tagName === "CODE") {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  function createCodeElementFromFragment(source: HTMLElement, fragment: DocumentFragment) {
    if (!fragment.childNodes.length) {
      return null;
    }

    const codeElement = source.cloneNode(false) as HTMLElement;
    codeElement.append(fragment);
    return codeElement;
  }

  function unwrapSelectionFromSingleCodeElement(selection: Selection, range: Range, codeElement: HTMLElement) {
    const beforeRange = document.createRange();
    beforeRange.setStart(codeElement, 0);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeFragment = beforeRange.cloneContents();

    const selectedFragment = range.cloneContents();
    unwrapCodeElements(selectedFragment);

    const afterRange = document.createRange();
    afterRange.setStart(range.endContainer, range.endOffset);
    afterRange.setEnd(codeElement, codeElement.childNodes.length);
    const afterFragment = afterRange.cloneContents();

    const replacement = document.createDocumentFragment();
    const insertedNodes: Node[] = [];
    const leadingCode = createCodeElementFromFragment(codeElement, beforeFragment);
    if (leadingCode) {
      replacement.append(leadingCode);
    }

    for (const node of Array.from(selectedFragment.childNodes)) {
      insertedNodes.push(node);
      replacement.append(node);
    }

    const trailingCode = createCodeElementFromFragment(codeElement, afterFragment);
    if (trailingCode) {
      replacement.append(trailingCode);
    }

    const fallbackRange = document.createRange();
    fallbackRange.setStartBefore(codeElement);
    fallbackRange.collapse(true);
    codeElement.replaceWith(replacement);
    removeEmptyCodeElements();
    selectInsertedNodes(selection, insertedNodes, fallbackRange);
    syncEditorAfterStructuralChange();
  }

  function fragmentContainsOnlyCodeText(fragment: DocumentFragment) {
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();

    while (currentNode) {
      const textNode = currentNode as Text;
      if ((textNode.textContent ?? "").length > 0) {
        textNodes.push(textNode);
      }
      currentNode = walker.nextNode();
    }

    if (!textNodes.length) {
      return false;
    }

    return textNodes.every((textNode) => {
      let current: Node | null = textNode.parentNode;

      while (current && current !== fragment) {
        if (current instanceof HTMLElement && current.tagName === "CODE") {
          return true;
        }
        current = current.parentNode;
      }

      return false;
    });
  }

  function selectInsertedNodes(selection: Selection, insertedNodes: Node[], fallbackRange: Range) {
    selection.removeAllRanges();

    if (!insertedNodes.length) {
      selection.addRange(fallbackRange);
      return;
    }

    const nextRange = document.createRange();
    const firstNode = insertedNodes[0];
    const lastNode = insertedNodes[insertedNodes.length - 1];

    if (insertedNodes.length === 1) {
      nextRange.selectNodeContents(firstNode);
    } else {
      nextRange.setStartBefore(firstNode);
      nextRange.setEndAfter(lastNode);
    }

    selection.addRange(nextRange);
  }

  function toggleCodeSelection(selection: Selection, range: Range) {
    const startCode = getClosestCodeElement(range.startContainer);
    const endCode = getClosestCodeElement(range.endContainer);
    if (startCode && startCode === endCode) {
      unwrapSelectionFromSingleCodeElement(selection, range, startCode);
      return;
    }

    const fragment = range.cloneContents();
    const shouldUnwrap = fragmentContainsOnlyCodeText(fragment);
    const extractedFragment = range.extractContents();

    if (shouldUnwrap) {
      unwrapCodeElements(extractedFragment);
      const insertedNodes = Array.from(extractedFragment.childNodes);
      const fallbackRange = document.createRange();
      fallbackRange.setStart(range.startContainer, range.startOffset);
      fallbackRange.collapse(true);
      range.insertNode(extractedFragment);
      removeEmptyCodeElements();
      selectInsertedNodes(selection, insertedNodes, fallbackRange);
      syncEditorAfterStructuralChange();
      return;
    }

    unwrapCodeElements(extractedFragment);
    const wrapper = document.createElement("code");
    wrapper.append(extractedFragment);
    range.insertNode(wrapper);
    removeEmptyCodeElements();
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    selection.addRange(nextRange);
    syncEditorAfterStructuralChange();
  }

  function wrapSelection(tagName: keyof HTMLElementTagNameMap) {
    if (state.mode !== "rich") {
      return;
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      return;
    }

    if (tagName === "code") {
      toggleCodeSelection(selection, range);
      return;
    }

    const wrapper = document.createElement(tagName);
    wrapper.append(range.extractContents());
    range.insertNode(wrapper);
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    selection.addRange(nextRange);
    syncEditorAfterStructuralChange();
  }

  function applyToolbarCommand(command: string) {
    switch (command) {
      case "bold":
        runEditorCommand("bold");
        break;
      case "italic":
        runEditorCommand("italic");
        break;
      case "inline-code":
        wrapSelection("code");
        break;
      case "del":
        wrapSelection("del");
        break;
      case "ins":
        wrapSelection("ins");
        break;
      case "h1":
        runEditorCommand("formatBlock", "<h1>");
        break;
      case "h2":
        runEditorCommand("formatBlock", "<h2>");
        break;
      case "unordered-list":
        runEditorCommand("insertUnorderedList");
        break;
      case "ordered-list":
        runEditorCommand("insertOrderedList");
        break;
      case "quote":
        runEditorCommand("formatBlock", "<blockquote>");
        break;
      default:
        break;
    }
  }

  function updateFloatingToolbar() {
    const selection = window.getSelection();
    if (
      !selection?.rangeCount ||
      selection.isCollapsed ||
      state.mode !== "rich" ||
      !editor.contains(selection.anchorNode) ||
      !editor.contains(selection.focusNode)
    ) {
      floatingToolbar.hidden = true;
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      floatingToolbar.hidden = true;
      return;
    }

    floatingToolbar.hidden = false;

    const x = Math.min(
      window.innerWidth - floatingToolbar.offsetWidth - 12,
      Math.max(12, rect.left + rect.width / 2 - floatingToolbar.offsetWidth / 2),
    );
    const y = Math.max(12, rect.top - floatingToolbar.offsetHeight - 10);

    floatingToolbar.style.left = `${x}px`;
    floatingToolbar.style.top = `${y}px`;
  }

  async function refreshTree({ preserveSelection = false }: { preserveSelection?: boolean } = {}) {
    const response = await fetch("/api/tree", { cache: "no-store" });
    const payload = (await response.json()) as ProjectSnapshot;
    state.root = payload.root;
    state.tree = payload.tree;
    state.changes = payload.changes;
    emitExplorerStateChange();

    if (preserveSelection && state.currentPath) {
      return;
    }

    const requestedPath = getRequestedPathFromUrl();
    const preferredFile = requestedPath && treeContainsFilePath(state.tree, requestedPath)
      ? requestedPath
      : "";
    const firstMarkdownFile = getFirstFile(state.tree, (filePath) => isMarkdownFile(filePath));
    const fallbackFile = preferredFile || firstMarkdownFile || getFirstFile(state.tree);

    if (fallbackFile) {
      await openFile(fallbackFile);
      return;
    }

    state.baselineContent = "";
    state.currentPath = "";
    state.currentContent = "";
    state.dirty = false;
    state.expectedMtimeMs = null;
    state.pendingWriteConflict = null;
    state.saveIssue = null;
    state.lastLoggedSaveIssue = null;
    editor.textContent = "";
    filePathLabel.textContent = "Select a file";
    updateSaveButtonState();
    updateStatusLine();
    syncCurrentPathToUrl("");
  }

  function scheduleAutoRefresh() {
    if (autoRefreshStopped) {
      return;
    }

    autoRefreshTimeoutId = window.setTimeout(() => {
      void runAutoRefresh();
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  async function runAutoRefresh() {
    if (autoRefreshStopped) {
      return;
    }

    try {
      await refreshTree({ preserveSelection: true });
    } catch {
      // Keep polling even if a transient refresh request fails.
    } finally {
      scheduleAutoRefresh();
    }
  }

  const controls: WorkbenchControls = {
    openFile,
    toggleDirectory,
  };

  hydrateDraftBuffers(await getPersistedDraftRecords());
  bindings.onControlsReady?.(controls);
  emitExplorerStateChange();
  applyEditorFontSize();
  updateSaveButtonState();
  await refreshTree();
  scheduleAutoRefresh();
  return () => {
    autoRefreshStopped = true;
    if (autoRefreshTimeoutId !== null) {
      window.clearTimeout(autoRefreshTimeoutId);
    }
    abortController.abort();
  };
}
