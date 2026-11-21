import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { ThreadService } from "../src/thread-service.mjs";
import { EventHub } from "../src/event-hub.mjs";
import { activityTime, eventThreadId, eventTurnId, statusType, threadObject, titleOf } from "../public/modules/formatters.js";
import * as summaries from "../public/modules/thread-summaries.js";
import { state as initialState } from "../public/modules/state.js";
import { t } from "../public/modules/i18n.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const at = 1_790_000_000_000;
function fixture() {
  const state = structuredClone(initialState);
  state.threads = [
    { id: "newer", name: "Newer", updatedAt: at / 1000, status: { type: "idle" } },
    { id: "older", name: null, preview: "", updatedAt: at / 1000 - 20, status: { type: "idle" } },
  ];
  state.selected = state.threads[1];
  return state;
}

test("accepted activity moves recent conversations up while desktop pins retain their order", () => {
  const state = fixture();
  summaries.noteThreadActivity(state, "older", { text: "First\n question", at: at + 1_000 });
  assert.deepEqual(summaries.orderedThreads(state.threads, []).map((thread) => thread.id), ["older", "newer"]);
  assert.deepEqual(summaries.orderedThreads(state.threads, ["newer", "older"]).map((thread) => thread.id), ["newer", "older"]);
  assert.equal(titleOf(state.selected), "First question");
  summaries.mergeThreadSummary(state, { id: "older", name: "Named on desktop" });
  summaries.noteThreadActivity(state, "older", { text: "Another question", at: at + 2_000 });
  assert.equal(titleOf(state.selected), "Named on desktop");
  assert.equal(titleOf({ name: " ", title: "", preview: "Preview" }), "Preview");
  assert.equal(activityTime({ recencyAt: at / 1000 + 1, updatedAt: at / 1000 }), at + 1_000);
});

test("status and title updates reach non-selected summaries, and selected/header data stay consistent", () => {
  const state = fixture();
  const event = (method, params) => summaries.applyThreadSummaryEvent(state, { method, params, at: new Date(at).toISOString() });
  event("turn/started", { threadId: "newer", turn: { id: "turn-A" } });
  assert.equal(state.activeTurns.newer, "turn-A");
  assert.equal(statusType(state.threads[0]), "active");
  event("turn/completed", { threadId: "newer", turn: { id: "turn-A", status: "completed" } });
  assert.equal(state.activeTurns.newer, undefined);
  assert.equal(statusType(state.threads[0]), "idle");
  event("thread/status/changed", { threadId: "older", status: { type: "active" } });
  event("thread/name/updated", { threadId: "older", threadName: "Generated title" });
  assert.equal(state.selected, state.threads[1]);
  assert.equal(titleOf(state.selected), "Generated title");
  event("thread/status/changed", { threadId: "older", status: { type: "notLoaded" } });
  assert.equal(statusType(state.selected), "notLoaded");
  assert.equal(state.activeTurns.older, undefined);
});

test("older metadata and health reads cannot resurrect completed turns or overwrite new names", () => {
  const state = fixture();
  summaries.startThreadTurn(state, "older", "turn-A", at);
  const since = summaries.summaryVersion(state);
  summaries.completeThreadTurn(state, "older", "turn-A", at + 1);
  summaries.patchThreadSummary(state, "older", { name: "New title" });
  summaries.mergeThreadSummary(state, { id: "older", name: "Stale title", status: { type: "active" } }, since);
  summaries.reconcileActiveTurns(state, { older: "turn-A" }, since);
  assert.equal(titleOf(state.selected), "New title");
  assert.equal(statusType(state.selected), "idle");
  assert.equal(state.activeTurns.older, undefined);
  assert.equal(summaries.startThreadTurn(state, "older", "turn-A"), false);
  summaries.startThreadTurn(state, "older", "turn-B");
  assert.equal(summaries.completeThreadTurn(state, "older", "turn-A"), false);
  assert.equal(state.activeTurns.older, "turn-B");
  summaries.reconcileActiveTurns(state, {});
  assert.equal(statusType(state.selected), "idle");
});

function browser(state = fixture(), additions = {}) {
  const label = { textContent: "" };
  const context = vm.createContext({
    ...summaries, state, statusType, titleOf, threadObject, eventThreadId, eventTurnId, t,
    Date, URLSearchParams, archivingThreadId: null,
    elements: { chatTitle: { textContent: "" }, turnState: { className: "", querySelector: () => label } },
    renderThreads() {}, updateComposer() {}, renderMessages() {}, scheduleThreadSummarySync() {},
    showBanner(message) { throw new Error(message); }, errorInfo: (error) => ({ message: error.message }),
    setTimeout() {}, ...additions,
  });
  for (const [start, end] of [
    ["function isThreadActive(", "function setConnection("],
    ["function syncSelectedActivity(", "function queueEntry("],
    ["function updateTurnState(", "function showBanner("],
    ["function handleEvent(", "function renderRequests("],
  ]) vm.runInContext(app.slice(app.indexOf(start), app.indexOf(end)), context);
  return { context, state, label };
}

test("actual event handler clears background green dots before filtering the selected chat", () => {
  const { context, state } = browser();
  context.handleEvent({ method: "turn/started", params: { threadId: "newer", turn: { id: "A" } } });
  assert.equal(context.isThreadActive(state.threads[0]), true);
  context.handleEvent({ method: "turn/completed", params: { threadId: "newer", turn: { id: "A", status: "completed" } } });
  assert.equal(context.isThreadActive(state.threads[0]), false);
  assert.equal(state.activeTurns.newer, undefined);
  context.handleEvent({ method: "thread/name/updated", params: { threadId: "older", name: "Fresh name" } });
  assert.equal(context.elements.chatTitle.textContent, "Fresh name");
  assert.equal(titleOf(state.threads[1]), "Fresh name");
});

