import { activityTime, eventThreadId, eventTurnId, statusType } from "./formatters.js";

function currentSummary(state, id) {
  return state.threads.find((thread) => thread.id === id) || (state.selected?.id === id ? state.selected : null);
}

export function summaryVersion(state) {
  return state.threadSummaryVersion || 0;
}

export function isThreadUnread(thread) {
  return Boolean(thread?.readState?.firstUnread);
}

export function mergeThreadSummary(state, summary, since = null) {
  const current = currentSummary(state, summary.id);
  // Responses started before a local event cannot restore an old title or status.
  if (since !== null && (state.threadSummaryRevisions?.get(summary.id) || 0) > since) return current || summary;
  const merged = { ...current, ...summary };
  if (summary.status && statusType(summary) !== "active") delete state.activeTurns[summary.id];
  state.threads = state.threads.map((thread) => thread.id === summary.id ? merged : thread);
  if (state.selected?.id === summary.id) state.selected = merged;
  return merged;
}

export function patchThreadSummary(state, id, changes) {
  if (!currentSummary(state, id)) return null;
  state.threadSummaryVersion = summaryVersion(state) + 1;
  (state.threadSummaryRevisions ||= new Map()).set(id, state.threadSummaryVersion);
  return mergeThreadSummary(state, { id, ...changes });
}

export function noteThreadActivity(state, id, { text = "", at = Date.now() } = {}) {
  const current = currentSummary(state, id);
  if (!current) return;
  const localTitle = current.localTitle || text.trim().replace(/\s+/g, " ").slice(0, 80);
  patchThreadSummary(state, id, { localActivityAt: Math.max(current.localActivityAt || 0, at), ...(localTitle ? { localTitle } : {}) });
}

export function startThreadTurn(state, id, turnId, at = Date.now()) {
  if (!turnId || state.completedTurns?.has(turnId)) return false;
  state.activeTurns[id] = turnId;
  patchThreadSummary(state, id, { status: { type: "active" } });
  noteThreadActivity(state, id, { at });
  return true;
}

export function completeThreadTurn(state, id, turnId, at = Date.now()) {
  if (turnId) {
    const completed = state.completedTurns ||= new Set();
    completed.add(turnId);
    if (completed.size > 512) completed.delete(completed.values().next().value);
  }
  if (turnId && state.activeTurns[id] && state.activeTurns[id] !== turnId) return false;
  delete state.activeTurns[id];
  patchThreadSummary(state, id, { status: { type: "idle" } });
  noteThreadActivity(state, id, { at });
  return true;
}

export function applyThreadSummaryEvent(state, event) {
  const { method, params = {} } = event;
  const id = eventThreadId(params);
  if (!id) return true;
  const at = Date.parse(event.at) || Date.now();
  if (method === "turn/started") return startThreadTurn(state, id, eventTurnId(params), at);
  if (method === "turn/completed") return completeThreadTurn(state, id, eventTurnId(params), at);
  if (method === "thread/status/changed") {
    patchThreadSummary(state, id, { status: typeof params.status === "string" ? { type: params.status } : params.status });
  } else if (method === "thread/name/updated") {
    const name = params.threadName ?? params.name;
    if (typeof name === "string") patchThreadSummary(state, id, { name });
  } else if (method === "thread/readState/changed" && params.readState) {
    patchThreadSummary(state, id, { readState: params.readState });
  } else if (method === "thread/started" && params.thread) {
    patchThreadSummary(state, id, params.thread);
  }
  return true;
}

export function reconcileActiveTurns(state, incoming, since = null) {
  for (const id of new Set([...Object.keys(state.activeTurns), ...Object.keys(incoming)])) {
    if (since !== null && (state.threadSummaryRevisions?.get(id) || 0) > since) continue;
    const turnId = incoming[id];
    if (turnId && !state.completedTurns?.has(turnId)) {
      const current = currentSummary(state, id);
      const status = state.activeTurns[id] === turnId && statusType(current) === "active" ? current.status : { type: "active" };
      state.activeTurns[id] = turnId;
      mergeThreadSummary(state, { id, status });
    } else {
      delete state.activeTurns[id];
      mergeThreadSummary(state, { id, status: { type: "idle" } });
    }
  }
}

export function orderedThreads(threads, pinnedIds) {
  const positions = new Map(pinnedIds.map((id, index) => [id, index]));
  return [...threads].sort((a, b) => {
    const aPin = positions.get(a.id);
    const bPin = positions.get(b.id);
    if (aPin !== undefined || bPin !== undefined) return (aPin ?? Infinity) - (bPin ?? Infinity);
    return activityTime(b) - activityTime(a);
  });
}
