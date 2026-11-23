import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { EventHub } from "../src/event-hub.mjs";
import { compactTurnPage, deltaFromTurnPage, findThreadItem } from "../src/mobile-history.mjs";
import { EventStreamController, eventStreamUrl, reconnectDelay } from "../public/modules/event-stream.js";
import { ThreadService } from "../src/thread-service.mjs";

test("mobile history keeps messages and summarizes tool output", () => {
  const page = compactTurnPage({ data: [{ id: "turn-2", items: [
    { id: "user-1", type: "userMessage", content: [{ type: "text", text: "run it" }] },
    { id: "agent-1", type: "agentMessage", text: "done" },
    { id: "tool-1", type: "commandExecution", command: "npm test", aggregatedOutput: "x".repeat(2_000), status: "completed" },
  ] }], nextCursor: "older" }, { summaryLimit: 80 });

  assert.equal(page.data[0].items[0].content[0].text, "run it");
  assert.equal(page.data[0].items[1].text, "done");
  assert.equal(page.data[0].items[2].detailAvailable, true);
  assert.ok(page.data[0].items[2].text.length <= 80);
  assert.equal(page.data[0].items[2].aggregatedOutput, undefined);
});

test("turn delta includes the known newest turn for in-place updates", () => {
  const page = { data: [{ id: "turn-3" }, { id: "turn-2" }, { id: "turn-1" }], nextCursor: "older" };
  assert.deepEqual(deltaFromTurnPage(page, "turn-2").data.map((turn) => turn.id), ["turn-3", "turn-2"]);
  assert.equal(deltaFromTurnPage(page, "turn-missing").resetRequired, true);
});

test("thread item lookup accepts item pagination entries", () => {
  assert.deepEqual(findThreadItem({ data: [{ turnId: "turn-1", item: { id: "item-1", text: "full" } }] }, "item-1"), {
    turnId: "turn-1",
    item: { id: "item-1", text: "full" },
  });
});

test("event stream resume URL and reconnect delay stay bounded", () => {
  assert.equal(eventStreamUrl({ lastEventId: 42, instanceId: "instance-a" }), "/api/events?lastEventId=42&instanceId=instance-a");
  assert.equal(reconnectDelay(0, () => 0.5), 1_000);
  assert.equal(reconnectDelay(20, () => 0.5), 15_000);
});

test("event stream controller keeps one source and closes it on failure", () => {
  const sources = [];
  let offline = 0;
  const controller = new EventStreamController({
    onOffline: () => { offline += 1; },
    eventSourceFactory: (url) => {
      const source = {
        url,
        listeners: new Map(),
        addEventListener(name, handler) { this.listeners.set(name, handler); },
        close() { this.closed = true; },
      };
      sources.push(source);
      return source;
    },
  });
  controller.start();
  controller.start();
  assert.equal(sources.length, 1);
  sources[0].onopen();
  sources[0].onerror();
  assert.equal(sources[0].closed, true);
  assert.equal(offline, 1);
  controller.stop();
});

test("event hub resumes retained events and emits observable heartbeats", () => {
  const hub = new EventHub({ replaySize: 2 });
  hub.publish("one", {});
  hub.publish("two", {});
  const request = new EventEmitter();
  request.headers = {};
  request.url = `/api/events?lastEventId=1&instanceId=${hub.instanceId}`;
  const chunks = [];
  const response = {
    writeHead: () => {},
    write: (value) => chunks.push(value),
    end: () => {},
  };

  assert.equal(hub.attach(request, response, { ready: true }), true);
  hub.heartbeat();
  const output = chunks.join("");
  assert.match(output, /"method":"two"/);
  assert.match(output, /"replayedCount":1/);
  assert.match(output, /event: bridge-ping/);
  request.emit("close");
  assert.equal(hub.clients.size, 0);
});

