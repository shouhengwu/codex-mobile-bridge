import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { ThreadService } from "../src/thread-service.mjs";
import { EventHub } from "../src/event-hub.mjs";
import { BridgeStateStore } from "../src/state-store.mjs";
import * as summaries from "../public/modules/thread-summaries.js";
import * as formatters from "../public/modules/formatters.js";
import { state as initialState } from "../public/modules/state.js";
import { t } from "../public/modules/i18n.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const read = { revision: "r1", firstUnread: null };
const unread = { revision: "r2", firstUnread: { type: "threadStart" } };

function browser(api) {
  const state = structuredClone(initialState);
  state.threads = [{ id: "thread", name: "Fixture", readState: read }];
  state.selected = state.threads[0];
  const errors = [], toasts = [];
  const context = vm.createContext({
    state, ...summaries, ...formatters, api, t,
    elements: { drawerMarkUnreadButton: { disabled: false } },
    updateArchiveActions() {}, renderThreads() {}, scheduleThreadSummarySync() {}, closeActionDrawer() {},
    toast: (message) => toasts.push(message), showBanner: (message) => errors.push(message),
    errorInfo: (error) => ({ message: error.message }),
  });
  vm.runInContext(app.slice(app.indexOf("async function updateThreadReadState("), app.indexOf("function resizeComposer(")), context);
  return { context, state, errors, toasts };
}

test("Mark as unread uses the observed native revision and does not change activity or pin order", async () => {
  const calls = [];
  const { context, state, toasts } = browser(async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body), method: options.method });
    return { readState: unread };
  });
  context.markSelectedUnread();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ path: "/api/threads/thread/read-state", method: "PATCH", body: { read: false, expectedRevision: "r1" } }]);
  assert.equal(summaries.isThreadUnread(state.selected), true);
  assert.equal(state.threads[0], state.selected);
  assert.equal(state.selected.localActivityAt, undefined);
  assert.equal(state.readStatePending.size, 0);
  assert.deepEqual(toasts, [t("toast.markedUnread")]);
});

test("failed marks keep the previous state and are never retried automatically", async () => {
  let calls = 0;
  const { context, state, errors } = browser(async () => { calls++; throw new Error("revision conflict"); });
  await context.updateThreadReadState("thread", false, read, { manual: true });
  assert.equal(calls, 1);
  assert.equal(summaries.isThreadUnread(state.selected), false);
  assert.equal(state.readStatePending.size, 0);
  assert.deepEqual(errors, ["revision conflict"]);
});

test("an older mutation response cannot overwrite a newer desktop receipt notification", async () => {
  const { context, state } = browser(async () => {
    summaries.applyThreadSummaryEvent(state, { method: "thread/readState/changed", params: { threadId: "thread", readState: { revision: "r3", firstUnread: null } } });
    return { readState: unread };
  });
  await context.updateThreadReadState("thread", false, read);
  assert.equal(state.selected.readState.revision, "r3");
  assert.equal(summaries.isThreadUnread(state.selected), false);
});

test("explicit reopening acknowledges unread once, while silent refresh preserves the mark", async () => {
  const acknowledgements = [];
  let fetchedReceipt;
  const { context, state } = browser(async (path) => path.endsWith("/thread")
    ? { thread: { id: "thread", name: "Fixture", ...(fetchedReceipt ? { readState: fetchedReceipt } : {}) } } : { data: [] });
  state.selected.readState = unread;
  Object.assign(context, {
    URLSearchParams, TURN_PAGE_SIZE: 10, document: { hidden: false },
    localStorage: { getItem() {} }, draftKey: (id) => id,
    renderModelControls() {}, syncSelectedActivity() {}, renderRequests() {}, closeDrawer() {}, resizeComposer() {},
    updateComposer() {}, renderMessages() {}, hideBanner() {}, setSelectedQueue() {},
    emptyState: () => ({}),
    updateThreadReadState: async (...args) => acknowledgements.push(args),
  });
  Object.assign(context.elements, { chatTitle: {}, chatMeta: {}, messageInput: {}, messages: { replaceChildren() {} } });
  vm.runInContext(app.slice(app.indexOf("async function selectThread("), app.indexOf("async function loadOlderTurns(")), context);
  await context.selectThread(state.selected, { silent: true });
  assert.equal(acknowledgements.length, 0);
  await context.selectThread(state.selected, { silent: false });
  assert.equal(acknowledgements.length, 1);
  assert.deepEqual(acknowledgements[0], ["thread", true, unread]);
  fetchedReceipt = { ...unread, revision: "newer-transcript" };
  await context.selectThread(state.selected);
  assert.deepEqual(acknowledgements[1], ["thread", true, fetchedReceipt], "acknowledge the loaded transcript rather than the older sidebar receipt");
});

