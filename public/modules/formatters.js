import { language, t } from "./i18n.js";

function pick(value, ...keys) {
  for (const key of keys) if (value?.[key] != null) return value[key];
  return null;
}

export function threadData(result) {
  return result?.data || result?.threads || result?.items || [];
}

export function threadObject(result) {
  return result?.thread || result || {};
}

export function titleOf(thread) {
  return [thread?.name, thread?.title, thread?.preview, thread?.localTitle]
    .find((value) => typeof value === "string" && value.trim()) || t("threads.untitled");
}

export function activityTime(thread) {
  return Math.max(0, ...[thread?.localActivityAt, thread?.recencyAt, thread?.updatedAt, thread?.updated_at, thread?.createdAt, thread?.created_at]
    .map((value) => typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value))
    .filter(Number.isFinite));
}

export function dateOf(thread) {
  const time = activityTime(thread);
  if (!time) return "";
  const date = new Date(time);
  const elapsed = Date.now() - date.valueOf();
  if (elapsed >= 0 && elapsed < 60_000) return t("date.now");
  if (elapsed >= 0 && elapsed < 3_600_000) return t("date.minutesAgo", { count: Math.floor(elapsed / 60_000) });
  if (elapsed >= 0 && elapsed < 86_400_000) return t("date.hoursAgo", { count: Math.floor(elapsed / 3_600_000) });
  return date.toLocaleString(language(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function textFrom(value, depth = 0) {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => textFrom(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.message === "string") return value.message;
  for (const key of ["content", "input", "output", "delta", "summary", "aggregatedOutput"]) {
    const text = textFrom(value[key], depth + 1);
    if (text) return text;
  }
  return "";
}

function roleOf(item) {
  const type = String(item?.type || item?.kind || "").toLowerCase();
  const role = String(item?.role || "").toLowerCase();
  if (role === "user" || type.includes("user")) return "user";
  if (role === "assistant" || type.includes("agentmessage") || type.includes("assistant")) return "agent";
  return "tool";
}

export function statusType(thread) {
  return typeof thread?.status === "string" ? thread.status : thread?.status?.type || "";
}

export function entriesFromTurns(result) {
  const turns = (result?.data || []).slice().reverse();
  const entries = [];
  for (const turn of turns) {
    for (const [index, item] of (turn.items || []).entries()) {
      const text = textFrom(item);
      if (!text) continue;
      entries.push({
        id: item.id || `${turn.id || "turn"}:${index}:${String(item.type || "item")}`,
        turnId: turn.id || null,
        role: roleOf(item),
        text,
        type: item.type || item.kind || "event",
        compact: item.compact === true,
        detailAvailable: item.detailAvailable === true,
        pending: false,
      });
    }
  }
  return entries;
}

export function latestTurnId(result) {
  return result?.data?.[0]?.id || null;
}

export function eventThreadId(params = {}) {
  return params.threadId || params.thread_id || params.thread?.id || params.turn?.threadId || null;
}

export function eventTurnId(params = {}) {
  return params.turnId || params.turn_id || params.turn?.id || null;
}