test("new conversation uses a touch-friendly workspace picker", async () => {
  const root = new URL("..", import.meta.url);
  const [page, app] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8"),
  ]);

  assert.doesNotMatch(page, /<datalist\b|\blist="workspaceOptions"/);
  assert.match(page, /id="workspaceToggle"/);
  assert.match(page, /id="workspaceOptions"[^>]+role="listbox"/);
  assert.match(app, /workspaceToggle\.addEventListener\("click", toggleWorkspaceOptions\)/);
});

test("model and reasoning selectors use the live catalog and persist queued turn settings", async () => {
  const root = new URL("..", import.meta.url);
  const [page, app, styles, service] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8"),
    readFile(new URL("public/styles.css", root), "utf8"),
    readFile(new URL("src/thread-service.mjs", root), "utf8"),
  ]);

  const header = page.match(/<section class="chat-header">[\s\S]*?<\/section>/)?.[0] || "";
  const composer = page.match(/<footer class="composer-wrap">[\s\S]*?<\/footer>/)?.[0] || "";
  assert.match(header, /id="modelSettingsButton"/);
  assert.match(page, /id="modelSettingsModal"[^>]+role="dialog"/);
  assert.match(page, /id="modelSelect"/);
  assert.match(page, /id="effortSelect"/);
  assert.match(page, /id="newModelSelect"/);
  assert.doesNotMatch(composer, /id="modelControls"/);
  assert.match(app, /api\("\/api\/models"\)/);
  assert.match(app, /modelSettingsButton\.addEventListener\("click", openModelSettings\)/);
  assert.match(styles, /\.model-settings-summary \{[^}]*text-overflow: ellipsis/);
  assert.match(app, /\/settings`[\s\S]*?method: "PATCH"/);
  assert.match(service, /client\.request\("model\/list"/);
  assert.match(service, /client\.request\("thread\/settings\/update"/);
  assert.match(service, /model: item\.model \|\| null/);
  assert.match(service, /effort: item\.effort \|\| null/);
});

test("both model pickers expose 6.2 models and refresh an already loaded settings catalog", async () => {
  const client = new EventEmitter();
  const legacy = { id: "gpt-6.1-terra", model: "gpt-6.1-terra", isDefault: true };
  const nativeModel = (model, displayName) => ({
    id: model, model, displayName, defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
  });
  client.request = async () => ({ data: [legacy, nativeModel("gpt-6.2-sol", "GPT-6.2-Sol"), nativeModel("gpt-6.2-astra", "GPT-6.2-Astra")] });
  const service = new ThreadService({ client, eventHub: new EventHub(), stateStore: {} });
  const models = (await service.models()).data;
  const node = () => ({
    value: "", children: [], classList: { remove() {} }, setAttribute() {}, focus() {},
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ""; },
  });
  const elements = Object.fromEntries([
    "modelSelect", "effortSelect", "modelSettingsButton", "modelSettingsSummary", "modelSettingsModal",
    "closeModelSettings", "newModelSelect", "newEffortSelect",
  ].map((id) => [id, node()]));
  const stored = new Map([["model", "gpt-6.2-sol"], ["effort", "max"]]);
  const state = { models, modelsLoading: false, settingsSaving: false,
    selected: { id: "thread", model: "gpt-6.2-astra", reasoningEffort: "ultra" } };
  let requests = 0;
  const context = vm.createContext({
    state, elements, document: { createElement: node }, localStorage: { getItem: (key) => stored.get(key) },
    MODEL_STORAGE_KEY: "model", EFFORT_STORAGE_KEY: "effort", t: (key) => key,
    api: async (url) => { assert.equal(url, "/api/models"); requests++; return { data: models }; },
  });
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("function modelValue("), source.indexOf("function updateSelectedSettings(")), context);
  vm.runInContext(source.slice(source.indexOf("function openModelSettings("), source.indexOf("function closeModelSettings(")), context);
  context.renderModelControls();
  context.renderNewModelControls();
  for (const select of [elements.modelSelect, elements.newModelSelect]) {
    assert.deepEqual(select.children.map((option) => option.value), ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra"]);
    assert.ok(select.children.some((option) => option.value === "gpt-6.2-astra" && option.textContent === "GPT-6.2-Astra"));
    assert.ok(select.children.some((option) => option.value === "gpt-6.2-sol" && option.textContent === "GPT-6.2-Sol"));
    assert.equal(select.disabled, false);
  }
  assert.equal(elements.modelSelect.value, "gpt-6.2-astra");
  assert.equal(elements.effortSelect.value, "ultra");
  assert.equal(elements.newModelSelect.value, "gpt-6.2-sol");
  assert.equal(elements.newEffortSelect.value, "max");
  assert.deepEqual(elements.newEffortSelect.children.map((option) => option.value), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  context.openModelSettings();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1, "opening settings refreshes a nonempty catalog");
  assert.equal(elements.modelSelect.value, "gpt-6.2-astra");
  assert.equal(elements.newModelSelect.value, "gpt-6.2-sol");
  state.models = [legacy];
  context.renderModelControls();
  context.renderNewModelControls();
  const unavailableSelection = elements.modelSelect.children.find((option) => option.value === "gpt-6.2-astra");
  assert.equal(unavailableSelection.disabled, true, "a saved unsupported model is shown only as an unavailable selection");
  assert.equal(elements.effortSelect.disabled, true);
  assert.deepEqual(elements.newModelSelect.children.map((option) => option.value), ["gpt-6.1-terra"]);
});

test("mobile actions use a topbar drawer instead of consuming conversation-list space", async () => {
  const root = new URL("..", import.meta.url);
  const [page, app] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8"),
  ]);

  const sidebar = page.match(/<aside id="sidebar"[\s\S]*?<\/aside>/)?.[0] || "";
  assert.match(page, /id="actionMenuButton"[^>]+aria-controls="actionDrawer"/);
  assert.match(page, /id="actionDrawer"[^>]+role="group"[^>]+inert/);
  assert.match(page, /id="drawerArchiveThreadButton"/);
  assert.doesNotMatch(page, /id="archiveThreadButton"/);
  assert.doesNotMatch(sidebar, /id="drawer(?:NewThread|Refresh|ArchiveThread|Theme|Language)Button"/);
  assert.match(app, /function openActionDrawer\(\)/);
  assert.match(app, /thread\/archive/);
  assert.match(app, /closeActionDrawer\(\);\s*\n\s*document\.body\.classList\.add\("drawer-open"\)/);
});

test("queued messages are rehydrated and individually cancellable on mobile", async () => {
  const root = new URL("..", import.meta.url);
  const [app, messages] = await Promise.all([
    readFile(new URL("public/app.js", root), "utf8"),
    readFile(new URL("public/modules/messages.js", root), "utf8"),
  ]);

  assert.match(app, /api\(`\/api\/threads\/\$\{encodeURIComponent\(summary\.id\)\}\/queue`\)/);
  assert.match(app, /method: "DELETE"/);
  assert.match(app, /bridge\/messageQueueCancelled/);
  assert.match(messages, /state\.historyItems, \.\.\.state\.queuedMessages/);
  assert.match(messages, /onCancelQueued\?\.\(entry\)/);
});

test("external writer state exposes an explicit confirmed takeover action", async () => {
  const root = new URL("..", import.meta.url);
  const [page, app, styles] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8"),
    readFile(new URL("public/styles.css", root), "utf8"),
  ]);

  assert.match(page, /id="takeoverBar"[^>]+role="status"/);
  assert.match(page, /id="takeoverButton"/);
  assert.match(app, /state\.externalWriter/);
  assert.match(app, /window\.confirm\(t\(preflight\.mode === "desktop" \? "takeover\.desktopConfirm" : "takeover\.confirm"/);
  assert.match(app, /\/takeover`/);
  assert.match(styles, /\.takeover-button \{[^}]*min-height: 44px/);
});