test("native receipt mutation validates inputs, forwards exact operations and normalizes metadata", async () => {
  const client = new EventEmitter();
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: "thread" }, readState: unread };
    return { readState: params.operation.type === "read" ? read : unread };
  };
  const service = new ThreadService({ client, eventHub: new EventHub(), stateStore: {} });
  assert.equal((await service.getThread("thread")).thread.readState, unread);
  await service.updateReadState("thread", { read: false, expectedRevision: "r1" });
  assert.deepEqual(calls.at(-1), { method: "thread/readState/update", params: { threadId: "thread", operation: { type: "unread" }, expectedRevision: "r1" } });
  await assert.rejects(service.updateReadState("thread", { read: "false", expectedRevision: "r1" }), { code: "invalid_read_state" });
  await assert.rejects(service.updateReadState("thread", { read: false }), { code: "invalid_read_state" });
  client.request = async () => { throw Object.assign(new Error("Unsupported method"), { code: -32601 }); };
  await assert.rejects(service.updateReadState("thread", { read: false, expectedRevision: "r1" }), { code: "read_state_unavailable" });
});

function completionFixture(initialReceipt = read) {
  const client = new EventEmitter();
  const eventHub = new EventHub();
  const calls = [];
  let current = initialReceipt;
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: "thread" }, readState: current };
    if (method === "thread/unsubscribe") return { status: "notLoaded" };
    if (method === "thread/list") return { data: [{ id: "thread" }], readStates: { thread: current } };
    assert.equal(method, "thread/readState/update");
    assert.equal(params.expectedRevision, current.revision);
    current = params.operation.type === "unread" ? unread : { ...read, revision: "r3" };
    client.emit("notification", { method: "thread/readState/changed", params: { threadId: "thread", readState: current } });
    return { readState: current };
  };
  const service = new ThreadService({ client, eventHub, stateStore: { peekQueuedMessage: () => null } });
  const notify = (method, turnId = "turn") => client.emit("notification", { method, params: { threadId: "thread", turn: { id: turnId, status: "completed" } } });
  return { client, service, calls, eventHub, notify };
}

test("completion creates a native unread receipt even without a connected browser and survives list refresh", async () => {
  const { service, calls, eventHub, notify } = completionFixture();
  notify("turn/started");
  notify("turn/completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.find((call) => call.method === "thread/readState/update")?.params, {
    threadId: "thread", expectedRevision: "r1", operation: { type: "unread" },
  });
  assert.equal(summaries.isThreadUnread((await service.listThreads({ refresh: true })).data[0]), true);
  assert.ok(eventHub.history.some((event) => event.method === "thread/readState/changed" && event.params.readState.firstUnread));
  await service.updateReadState("thread", { read: true, expectedRevision: "r2" });
  notify("turn/completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(summaries.isThreadUnread((await service.listThreads({ refresh: true })).data[0]), false, "replayed completion must not undo acknowledgement");
});

test("completion preserves existing native unread positions and ignores stale turns", async () => {
  const nativeUnread = { revision: "native", firstUnread: { type: "turn", turnId: "earlier" } };
  const { service, calls, notify } = completionFixture(nativeUnread);
  notify("turn/started");
  notify("turn/completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some((call) => call.method === "thread/readState/update"), false);
  assert.equal((await service.getThread("thread")).thread.readState, nativeUnread);
  notify("turn/started", "new");
  const reads = calls.length;
  notify("turn/completed", "older");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, reads);
});

