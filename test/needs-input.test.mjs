import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { ThreadService } from "../src/thread-service.mjs";
import { EventHub } from "../src/event-hub.mjs";
import { compactTurnPage } from "../src/mobile-history.mjs";
import * as formatters from "../public/modules/formatters.js";
import * as summaries from "../public/modules/thread-summaries.js";
import { state as initialState } from "../public/modules/state.js";
import { t } from "../public/modules/i18n.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const messages = await readFile(new URL("../public/modules/messages.js", import.meta.url), "utf8");
const questions = [{ title: "Which environment?", options: ["Preview", "Production"] }, { title: "Any constraints?", options: null }];
const prompt = { id: "question", type: "agentMessage", text: "", delivery: "async", questions };

function node(tagName = "div") {
  return {
    tagName, children: [], dataset: {}, listeners: {}, className: "", textContent: "", value: "",
    classList: { add() {}, remove() {}, toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute() {}, focus() { this.focused = true; },
    querySelectorAll() { return []; },
  };
}

function browser() {
  const state = structuredClone(initialState);
  state.threads = [{ id: "thread", status: { type: "active", activeFlags: ["waitingOnUserInput"] } }];
  state.selected = state.threads[0];
  state.activeTurns.thread = "turn";
  const label = node();
  const context = vm.createContext({
    state, ...formatters, ...summaries, t, Date,
    document: { createElement: node }, archivingThreadId: null, hasStoredLanguage: () => true,
    elements: { requests: node(), messages: { scrollTop: 100, querySelector: () => null }, turnState: { querySelector: () => label }, chatTitle: {}, bridgeVersion: {} },
    renderThreads() {}, updateComposer() {}, renderMessages() {}, scheduleThreadSummarySync() {},
    setTimeout() {}, isNearBottom: () => false, CSS: { escape: (value) => value },
  });
  for (const [start, end] of [
    ["function isThreadActive(", "function setConnection("],
    ["function syncSnapshot(", "function queueEntry("],
    ["function updateTurnState(", "function showBanner("],
    ["function handleEvent(", "function actionRow("],
  ]) vm.runInContext(app.slice(app.indexOf(start), app.indexOf(end)), context);
  return { context, state, label };
}

test("question-only asynchronous messages survive native history compaction and browser formatting", () => {
  const page = compactTurnPage({ data: [{ id: "turn", items: [prompt] }] });
  assert.deepEqual(page.data[0].items[0].questions, questions);
  const entries = formatters.entriesFromTurns(page);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].role, "agent");
  assert.equal(entries[0].text, "");
  assert.deepEqual(entries[0].questions, [{ ...questions[0] }, { ...questions[1], options: [] }]);
  assert.deepEqual(formatters.asyncQuestions({ ...prompt, questions: [null, {}, { title: " " }] }), []);
});

test("question cards render all prompts and options safely and only prepare replies on explicit clicks", () => {
  const replies = [];
  const context = vm.createContext({ document: { createElement: node }, t, markdownToHtml: (text) => text });
  vm.runInContext(messages.replace(/^import .*;\r?\n/gm, "").replace("export function", "function"), context);
  const view = context.createMessageView({ state: { selected: { id: "thread" } }, onAnswerQuestion: (...args) => replies.push(args) });
  const body = node();
  view.renderEntryBody(body, formatters.entriesFromTurns({ data: [{ id: "turn", items: [prompt] }] })[0]);
  const card = body.children[0];
  assert.equal(card.children[0].textContent, t("request.userInput"));
  assert.equal(card.children[1].children[0].textContent, questions[0].title);
  assert.equal(card.children[2].children[0].textContent, questions[1].title);
  const buttons = card.children[1].children[1].children;
  assert.deepEqual(buttons.map((button) => button.textContent), ["Preview", "Production"]);
  assert.deepEqual(replies, [], "preselection never sends or prepares an answer");
  buttons[1].listeners.click();
  assert.deepEqual(replies, [["thread", "Which environment?\nProduction"]]);
  assert.equal(card.children[2].children[1].children.length, 0, "free-text questions still show their title");
});

test("live item notifications add question-only messages, deduplicate deltas and respect selection", () => {
  const { context, state } = browser();
  context.handleEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item: prompt } });
  assert.equal(state.historyItems.length, 1);
  assert.equal(state.historyItems[0].questions.length, 2);
  context.handleEvent({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: prompt.id, delta: "Please " } });
  assert.equal(state.historyItems.length, 1, "text deltas reuse the question message");
  context.handleEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { ...prompt, text: "Please choose." } } });
  assert.equal(state.historyItems.length, 1);
  assert.equal(state.historyItems[0].text, "Please choose.");
  assert.equal(state.historyItems[0].pending, false);
  assert.equal(state.streaming.size, 0);
  assert.equal(state.historyRevision, 3);
  context.handleEvent({ method: "item/completed", params: { threadId: "other", item: { ...prompt, id: "unrelated" } } });
  assert.equal(state.historyItems.length, 1);
});