test("unknown activity does not assert external ownership, and completion stays idle after reconciliation", () => {
  const { context, state, label } = browser();
  context.handleEvent({ method: "thread/status/changed", params: { threadId: "older", status: { type: "active" } } });
  assert.equal(label.textContent, t("turn.syncing"));
  state.externalWriter = true;
  context.updateTurnState();
  assert.equal(label.textContent, t("turn.heldElsewhere"));
  state.externalWriter = false;
  context.handleEvent({ method: "turn/completed", params: { threadId: "older", turn: { id: "A" } } });
  context.syncSelectedActivity();
  assert.equal(label.textContent, t("turn.idle"));
  assert.equal(state.busy, false);
  assert.equal(context.isThreadActive(state.selected), false);
});

test("a fast completed send updates the title and order without restoring a running dot", async () => {
  const state = fixture();
  state.selected.localDraft = true;
  const input = { value: "First message", focus() {} };
  let context;
  ({ context } = browser(state, {
    localStorage: { removeItem() {}, setItem() {} }, resizeComposer() {},
    draftKey: (id) => id, selectedModelSettings: () => ({}),
    api: async () => {
      context.handleEvent({ method: "turn/started", params: { threadId: "older", turn: { id: "fast" } } });
      context.handleEvent({ method: "turn/completed", params: { threadId: "older", turn: { id: "fast", status: "completed" } } });
      return { mode: "start", turn: { id: "fast", status: "inProgress" } };
    },
  }));
  context.elements.messageInput = input;
  vm.runInContext(app.slice(app.indexOf("async function sendMessage("), app.indexOf("async function cancelQueuedMessage(")), context);
  await context.sendMessage({ preventDefault() {} });
  assert.equal(titleOf(state.selected), "First message");
  assert.equal(context.elements.chatTitle.textContent, "First message");
  assert.equal(state.selected.localDraft, false);
  assert.equal(context.isThreadActive(state.selected), false);
  assert.equal(state.busy, false);
  assert.equal(summaries.orderedThreads(state.threads, [])[0].id, "older");
});

test("syncing selected history also refreshes sidebar and header metadata without a page reload", async () => {
  const { context, state } = browser(undefined, {
    TURN_PAGE_SIZE: 10, isNearBottom: () => true,
    mergeTurnDelta() {}, setSelectedQueue() {},
    api: async (path) => path.endsWith("/older")
      ? { thread: { id: "older", name: "Read title", status: { type: "idle" } } } : { data: [] },
  });
  context.elements.messages = { scrollHeight: 100, scrollTop: 0 };
  vm.runInContext(app.slice(app.indexOf("async function syncSelectedThread("), app.indexOf("function draftKey(")), context);
  await context.syncSelectedThread();
  assert.equal(context.elements.chatTitle.textContent, "Read title");
  assert.equal(titleOf(state.threads[1]), "Read title");
});

test("foreground polling skips hidden, disconnected, busy and already-loading pages", () => {
  const calls = [];
  const context = vm.createContext({
    document: { hidden: false }, state: { ready: true, connection: "online" },
    elements: { threadSearch: { value: "" } },
    loadThreads: (options) => calls.push(options), scheduleThreadSummarySync() {},
  });
  vm.runInContext(app.slice(app.indexOf("function pollThreadSummaries("), app.indexOf("const { emptyState")), context);
  context.pollThreadSummaries();
  context.document.hidden = true;
  context.pollThreadSummaries();
  context.document.hidden = false;
  context.elements.threadSearch.value = "search in progress";
  context.pollThreadSummaries();
  context.elements.threadSearch.value = "";
  for (const changes of [{ connection: "offline" }, { connection: "degraded" }, { connection: "online", threadsLoading: true }, { threadsLoading: false, submitting: true }]) {
    Object.assign(context.state, changes);
    context.pollThreadSummaries();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].preserveLoaded, true);
  assert.equal(calls[0].refresh, true);
});

test("backend late start acknowledgements and completed older turns cannot corrupt active-turn tracking", async () => {
  const client = new EventEmitter();
  client.ready = true;
  const drafts = new Set();
  client.request = async (method) => {
    if (method === "thread/start") return { thread: { id: "draft" } };
    if (method === "thread/unsubscribe") return { status: "notLoaded" };
    assert.equal(method, "turn/start");
    client.emit("notification", { method: "turn/started", params: { threadId: "draft", turn: { id: "fast" } } });
    client.emit("notification", { method: "turn/completed", params: { threadId: "draft", turn: { id: "fast", status: "completed" } } });
    return { turn: { id: "fast", status: "inProgress" } };
  };
  const service = new ThreadService({ client, eventHub: new EventHub(), stateStore: {
    addDraft: (id) => drafts.add(id), hasDraft: (id) => drafts.has(id), removeDraft: (id) => drafts.delete(id), peekQueuedMessage: () => null,
  } });
  await service.createThread({ cwd: tmpdir() });
  await service.send("draft", { text: "First message" });
  assert.equal(service.activeTurns.has("draft"), false);
  client.emit("notification", { method: "turn/started", params: { threadId: "draft", turn: { id: "new" } } });
  client.emit("notification", { method: "turn/completed", params: { threadId: "draft", turn: { id: "fast" } } });
  assert.equal(service.activeTurns.get("draft"), "new");
  await new Promise((resolve) => setImmediate(resolve));
});
