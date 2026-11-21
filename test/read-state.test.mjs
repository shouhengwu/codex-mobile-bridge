import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { ThreadService } from "../src/thread-service.mjs";
import { EventHub } from "../src/event-hub.mjs";
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
  const { context, state } = browser(async (path) => path.endsWith("/thread") ? { thread: { id: "thread", name: "Fixture" } } : { data: [] });
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

test("action menu includes the translated unread action with its click handler", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="drawerMarkUnreadButton"/);
  assert.match(html, /data-i18n="actions.markUnread"/);
  assert.match(app, /drawerMarkUnreadButton\.addEventListener\("click", markSelectedUnread\)/);
});