test("a newer receipt or turn while the completion receipt is loading cancels the automatic mark", async () => {
  for (const change of ["receipt", "turn"]) {
    const { client, calls, notify } = completionFixture();
    const request = client.request;
    let finish;
    client.request = (method, params) => method === "thread/read"
      ? new Promise((resolve) => { finish = resolve; }) : request(method, params);
    notify("turn/completed");
    if (change === "receipt") client.emit("notification", { method: "thread/readState/changed", params: { threadId: "thread", readState: { ...read, revision: "newer" } } });
    else notify("turn/started", "new");
    assert.equal(typeof finish, "function");
    finish({ thread: { id: "thread" }, readState: read });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some((call) => call.method === "thread/readState/update"), false);
  }
});

test("completion receipt conflicts are not retried, and unavailable receipts are left alone", async () => {
  for (const receipt of [read, null]) {
    const { client, calls, notify } = completionFixture(receipt);
    const request = client.request;
    client.request = async (method, params) => {
      if (method !== "thread/readState/update") return request(method, params);
      calls.push({ method, params });
      throw Object.assign(new Error("read state revision conflict"), { code: -32600 });
    };
    notify("turn/completed");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((call) => call.method === "thread/read").length, 1);
    assert.equal(calls.filter((call) => call.method === "thread/readState/update").length, receipt ? 1 : 0);
  }
});

async function unavailableReceiptFixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-read-state-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.json");
  const client = new EventEmitter();
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: "thread", historyMode: "paginated" }, readState: null };
    if (method === "thread/list") return { data: [{ id: "thread" }], readStates: { thread: { firstUnread: null, revision: "initial:thread" } } };
    if (method === "thread/unsubscribe") return { status: "notLoaded" };
    assert.equal(method, "thread/readState/update");
    throw Object.assign(new Error("durable read state unavailable"), { code: -32600 });
  };
  const stateStore = new BridgeStateStore(file);
  const service = new ThreadService({ client, stateStore, eventHub: new EventHub() });
  return { client, calls, service, file };
}

test("real-runtime null transcript receipts and placeholder list receipts still produce persistent completion badges", async (context) => {
  const { client, calls, service, file } = await unavailableReceiptFixture(context);
  const completion = { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } };
  client.emit("notification", completion);
  await new Promise((resolve) => setImmediate(resolve));
  const list = await service.listThreads();
  assert.equal(summaries.isThreadUnread(list.data[0]), true);
  assert.match(list.readStates.thread.revision, /^bridge:/);
  assert.deepEqual(list.readStates.thread, list.data[0].readState);
  assert.equal(calls.some((call) => call.method === "thread/readState/update"), false);
  client.emit("notification", { method: "thread/readState/changed", params: { threadId: "thread", readState: read } });
  assert.equal(summaries.isThreadUnread((await service.listThreads()).data[0]), true);

  const restored = new ThreadService({ client: new EventEmitter(), stateStore: new BridgeStateStore(file), eventHub: new EventHub() });
  assert.deepEqual(restored.stateStore.getReadState("thread"), list.data[0].readState, "unread survives process restart");
  const receipt = (await service.getThread("thread")).thread.readState;
  await service.updateReadState("thread", { read: true, expectedRevision: receipt.revision });
  await assert.rejects(service.updateReadState("thread", { read: false, expectedRevision: receipt.revision }), { code: "read_state_conflict" });
  client.emit("notification", completion);
  assert.equal(summaries.isThreadUnread((await service.listThreads({ refresh: true })).data[0]), false);
  assert.equal(new BridgeStateStore(file).getReadState("thread").firstUnread, null, "acknowledgement also survives restart");
});

test("an unavailable native mutation falls back once without accepting stale native revisions later", async (context) => {
  const { service, calls } = await unavailableReceiptFixture(context);
  const initial = (await service.listThreads()).data[0].readState;
  const marked = await service.updateReadState("thread", { read: false, expectedRevision: initial.revision });
  assert.equal(summaries.isThreadUnread(marked), true);
  await assert.rejects(service.updateReadState("thread", { read: true, expectedRevision: initial.revision }), { code: "read_state_conflict" });
  assert.equal(calls.filter((call) => call.method === "thread/readState/update").length, 1);
  assert.deepEqual((await service.getThread("thread")).readState, marked.readState);
});

test("action menu includes the translated unread action with its click handler", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="drawerMarkUnreadButton"/);
  assert.match(html, /data-i18n="actions.markUnread"/);
  assert.match(app, /drawerMarkUnreadButton\.addEventListener\("click", markSelectedUnread\)/);
});