test("native waiting flags survive same-turn health reconciliation and clear on completion", () => {
  const { context, state, label } = browser();
  summaries.reconcileActiveTurns(state, { thread: "turn" });
  context.syncSelectedActivity();
  assert.equal(label.textContent, t("threads.needsInput"));
  context.handleEvent({ method: "thread/status/changed", params: { threadId: "thread", status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
  assert.equal(label.textContent, t("threads.needsApproval"));
  context.handleEvent({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  assert.equal(context.threadWaitingLabel(state.selected), "");
  assert.equal(state.busy, false);
});

test("App Server snapshots retain pending questions and native resolution only clears its matching thread", () => {
  const client = new EventEmitter();
  client.snapshot = () => ({ ready: true });
  const hub = new EventHub();
  const service = new ThreadService({ client, eventHub: hub, stateStore: { snapshot: () => ({}) } });
  client.emit("serverRequest", { id: 7, method: "item/tool/requestUserInput", params: {
    threadId: "thread", turnId: "turn", itemId: "input", isBlocking: true,
    questions: [{ id: "q", header: "Environment", question: "Which?", isOther: true, options: [{ label: "Preview" }] }],
  } });
  assert.equal(service.snapshot().requests[0].kind, "userInput");
  assert.equal(service.snapshot().requests[0].questions[0].question, "Which?");
  client.emit("notification", { method: "serverRequest/resolved", params: { threadId: "other", requestId: 7 } });
  assert.equal(service.pendingRequests().data.length, 1);
  client.emit("notification", { method: "serverRequest/resolved", params: { threadId: "thread", requestId: 7 } });
  assert.equal(service.pendingRequests().data.length, 0);
  assert.equal(hub.history.findLast((event) => event.method === "bridge/requestResolved").params.requestId, "7");
  client.emit("state", { ready: false });
  assert.deepEqual(hub.history.at(-1).params.requests, []);
});

test("reconnect snapshots replace obsolete request cards while preserving unfinished answers", () => {
  const { context, state } = browser();
  const request = { requestId: "7", kind: "userInput", threadId: "thread", questions: [] };
  context.actionRow = () => node();
  context.handleEvent({ method: "bridge/request", params: request });
  const original = context.elements.requests.children[0];
  original.unsentAnswer = "unfinished";
  context.syncSnapshot({ ready: true, requests: [request], activeTurns: { thread: "turn" } });
  assert.equal(context.elements.requests.children[0], original);
  assert.equal(original.unsentAnswer, "unfinished");
  const revision = state.requestsRevision;
  context.handleEvent({ method: "bridge/requestResolved", params: { requestId: "7" } });
  context.syncSnapshot({ ready: true, requests: [request], activeTurns: {} }, null, revision);
  assert.equal(state.requests.size, 0, "late health snapshots cannot resurrect a resolved card");
  context.syncSnapshot({ ready: true, requests: [request], activeTurns: {} });
  assert.equal(state.requests.size, 1, "a fresh SSE snapshot restores requests missed outside the replay window");
  context.syncSnapshot({ ready: true, requests: [], activeTurns: {} });
  assert.equal(context.elements.requests.children.length, 0);
});

test("option replies preserve drafts, stay with the selected thread and never submit automatically", () => {
  const { context, state } = browser();
  const stored = new Map();
  context.localStorage = { setItem: (key, value) => stored.set(key, value) };
  context.draftKey = (id) => id;
  context.resizeComposer = () => {};
  context.elements.messageInput = node("textarea");
  context.elements.messageInput.value = "Existing draft";
  vm.runInContext(app.slice(app.indexOf("function prepareQuestionAnswer("), app.indexOf("function workspaceOptionsOpen(")), context);
  context.prepareQuestionAnswer("thread", "Preview");
  assert.equal(context.elements.messageInput.value, "Existing draft\nPreview");
  assert.equal(stored.get("thread"), "Existing draft\nPreview");
  state.selected = { id: "other" };
  context.prepareQuestionAnswer("thread", "Production");
  assert.equal(context.elements.messageInput.value, "Existing draft\nPreview");
});

test("an in-flight legacy request list cannot restore a request resolved by a newer event", async () => {
  const { context, state } = browser();
  let resolve;
  context.api = () => new Promise((done) => { resolve = done; });
  const pending = context.refreshRequests();
  context.handleEvent({ method: "bridge/requestResolved", params: { requestId: "7" } });
  resolve({ data: [{ requestId: "7", kind: "userInput", threadId: "thread" }] });
  await pending;
  assert.equal(state.requests.size, 0);
});

test("blocking question answers use their original RPC request and remain pending after invalid submissions", () => {
  const client = new EventEmitter();
  const replies = [];
  client.reply = (id, result) => replies.push({ id, result });
  const service = new ThreadService({ client, eventHub: new EventHub(), stateStore: {} });
  client.emit("serverRequest", { id: 8, method: "item/tool/requestUserInput", params: {
    threadId: "thread", turnId: "turn", questions: [{ id: "target", header: "Environment", question: "Which?", options: null }],
  } });
  assert.throws(() => service.respondToRequest("8", { answers: {} }), { code: "invalid_answers" });
  assert.equal(service.pendingRequests().data.length, 1);
  service.respondToRequest("8", { answers: { target: ["Preview"] } });
  assert.deepEqual(replies, [{ id: 8, result: { answers: { target: { answers: ["Preview"] } } } }]);
  assert.equal(service.pendingRequests().data.length, 0);
});
