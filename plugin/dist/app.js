/* dsh-mobile-remote - restricted phone control surface. */
"use strict";

import { marked } from "/mobile/vendor/marked.js";
import DOMPurify from "/mobile/vendor/dompurify.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const MODE_NAMES = { standard: "标准模式", code: "PTC 模式", minimal: "极简模式", cordis: "创造模式" };
const PERMISSION_NAMES = { "read-only": "Read Only", "workspace-write": "Workspace Write", "danger-full-access": "Full access" };
marked.setOptions({ gfm: true, breaks: true, pedantic: false, async: false });

let state = null;
let controls = null;
let currentSessionId = null;
let polling = false;
let eventSource = null;
let stateRefreshTimer = null;
let historyRefreshTimer = null;
let historyRefreshRunning = false;
let historyRefreshPending = false;
let historyLoading = false;
let liveEventBacklog = [];
let historyEventSeqs = new Set();
let reconnectTimer = null;
let reconnectAttempt = 0;
let lastCompletionAt = 0;
let historyActiveTool = null;
let lastRealtimeEventAt = 0;
let liveRenderFrame = null;
let liveBlocks = new Map();
let liveToolNodes = new Map();
let liveCommandNodes = new Map();
let pendingOutbound = [];
let turnStartedAt = null;
let workingPhase = null;
let workingTool = null;
let workingTicker = null;
let pendingDangerPreset = null;
let queueExpanded = false;
let connection = { phase: "connecting", latencyMs: null, detail: "正在连接 Harness…" };
const expandedGroups = new Set();

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3200);
}

function setConnection(phase, detail, latencyMs = null) {
  connection = { phase, detail, latencyMs };
  const button = $("btn-refresh");
  button.classList.remove("online", "connecting", "offline");
  button.classList.add(phase);
  $("connection-label").textContent = phase === "online" ? `已连接${latencyMs === null ? "" : ` ${latencyMs}ms`}` : phase === "offline" ? "已断开" : "连接中";
  $("connection-detail").textContent = detail;
}

function stopReconnectTimer() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer !== null || state === null) return;
  const delay = Math.min(15_000, 1_000 * (2 ** Math.min(reconnectAttempt, 4)));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(async () => { reconnectTimer = null; await reconnect(true); }, delay);
}

async function api(path, { method = "GET", body, query = {} } = {}) {
  const params = new URLSearchParams(query);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(`/mobile-api${path}${suffix}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    if (response.status === 401) logout();
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

async function updateLatency() {
  const startedAt = performance.now();
  try {
    await api("/ping");
    const latency = Math.max(1, Math.round(performance.now() - startedAt));
    setConnection("online", `已连接到本机 Harness，实时通道往返 ${latency}ms`, latency);
  } catch {}
}

function logout() {
  stopSse();
  stopReconnectTimer();
  finishWorking();
  resetLiveRendering();
  pendingOutbound = [];
  closeDrawer();
  closeSheet();
  state = null;
  controls = null;
  currentSessionId = null;
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}

async function logoutDevice() {
  try { await fetch("/mobile-api/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" }); } catch {}
  if (navigator.userAgent.includes("DSHMobileAndroid")) location.href = "dshmobile://disconnect";
  else logout();
}

async function tryLogin(candidate) {
  const response = await fetch("/mobile-api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: candidate.trim() }), credentials: "same-origin" });
  const login = await response.json().catch(() => ({}));
  if (!response.ok || login.ok !== true) throw new Error(login.error ?? `HTTP ${response.status}`);
  await reconnect();
}

async function enter(data, latencyMs = null) {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  document.title = data.title ?? "DSH 远程控制";
  $("server-url").textContent = location.origin + "/mobile/";
  state = data;
  renderSessions(data.sessions ?? []);
  renderWorkspace(data.workspace);
  renderDeviceSession(data.deviceSession);
  renderSsh(data.ssh);
  renderStatusLine();
  setConnection("online", "已连接到本机 Harness，正在同步当前会话…", latencyMs);
  reconnectAttempt = 0;
  stopReconnectTimer();
  startSse();
  void updateLatency();
  await selectCurrentSession();
}

async function reconnect(quiet = false) {
  setConnection("connecting", "正在检查电脑与 Harness 服务…");
  try {
    const data = await api("/state");
    await enter(data);
    if ((data.sessions ?? []).filter((item) => !item.archived).length === 0) await createSession();
  } catch (error) {
    if (state !== null) {
      setConnection("offline", `无法连接：${String(error.message ?? error)}`);
      if (!quiet) toast("连接已断开，将自动重试");
      scheduleReconnect();
    }
  }
}

async function refresh({ quiet = false } = {}) {
  try {
    const data = await api("/state");
    state = data;
    renderSessions(data.sessions ?? []);
    renderWorkspace(data.workspace);
    renderDeviceSession(data.deviceSession);
    renderSsh(data.ssh);
    renderStatusLine();
    setConnection("online", connection.latencyMs === null ? "已连接到本机 Harness" : `已连接到本机 Harness，实时通道往返 ${connection.latencyMs}ms`, connection.latencyMs);
    reconnectAttempt = 0;
    stopReconnectTimer();
    return true;
  } catch (error) {
    if (state !== null) {
      setConnection("offline", `无法连接：${String(error.message ?? error)}`);
      if (!quiet) toast("连接失败，将自动重试");
      scheduleReconnect();
    }
    return false;
  }
}

function sessionLabel(item) {
  if (item?.title !== undefined && item.title !== null && String(item.title).trim().length > 0) return String(item.title);
  if (item?.blank) return "新会话";
  return `会话 ${String(item?.sessionId ?? "").slice(0, 8)}`;
}

function relativeTime(value) {
  const age = Math.max(0, Date.now() - Number(value ?? 0));
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天`;
}

function appendSessionGroup(container, key, title, sessions, icon = "▱") {
  if (sessions.length === 0) return;
  const section = document.createElement("section");
  section.className = "session-group";
  const heading = document.createElement("div");
  heading.className = "group-title";
  const folder = document.createElement("span");
  folder.className = "folder";
  folder.textContent = icon;
  const label = document.createElement("span");
  label.textContent = title;
  heading.append(folder, label);
  section.appendChild(heading);
  const expanded = expandedGroups.has(key);
  const visible = expanded ? sessions : sessions.slice(0, 5);
  for (const item of visible) {
    const button = document.createElement("button");
    button.className = `session-item${item.sessionId === currentSessionId ? " active" : ""}`;
    button.type = "button";
    button.dataset.sessionId = item.sessionId;
    if (item.running) {
      const dot = document.createElement("span");
      dot.className = "running-dot";
      button.appendChild(dot);
    }
    const name = document.createElement("span");
    name.className = "session-name";
    name.textContent = sessionLabel(item);
    const time = document.createElement("time");
    time.textContent = relativeTime(item.updatedAt);
    button.append(name, time);
    button.addEventListener("click", () => chooseSession(item.sessionId));
    section.appendChild(button);
  }
  if (sessions.length > 5) {
    const more = document.createElement("button");
    more.className = "group-more";
    more.type = "button";
    more.textContent = expanded ? "收起会话" : `展开其余 ${sessions.length - 5} 个会话`;
    more.addEventListener("click", () => {
      if (expanded) expandedGroups.delete(key); else expandedGroups.add(key);
      renderSessionGroups();
    });
    section.appendChild(more);
  }
  container.appendChild(section);
}

function renderSessionGroups() {
  const container = $("session-groups");
  container.innerHTML = "";
  const sessions = (state?.sessions ?? []).filter((item) => !item.archived).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const assigned = new Set();
  for (const workspace of state?.workspace?.options ?? []) {
    const items = sessions.filter((item) => item.workspaceId === workspace.workspaceId);
    for (const item of items) assigned.add(item.sessionId);
    appendSessionGroup(container, `workspace:${workspace.workspaceId}`, workspace.title, items, "▰");
  }
  appendSessionGroup(container, "ungrouped", "未分组", sessions.filter((item) => !assigned.has(item.sessionId)), "▱");
  if (container.childElementCount === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.style.padding = "14px 8px";
    empty.textContent = "还没有会话";
    container.appendChild(empty);
  }
}

function renderSessions(sessions) {
  const visible = sessions.filter((item) => !item.archived).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const select = $("session-select");
  const previous = currentSessionId;
  select.innerHTML = "";
  for (const item of visible) {
    const option = document.createElement("option");
    option.value = item.sessionId;
    option.textContent = sessionLabel(item);
    select.appendChild(option);
  }
  if (previous !== null && visible.some((item) => item.sessionId === previous)) currentSessionId = previous;
  else currentSessionId = visible[0]?.sessionId ?? null;
  select.value = currentSessionId ?? "";
  renderSessionGroups();
  $("current-session-title").textContent = sessionLabel(currentSummary());
}

function currentSummary() {
  return (state?.sessions ?? []).find((item) => item.sessionId === currentSessionId);
}

async function chooseSession(sessionId) {
  finishWorking();
  resetLiveRendering();
  pendingOutbound = [];
  currentSessionId = sessionId;
  queueExpanded = false;
  $("session-select").value = sessionId;
  controls = null;
  closeDrawer();
  switchPage("chat");
  renderSessionGroups();
  await selectCurrentSession();
}

function renderActivity(summary) {
  const banner = $("activity-banner");
  const text = $("activity-text");
  const activity = summary?.activity;
  banner.classList.remove("approval");
  if (activity?.pendingApproval !== undefined) {
    const approval = activity.pendingApproval;
    text.textContent = `等待许可批准：${approval.toolName ?? "工具"}${approval.reason ? `（${approval.reason}）` : ""}`;
    banner.classList.add("approval");
    banner.classList.remove("hidden");
    return;
  }
  const parts = [];
  const activeTool = activity?.activeTool ?? (summary?.running ? historyActiveTool : null);
  if (summary?.running === true) {
    const phase = workingPhase ?? (activeTool ? `正在执行 ${activeTool}` : "模型正在处理");
    const elapsed = turnStartedAt === null ? "" : ` · ${formatDuration(Date.now() - turnStartedAt)}`;
    parts.push(`${phase}${workingTool && !phase.includes(workingTool) ? ` ${workingTool}` : ""}${elapsed}`);
    const model = currentModelDisplayName();
    if (model) parts.push(model);
  }
  if ((activity?.jobs ?? 0) > 0) parts.push(`${activity.jobs} 个后台任务`);
  if ((activity?.queueLength ?? 0) > 0) parts.push(`${activity.queueLength} 条消息排队`);
  if (parts.length === 0) banner.classList.add("hidden");
  else { text.textContent = parts.join(" · "); banner.classList.remove("hidden"); }
  if ((activity?.lastCompletedAt ?? 0) > lastCompletionAt) { lastCompletionAt = activity.lastCompletedAt; toast("任务已完成"); }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

function currentModelDisplayName() {
  const current = controls?.models?.current;
  if (!current) return "";
  const group = (controls.models.groups ?? []).find((item) => item.id === current.provider);
  return group?.models?.find((item) => item.id === current.model)?.name ?? current.model ?? "";
}

function updateWorkingClock() {
  const summary = currentSummary();
  if (summary?.running !== true) return;
  const queue = summary.activity?.queueLength ?? 0;
  const elapsed = turnStartedAt === null ? "" : ` · ${formatDuration(Date.now() - turnStartedAt)}`;
  $("session-status").textContent = `${workingPhase ?? "运行中"}${elapsed}${queue > 0 ? ` · ${queue} 条排队` : ""}`;
  renderActivity(summary);
}

function setWorkingPhase(phase, { tool = null, startedAt } = {}) {
  workingPhase = phase;
  workingTool = tool;
  if (turnStartedAt === null) turnStartedAt = Number.isFinite(startedAt) ? startedAt : Date.now();
  if (workingTicker === null) workingTicker = setInterval(updateWorkingClock, 250);
  updateWorkingClock();
}

function finishWorking() {
  const elapsed = turnStartedAt === null ? null : Date.now() - turnStartedAt;
  if (workingTicker !== null) clearInterval(workingTicker);
  workingTicker = null;
  workingPhase = null;
  workingTool = null;
  turnStartedAt = null;
  return elapsed;
}

function queueItemsFor(summary = currentSummary()) {
  return (summary?.activity?.queueItems ?? []).filter((item) => item?.placement === "queued" && typeof item.id === "string");
}

function renderQueue(summary = currentSummary()) {
  const items = queueItemsFor(summary);
  const dock = $("queue-dock");
  dock.classList.toggle("hidden", items.length === 0);
  if (items.length === 0) {
    queueExpanded = false;
    $("queue-items").innerHTML = "";
    return;
  }
  $("queue-summary-label").textContent = `${items.length} 条排队消息`;
  $("queue-summary").classList.toggle("hidden", items.length === 1);
  $("queue-summary").setAttribute("aria-expanded", String(queueExpanded));
  $("queue-items").classList.toggle("collapsed", !queueExpanded && items.length > 1);
  const list = $("queue-items");
  list.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "queue-item";
    const text = document.createElement("span");
    text.className = "queue-item-text";
    text.textContent = item.text || "（非文本消息）";
    row.appendChild(text);
    const actions = document.createElement("div");
    actions.className = "queue-item-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "queue-action";
    edit.textContent = "✎";
    edit.title = "编辑排队消息";
    edit.setAttribute("aria-label", "编辑排队消息");
    edit.disabled = item.editable !== true;
    edit.addEventListener("click", () => openQueueEditor(item));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "queue-action danger-icon";
    remove.textContent = "⌫";
    remove.title = "删除排队消息";
    remove.setAttribute("aria-label", "删除排队消息");
    remove.addEventListener("click", () => updateQueueItem(item.id, "remove"));
    const steer = document.createElement("button");
    steer.type = "button";
    steer.className = "queue-action";
    steer.textContent = "↑";
    steer.title = "插话发送此消息";
    steer.setAttribute("aria-label", "插话发送此消息");
    steer.disabled = summary?.running !== true;
    steer.addEventListener("click", () => updateQueueItem(item.id, "steer"));
    actions.append(edit, remove, steer);
    row.appendChild(actions);
    list.appendChild(row);
  }
  $("btn-steer-all").classList.toggle("hidden", !(summary?.running === true && items.length > 1));
  $("input").placeholder = summary?.running === true && items.length > 0 ? "Cmd/Ctrl+Enter 插话发送全部排队消息" : "描述你想要构建的内容";
}

function renderStatusLine() {
  const summary = currentSummary();
  $("current-session-title").textContent = sessionLabel(summary);
  if (summary === undefined) {
    $("session-status").textContent = "选择或新建会话";
    renderActivity(undefined);
    renderQueue(undefined);
    syncComposer();
    return;
  }
  const queue = summary.activity?.queueLength ?? 0;
  const elapsed = summary.running && turnStartedAt !== null ? ` · ${formatDuration(Date.now() - turnStartedAt)}` : "";
  $("session-status").textContent = summary.running ? `${workingPhase ?? "运行中"}${elapsed}${queue > 0 ? ` · ${queue} 条排队` : " · 可继续发送"}` : `空闲 · ${currentWorkspaceName(summary.workspaceId)}`;
  $("btn-cancel").classList.toggle("hidden", !summary.running);
  renderActivity(summary);
  renderQueue(summary);
  syncComposer();
}

function syncComposer() {
  const input = $("input");
  const available = currentSessionId !== null && connection.phase !== "offline";
  input.disabled = !available;
  $("btn-send").disabled = !available || input.value.trim().length === 0;
  for (const id of ["btn-command-menu", "btn-permission", "btn-agent-preset", "btn-model"]) $(id).disabled = !available;
}

async function selectCurrentSession() {
  renderStatusLine();
  if (currentSessionId === null) {
    $("messages").innerHTML = '<div class="empty-tip">打开侧栏新建会话</div>';
    renderControlLabels();
    return;
  }
  await Promise.all([loadHistory(), loadControls()]);
  if (currentSummary()?.running === true && turnStartedAt === null) setWorkingPhase("模型正在处理");
}

function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === undefined || block.type === "text" || block.type === "output_text").map((block) => typeof block?.text === "string" ? block.text : "").filter(Boolean).join("\n");
}

function appendInlineMarkdown(container, value) {
  const pattern = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|`([^`\n]+)`|(https?:\/\/[^\s<]+))/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) container.appendChild(document.createTextNode(value.slice(cursor, match.index)));
    if (match[2] !== undefined) {
      const link = document.createElement("a");
      link.href = match[3];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match[2];
      link.title = match[3];
      container.appendChild(link);
    } else if (match[4] !== undefined || match[5] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[4] ?? match[5];
      container.appendChild(strong);
    } else if (match[6] !== undefined) {
      const del = document.createElement("del");
      del.textContent = match[6];
      container.appendChild(del);
    } else if (match[7] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[7];
      container.appendChild(code);
    } else {
      let url = match[8].replace(/[),.;!?，。；！？、]+$/g, "");
      const trailing = match[8].slice(url.length);
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      try {
        const parsed = new URL(url);
        link.textContent = parsed.hostname + (parsed.pathname.length > 1 ? " / …" : "");
      } catch { link.textContent = url; }
      link.title = url;
      container.appendChild(link);
      if (trailing) container.appendChild(document.createTextNode(trailing));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) container.appendChild(document.createTextNode(value.slice(cursor)));
}

function appendMarkdown(container, markdown) {
  const source = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const html = marked.parse(source);
  container.innerHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["audio", "embed", "iframe", "img", "math", "object", "script", "style", "svg", "video"],
    FORBID_ATTR: ["style", "srcset", "onerror", "onclick", "onload"]
  });
  for (const link of container.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    let parsed;
    try { parsed = href ? new URL(href, location.href) : null; } catch { parsed = null; }
    if (parsed === null || !/^https?:$/i.test(parsed.protocol)) {
      link.removeAttribute("href");
      continue;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = href;
    if (link.textContent === href) {
      try {
        link.textContent = `${parsed.hostname}${parsed.pathname.length > 1 ? " / …" : ""}`;
      } catch {}
    }
  }
}

function redactOperationText(value, limit = 12_000) {
  let text = String(value ?? "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret|authorization|cookie|private[_-]?key)\s*[:=]\s*)([^\s,\n]+)/gi, "$1[redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[private key redacted]");
  if (text.length > limit) text = `${text.slice(0, limit)}\n\n…（内容已截断）`;
  return text;
}

function redactOperationValue(value, depth = 0) {
  if (depth > 8) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactOperationValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      result[key] = /api[_-]?key|token|password|secret|authorization|cookie|private[_-]?key|credential/i.test(key) ? "[redacted]" : redactOperationValue(item, depth + 1);
    }
    return result;
  }
  return typeof value === "string" ? redactOperationText(value) : value;
}

function formatOperationInput(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  try { return redactOperationText(JSON.stringify(redactOperationValue(JSON.parse(value)), null, 2)); }
  catch { return redactOperationText(value); }
}

function extractToolResultText(message) {
  const output = [];
  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") { output.push(value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (typeof value !== "object") return;
    if (typeof value.text === "string") output.push(value.text);
    if (value.content !== undefined) visit(value.content);
  };
  visit(message?.content);
  return redactOperationText(output.join("\n").trim());
}

function createOperationNode({ icon, title, subtitle, input, status = "正在执行" }) {
  const details = document.createElement("details");
  details.className = "operation-row running";
  const summary = document.createElement("summary");
  const iconNode = document.createElement("span");
  iconNode.className = "operation-icon";
  iconNode.textContent = icon;
  const copy = document.createElement("span");
  copy.className = "operation-copy";
  const titleNode = document.createElement("strong");
  titleNode.textContent = title;
  copy.appendChild(titleNode);
  if (subtitle) { const subtitleNode = document.createElement("span"); subtitleNode.textContent = subtitle; copy.appendChild(subtitleNode); }
  const statusNode = document.createElement("span");
  statusNode.className = "operation-status";
  statusNode.textContent = status;
  summary.append(iconNode, copy, statusNode);
  const body = document.createElement("div");
  body.className = "operation-body";
  if (input) {
    const label = document.createElement("strong");
    label.textContent = "输入";
    const pre = document.createElement("pre");
    pre.textContent = input;
    body.append(label, pre);
  }
  details.append(summary, body);
  return { details, body, statusNode };
}

function renderToolCall(entry) {
  const event = entry.event;
  const data = event?.data ?? {};
  const view = entry.view?.view ?? {};
  const title = view.title ?? data.name ?? "工具调用";
  const subtitle = view.kind ? `${data.name ?? "工具"} · ${view.kind}` : data.name ?? "工具";
  const node = createOperationNode({ icon: "⚙", title, subtitle, input: formatOperationInput(data.arguments) });
  node.details.dataset.callId = data.callId ?? "";
  return node;
}

function appendToolResult(node, entry) {
  const data = entry.event?.data ?? {};
  const view = entry.view?.view ?? {};
  const resultBlock = data.message?.content?.find?.((item) => item?.type === "tool-result");
  const failed = Boolean(data.error) || resultBlock?.isError === true;
  node.details.classList.remove("running");
  node.details.classList.add(failed ? "failed" : "complete");
  node.statusNode.textContent = failed ? "失败" : "已完成";
  const label = document.createElement("strong");
  label.textContent = view.sources?.length > 0 ? "结果来源" : "结果";
  node.body.appendChild(label);
  if (Array.isArray(view.sources) && view.sources.length > 0) {
    const list = document.createElement("ul");
    list.className = "operation-sources";
    for (const source of view.sources.slice(0, 12)) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.title || source.url;
      link.title = source.url;
      item.appendChild(link);
      list.appendChild(item);
    }
    node.body.appendChild(list);
  } else {
    const text = extractToolResultText(data.message) || data.error?.message || "（工具没有返回文本输出）";
    const pre = document.createElement("pre");
    pre.textContent = text;
    node.body.appendChild(pre);
  }
}

function renderCommandRun(event) {
  const data = event?.data ?? {};
  const title = `/${data.name ?? "command"}`;
  const node = createOperationNode({ icon: "/", title, subtitle: "Harness 命令", input: redactOperationText(data.args ?? "") });
  node.details.dataset.commandId = data.commandId ?? "";
  return node;
}

function appendCommandResult(node, event) {
  const data = event?.data ?? {};
  node.details.classList.remove("running");
  node.details.classList.add(data.kind === "error" ? "failed" : "complete");
  node.statusNode.textContent = data.kind === "error" ? "失败" : "已完成";
  if (data.text) { const label = document.createElement("strong"); label.textContent = "结果"; const pre = document.createElement("pre"); pre.textContent = redactOperationText(data.text); node.body.append(label, pre); }
}

function contextSourceMeta(source) {
  const kind = typeof source?.kind === "string" ? source.kind : "context";
  if (kind === "session-reference") {
    const labels = Array.isArray(source.references) ? source.references.map((item) => item?.label).filter(Boolean) : [];
    return { title: "会话上下文", subtitle: labels.join("、") || "历史引用", icon: "↶" };
  }
  if (kind === "agent-instructions") {
    const paths = Array.isArray(source.changes) ? source.changes.map((item) => item?.path).filter(Boolean) : [];
    return { title: "上下文注入", subtitle: paths.join("、") || "Agent instructions", icon: "↳" };
  }
  if (kind === "plugin") return { title: "插件上下文", subtitle: source.plugin || kind, icon: "↳" };
  if (kind === "skill-invocation") return { title: "Skill 上下文", subtitle: source.name || kind, icon: "↳" };
  return { title: "上下文注入", subtitle: kind, icon: "↳" };
}

function renderReasoning(text, { running = false } = {}) {
  if (!text) return null;
  const node = createOperationNode({ icon: "∿", title: "思考过程", subtitle: "模型推理", status: running ? "思考中" : "已完成" });
  node.details.classList.toggle("running", running);
  node.details.classList.toggle("complete", !running);
  const label = document.createElement("strong");
  label.textContent = "推理内容";
  const pre = document.createElement("pre");
  pre.textContent = text;
  node.body.append(label, pre);
  return { ...node, pre };
}

function renderContextEvent(event) {
  const data = event?.data ?? {};
  const content = blocksToText(data.content ?? data.message?.content);
  if (!content) return null;
  const meta = contextSourceMeta(data.source);
  const node = createOperationNode({ ...meta, input: redactOperationText(content), status: "已注入" });
  node.details.classList.remove("running");
  node.details.classList.add("complete", "context-row");
  return node.details;
}

function addMessageActions(box, text, { seq, canFork = false } = {}) {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-action";
  copy.textContent = "⧉";
  copy.title = "复制消息";
  copy.setAttribute("aria-label", "复制消息");
  copy.addEventListener("click", () => copyMessage(text));
  actions.appendChild(copy);
  if (canFork && Number.isSafeInteger(seq)) {
    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "message-action branch-action";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const stem = document.createElementNS("http://www.w3.org/2000/svg", "path");
    stem.setAttribute("d", "M6 3v12");
    const curve = document.createElementNS("http://www.w3.org/2000/svg", "path");
    curve.setAttribute("d", "M18 9a9 9 0 0 1-9 9");
    const source = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    source.setAttribute("cx", "18");
    source.setAttribute("cy", "6");
    source.setAttribute("r", "3");
    const target = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    target.setAttribute("cx", "6");
    target.setAttribute("cy", "18");
    target.setAttribute("r", "3");
    icon.append(stem, curve, source, target);
    fork.appendChild(icon);
    fork.title = "从此处新建对话分支";
    fork.setAttribute("aria-label", "从此处新建对话分支");
    fork.addEventListener("click", () => forkFromMessage(seq));
    actions.appendChild(fork);
  }
  box.appendChild(actions);
}

function renderEvent(event, options = {}) {
  const box = document.createElement("div");
  const type = event?.type;
  const data = event?.data ?? {};
  if (type === "user/message") {
    if (data.source !== undefined && data.source?.kind !== "user") return renderContextEvent(event);
    box.className = "msg user";
    const content = blocksToText(data.content) || "（空）";
    appendMarkdown(box, content);
    addMessageActions(box, content, options);
  } else if (type === "assistant/message") {
    const text = blocksToText(data.message?.content ?? data.content);
    if (!text) return null;
    box.className = "msg assistant";
    appendMarkdown(box, text);
    addMessageActions(box, text, options);
  } else return null;
  return box;
}

async function copyMessage(text) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else { const input = document.createElement("textarea"); input.value = text; input.style.position = "fixed"; input.style.opacity = "0"; document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove(); }
    toast("已复制");
  } catch { toast("复制失败，请长按消息文本复制"); }
}

async function forkFromMessage(atSeq) {
  if (currentSessionId === null) return;
  try {
    const result = await api("/fork", { method: "POST", body: { sessionId: currentSessionId, atSeq } });
    toast("已创建新的对话分支");
    await refresh({ quiet: true });
    await chooseSession(result.sessionId);
  } catch (error) { toast(String(error.message ?? error)); }
}

function textDelta(event) {
  const chunk = event?.data?.chunk;
  if (chunk?.type !== "text-delta" || typeof chunk.text !== "string") return "";
  return chunk.text;
}

function applyPartialChunk(blocks, chunk) {
  if (chunk === null || typeof chunk !== "object" || !Number.isSafeInteger(chunk.index)) return;
  if (chunk.type === "block-start") {
    blocks.set(chunk.index, { type: chunk.blockType, text: "", name: "", callId: "", arguments: "" });
    return;
  }
  if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
    const type = chunk.type === "text-delta" ? "text" : "reasoning";
    const block = blocks.get(chunk.index) ?? { type, text: "", name: "", callId: "", arguments: "" };
    block.type = type;
    block.text += typeof chunk.text === "string" ? chunk.text : "";
    blocks.set(chunk.index, block);
    return;
  }
  if (chunk.type === "tool-call-delta") {
    const block = blocks.get(chunk.index) ?? { type: "tool-call", text: "", name: "", callId: "", arguments: "" };
    block.type = "tool-call";
    if (typeof chunk.id === "string" && chunk.id) block.callId = chunk.id;
    if (typeof chunk.name === "string" && chunk.name) block.name = chunk.name;
    block.arguments += typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : "";
    blocks.set(chunk.index, block);
    return;
  }
  if (chunk.type === "block-end" && chunk.block !== null && typeof chunk.block === "object") {
    if (chunk.block.type === "text" || chunk.block.type === "reasoning") blocks.set(chunk.index, { type: chunk.block.type, text: chunk.block.text ?? "", name: "", callId: "", arguments: "" });
    else if (chunk.block.type === "tool-call") blocks.set(chunk.index, { type: "tool-call", text: "", name: chunk.block.name ?? "", callId: chunk.block.id ?? "", arguments: chunk.block.arguments ?? "" });
  }
}

function appendPartialBlocks(container, blocks, { running = true } = {}) {
  let rendered = 0;
  for (const [, block] of [...blocks].sort((a, b) => a[0] - b[0])) {
    if (block.type === "reasoning" && block.text) {
      const node = renderReasoning(block.text, { running });
      if (node !== null) { container.appendChild(node.details); rendered += 1; }
    } else if (block.type === "text" && block.text) {
      const box = renderEvent({ type: "assistant/message", data: { message: { content: [{ type: "text", text: block.text }] } } });
      if (box !== null) { container.appendChild(box); rendered += 1; }
    } else if (block.type === "tool-call" && (block.name || block.arguments)) {
      const node = createOperationNode({ icon: "⚙", title: block.name || "工具调用", subtitle: "模型正在准备工具", input: formatOperationInput(block.arguments), status: running ? "准备中" : "待执行" });
      node.details.classList.toggle("running", running);
      node.details.dataset.callId = block.callId;
      container.appendChild(node.details);
      rendered += 1;
    }
  }
  return rendered;
}

function messagesNearBottom() {
  const container = $("messages");
  return container.scrollHeight - container.scrollTop - container.clientHeight < 90;
}

function appendLiveNode(node) {
  const container = $("messages");
  if (container.querySelector(".empty-tip")) container.innerHTML = "";
  const follow = messagesNearBottom();
  container.appendChild(node);
  if (follow) container.scrollTop = container.scrollHeight;
}

function resetLiveRendering() {
  if (liveRenderFrame !== null) cancelAnimationFrame(liveRenderFrame);
  liveRenderFrame = null;
  liveBlocks = new Map();
  liveToolNodes = new Map();
  liveCommandNodes = new Map();
}

function scheduleLivePaint() {
  if (liveRenderFrame !== null) return;
  liveRenderFrame = requestAnimationFrame(() => {
    liveRenderFrame = null;
    const container = $("messages");
    const follow = messagesNearBottom();
    if (container.querySelector(".empty-tip")) container.innerHTML = "";
    for (const block of liveBlocks.values()) {
      if (!block.dirty) continue;
      block.dirty = false;
      if (block.type === "text") {
        if (block.node === null && block.text) {
          block.node = document.createElement("div");
          block.node.className = "msg assistant streaming";
          container.appendChild(block.node);
        }
        if (block.node !== null) block.node.textContent = block.text;
      } else if (block.type === "reasoning") {
        if (block.node === null && block.text) {
          const rendered = renderReasoning(block.text, { running: !block.complete });
          if (rendered !== null) { block.node = rendered; container.appendChild(rendered.details); }
        } else if (block.node !== null) {
          block.node.pre.textContent = block.text;
          block.node.details.classList.toggle("running", !block.complete);
          block.node.details.classList.toggle("complete", block.complete);
          block.node.statusNode.textContent = block.complete ? "已完成" : "思考中";
        }
      } else if (block.type === "tool-call") {
        if (block.node === null && (block.name || block.arguments)) {
          const rendered = createOperationNode({ icon: "⚙", title: block.name || "工具调用", subtitle: "模型正在准备工具", input: "", status: block.complete ? "待执行" : "准备中" });
          const label = document.createElement("strong");
          label.textContent = "输入";
          const pre = document.createElement("pre");
          rendered.body.append(label, pre);
          rendered.details.dataset.callId = block.callId;
          block.node = { ...rendered, pre };
          container.appendChild(rendered.details);
          if (block.callId) liveToolNodes.set(block.callId, rendered);
        }
        if (block.node !== null) {
          block.node.pre.textContent = formatOperationInput(block.arguments);
          block.node.details.dataset.callId = block.callId;
          block.node.statusNode.textContent = block.complete ? "待执行" : "准备中";
          if (block.callId) liveToolNodes.set(block.callId, block.node);
        }
      }
    }
    if (follow) container.scrollTop = container.scrollHeight;
  });
}

function applyLiveChunk(event) {
  const chunk = event?.data?.chunk;
  if (chunk === null || typeof chunk !== "object" || !Number.isSafeInteger(chunk.index)) return;
  const key = `${event.data?.turn ?? 0}:${event.data?.step ?? 0}:${chunk.index}`;
  let block = liveBlocks.get(key);
  if (chunk.type === "block-start") {
    block = { type: chunk.blockType, text: "", name: "", callId: "", arguments: "", complete: false, dirty: true, node: null };
    liveBlocks.set(key, block);
  } else if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
    const type = chunk.type === "text-delta" ? "text" : "reasoning";
    block ??= { type, text: "", name: "", callId: "", arguments: "", complete: false, dirty: true, node: null };
    block.type = type;
    block.text += typeof chunk.text === "string" ? chunk.text : "";
    block.dirty = true;
    liveBlocks.set(key, block);
  } else if (chunk.type === "tool-call-delta") {
    block ??= { type: "tool-call", text: "", name: "", callId: "", arguments: "", complete: false, dirty: true, node: null };
    block.type = "tool-call";
    if (typeof chunk.id === "string" && chunk.id) block.callId = chunk.id;
    if (typeof chunk.name === "string" && chunk.name) block.name = chunk.name;
    block.arguments += typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : "";
    block.dirty = true;
    liveBlocks.set(key, block);
  } else if (chunk.type === "block-end" && chunk.block !== null && typeof chunk.block === "object") {
    const type = chunk.block.type;
    block ??= { type, text: "", name: "", callId: "", arguments: "", complete: false, dirty: true, node: null };
    block.type = type;
    if (type === "text" || type === "reasoning") block.text = chunk.block.text ?? block.text;
    if (type === "tool-call") { block.name = chunk.block.name ?? block.name; block.callId = chunk.block.id ?? block.callId; block.arguments = chunk.block.arguments ?? block.arguments; }
    block.complete = true;
    block.dirty = true;
    liveBlocks.set(key, block);
  }
  scheduleLivePaint();
}

function setCurrentRunning(running) {
  const summary = currentSummary();
  if (summary === undefined) return;
  summary.running = running;
  renderStatusLine();
}

function appendPendingUserMessage(text) {
  const box = renderEvent({ type: "user/message", data: { content: [{ type: "text", text }], source: { kind: "user" } } });
  if (box === null) return null;
  box.classList.add("pending-message");
  const status = document.createElement("span");
  status.className = "delivery-status";
  status.textContent = "正在发送…";
  box.appendChild(status);
  appendLiveNode(box);
  const pending = { text, box, status };
  pendingOutbound.push(pending);
  return pending;
}

function settlePendingMessage(pending, outcome) {
  if (pending === null || pending === undefined) return;
  pending.box.classList.remove("pending-message");
  pending.box.classList.toggle("failed-message", outcome === "failed");
  pending.status.textContent = outcome === "failed" ? "发送失败" : outcome === "received" ? "Harness 已接收" : "已送达";
  if (outcome === "received") setTimeout(() => pending.status.remove(), 1800);
  if (outcome !== "sent") pendingOutbound = pendingOutbound.filter((item) => item !== pending);
}

async function loadHistory() {
  const sessionId = currentSessionId;
  if (sessionId === null) return;
  if (historyLoading) { historyRefreshPending = true; return; }
  historyLoading = true;
  try {
    const history = await api("/history", { query: { sessionId, maxMessages: 80 } });
    if (sessionId !== currentSessionId) return;
    historyEventSeqs = new Set((history.events ?? []).map((entry) => entry?.event?.seq).filter((seq) => Number.isSafeInteger(seq)));
    const container = $("messages");
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    resetLiveRendering();
    pendingOutbound = [];
    container.innerHTML = "";
    let rendered = 0;
    const partialBlocks = new Map();
    historyActiveTool = null;
    const endedTurns = new Set();
    const lastAssistantSeqByTurn = new Map();
    const toolNodes = new Map();
    const commandNodes = new Map();
    for (const entry of history.events ?? []) {
      const event = entry.event;
      if (event?.type === "turn/end") endedTurns.add(event.data?.turn);
      if (event?.type === "assistant/message") lastAssistantSeqByTurn.set(event.data?.turn, event.seq);
    }
    for (const entry of history.events ?? []) {
      if (entry.event?.type === "assistant/chunk") { applyPartialChunk(partialBlocks, entry.event.data?.chunk); continue; }
      if (entry.event?.type === "tool/call") {
        const node = renderToolCall(entry);
        toolNodes.set(entry.event.data?.callId, node);
        container.appendChild(node.details);
        historyActiveTool = entry.event.data?.name ?? "工具";
        rendered += 1;
        continue;
      }
      if (entry.event?.type === "tool/result") {
        const resultBlock = entry.event.data?.message?.content?.find?.((item) => item?.type === "tool-result");
        const callId = entry.event.data?.message?.source?.callId ?? resultBlock?.toolCallId;
        let node = toolNodes.get(callId);
        if (node === undefined) {
          node = createOperationNode({ icon: "⚙", title: entry.view?.view?.title ?? "工具结果", subtitle: "工具调用" });
          container.appendChild(node.details);
          rendered += 1;
        }
        appendToolResult(node, entry);
        historyActiveTool = null;
        continue;
      }
      if (entry.event?.type === "command/run") {
        const node = renderCommandRun(entry.event);
        commandNodes.set(entry.event.data?.commandId, node);
        container.appendChild(node.details);
        rendered += 1;
        continue;
      }
      if (entry.event?.type === "command/done") {
        let node = commandNodes.get(entry.event.data?.commandId);
        if (node === undefined) {
          node = createOperationNode({ icon: "/", title: "Harness 命令", subtitle: "命令结果" });
          container.appendChild(node.details);
          rendered += 1;
        }
        appendCommandResult(node, entry.event);
        continue;
      }
      if (entry.event?.type === "turn/end") { historyActiveTool = null; continue; }
      if (entry.event?.type === "assistant/message") {
        partialBlocks.clear();
        const content = entry.event.data?.message?.content ?? entry.event.data?.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block?.type !== "reasoning" || typeof block.text !== "string" || block.text.length === 0) continue;
          const node = renderReasoning(block.text);
          if (node !== null) { container.appendChild(node.details); rendered += 1; }
        }
      }
      const event = entry.event;
      const turn = event?.data?.turn;
      const canFork = event?.type === "assistant/message" && endedTurns.has(turn) && lastAssistantSeqByTurn.get(turn) === event.seq;
      const box = renderEvent(event, { seq: event?.seq, canFork });
      if (box !== null) { container.appendChild(box); rendered += 1; }
    }
    rendered += appendPartialBlocks(container, partialBlocks, { running: currentSummary()?.running === true });
    renderActivity(currentSummary());
    if (rendered === 0) container.innerHTML = '<div class="empty-tip">输入任务开始对话</div>';
    else if (atBottom) container.scrollTop = container.scrollHeight;
  } catch (error) {
    if (state !== null) setConnection("offline", `历史同步失败：${String(error.message ?? error)}`);
  } finally {
    historyLoading = false;
    const backlog = liveEventBacklog;
    liveEventBacklog = [];
    for (const payload of backlog) handleRealtimePayload(payload, true);
    if (historyRefreshPending) { historyRefreshPending = false; scheduleHistoryRefresh(0); }
  }
}

async function pollWhileRunning() {
  if (polling) return;
  polling = true;
  try {
    while (currentSummary()?.running === true) {
      await sleep(4_000);
      const realtimeHealthy = eventSource?.readyState === EventSource.OPEN && Date.now() - lastRealtimeEventAt < 8_000;
      if (realtimeHealthy) continue;
      if (!await refresh({ quiet: true })) break;
      await loadHistory();
    }
  } finally { polling = false; renderStatusLine(); }
}

async function sendPrompt() {
  const text = $("input").value.trim();
  if (!text || currentSessionId === null) return syncComposer();
  $("input").value = "";
  $("btn-send").disabled = true;
  const pending = appendPendingUserMessage(text);
  setCurrentRunning(true);
  setWorkingPhase("正在发送消息");
  try {
    await api("/prompt", { method: "POST", body: { sessionId: currentSessionId, text } });
    settlePendingMessage(pending, "sent");
    setWorkingPhase("等待模型响应");
    setTimeout(() => {
      if (pendingOutbound.includes(pending) && Date.now() - lastRealtimeEventAt > 1_500) scheduleHistoryRefresh(0);
    }, 1_600);
    void pollWhileRunning();
  } catch (error) { settlePendingMessage(pending, "failed"); finishWorking(); setCurrentRunning(false); toast(String(error.message ?? error)); await refresh({ quiet: true }); }
  finally { syncComposer(); }
}

async function cancelTurn() {
  if (currentSessionId === null) return;
  try { await api("/cancel", { method: "POST", body: { sessionId: currentSessionId } }); toast("已请求停止"); await refresh({ quiet: true }); }
  catch (error) { toast(String(error.message ?? error)); }
}

async function updateQueueItem(itemId, action, text) {
  if (currentSessionId === null) return;
  try {
    await api("/queue", { method: "POST", body: { sessionId: currentSessionId, itemId, action, ...(action === "edit" ? { text } : {}) } });
    toast(action === "remove" ? "已删除排队消息" : action === "steer" ? "已插话发送" : "排队消息已更新");
    await refresh({ quiet: true });
  } catch (error) { toast(String(error.message ?? error)); }
}

function openQueueEditor(item) {
  if (item.editable !== true) return toast("包含非文本内容的排队消息不能在手机上编辑");
  openSheet("编辑排队消息", "保存后会继续留在当前队列位置", (content) => {
    const textarea = document.createElement("textarea");
    textarea.className = "queue-editor";
    textarea.value = item.text ?? "";
    textarea.rows = 5;
    content.appendChild(textarea);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary full queue-save";
    save.textContent = "保存修改";
    save.addEventListener("click", async () => { closeSheet(); await updateQueueItem(item.id, "edit", textarea.value); });
    content.appendChild(save);
    textarea.focus();
  });
}

async function steerAll() {
  const items = queueItemsFor();
  if (items.length === 0) return;
  for (const item of items) {
    try { await api("/queue", { method: "POST", body: { sessionId: currentSessionId, itemId: item.id, action: "steer" } }); }
    catch (error) { toast(String(error.message ?? error)); break; }
  }
  await refresh({ quiet: true });
}

async function createSession() {
  try {
    const created = await api("/create-session", { method: "POST", body: {} });
    await refresh({ quiet: true });
    await chooseSession(created.sessionId);
  } catch (error) { toast(String(error.message ?? error)); }
}

async function loadControls(force = false) {
  const sessionId = currentSessionId;
  if (sessionId === null) return;
  if (!force && controls?.session?.sessionId === sessionId) return renderControlLabels();
  try {
    const result = await api("/session-controls", { query: { sessionId } });
    if (sessionId !== currentSessionId) return;
    controls = result;
    renderControlLabels();
  } catch (error) {
    controls = null;
    renderControlLabels();
    toast(`会话控制读取失败：${String(error.message ?? error)}`);
  }
}

function titleCase(value) {
  return String(value ?? "").split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function renderControlLabels() {
  const permission = controls?.permissions?.currentValue;
  $("permission-label").textContent = PERMISSION_NAMES[permission] ?? (permission ? titleCase(permission) : "权限");
  const preset = controls?.session?.agentPreset;
  const presetInfo = (controls?.agentPresets ?? []).find((item) => item.id === preset);
  $("agent-preset-label").textContent = presetInfo?.name ?? MODE_NAMES[preset] ?? (preset ? titleCase(preset) : "模式");
  const current = controls?.models?.current;
  if (!current) $("model-label").textContent = "选择模型";
  else {
    const group = (controls.models.groups ?? []).find((item) => item.id === current.provider);
    const model = group?.models?.find((item) => item.id === current.model);
    const effort = model?.reasoning?.efforts?.find((item) => item.id === current.reasoningEffort)?.name ?? current.reasoningEffort;
    $("model-label").textContent = `${model?.name ?? current.model}${effort ? ` · ${effort}` : ""}`;
  }
}

function closeCommandMenu() {
  $("command-menu").classList.add("hidden");
  $("popover-scrim").classList.add("hidden");
  $("btn-command-menu").setAttribute("aria-expanded", "false");
}

function openCommandMenu() {
  const list = $("command-list");
  list.innerHTML = "";
  for (const command of controls?.commands ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-item";
    button.setAttribute("role", "menuitem");
    const slash = document.createElement("span");
    slash.className = "command-slash";
    slash.textContent = "/";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = command.name;
    const description = document.createElement("span");
    description.textContent = command.description;
    copy.append(name, description);
    button.append(slash, copy);
    button.addEventListener("click", () => handleCommand(command));
    list.appendChild(button);
  }
  if (list.childElementCount === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.style.padding = "12px";
    empty.textContent = "当前会话没有可用命令";
    list.appendChild(empty);
  }
  $("command-menu").classList.remove("hidden");
  $("popover-scrim").classList.remove("hidden");
  $("btn-command-menu").setAttribute("aria-expanded", "true");
}

async function handleCommand(command) {
  closeCommandMenu();
  if (currentSessionId === null) return;
  if (command.action === "permission") return openPermissionSheet();
  if (command.action === "model") return openModelSheet();
  if (command.action === "download") {
    location.href = `/mobile-api/export?sessionId=${encodeURIComponent(currentSessionId)}`;
    return toast("正在导出会话日志");
  }
  if (command.action === "insert") {
    $("input").value = `/${command.name} `;
    $("input").focus();
    return syncComposer();
  }
  try {
    await api("/command", { method: "POST", body: { sessionId: currentSessionId, line: `/${command.name}` } });
    toast(`已执行 /${command.name}`);
    await Promise.all([refresh({ quiet: true }), loadHistory(), loadControls(true)]);
  } catch (error) { toast(String(error.message ?? error)); }
}

function openSheet(title, subtitle, render) {
  $("sheet-title").textContent = title;
  $("sheet-subtitle").textContent = subtitle ?? "";
  const content = $("sheet-content");
  content.innerHTML = "";
  render(content);
  $("sheet-layer").classList.remove("hidden");
  $("sheet-layer").setAttribute("aria-hidden", "false");
}

function closeSheet() {
  $("sheet-layer").classList.add("hidden");
  $("sheet-layer").setAttribute("aria-hidden", "true");
}

function optionRow(name, description, selected, onClick, { disabled = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "option-row";
  button.disabled = disabled;
  const copy = document.createElement("span");
  copy.className = "option-copy";
  const strong = document.createElement("strong");
  strong.textContent = name;
  copy.appendChild(strong);
  if (description) {
    const detail = document.createElement("span");
    detail.textContent = description;
    copy.appendChild(detail);
  }
  const check = document.createElement("span");
  check.className = "option-check";
  check.textContent = selected ? "✓" : "";
  button.append(copy, check);
  if (!disabled) button.addEventListener("click", onClick);
  return button;
}

function openPermissionSheet() {
  const permissions = controls?.permissions;
  openSheet("许可批准", "为当前会话选择文件系统沙箱与批准策略", (content) => {
    for (const option of permissions?.options ?? []) {
      const name = option.name ?? PERMISSION_NAMES[option.value] ?? titleCase(option.value);
      content.appendChild(optionRow(name, option.description, option.value === permissions.currentValue, () => {
        closeSheet();
        if (option.value === "danger-full-access") openDangerConfirmation(option.value);
        else void setPermission(option.value);
      }));
    }
    if ((permissions?.options ?? []).length === 0) content.appendChild(optionRow("当前不可用", "Harness 未向此会话提供权限预设", false, () => {}, { disabled: true }));
  });
}

function openDangerConfirmation(preset) {
  pendingDangerPreset = preset;
  $("confirm-checkbox").checked = false;
  $("btn-confirm-danger").disabled = true;
  $("confirm-layer").classList.remove("hidden");
  $("confirm-layer").setAttribute("aria-hidden", "false");
}

function closeDangerConfirmation() {
  pendingDangerPreset = null;
  $("confirm-layer").classList.add("hidden");
  $("confirm-layer").setAttribute("aria-hidden", "true");
}

async function setPermission(preset) {
  if (currentSessionId === null) return;
  try {
    await api("/permission", { method: "POST", body: { sessionId: currentSessionId, preset } });
    toast("权限预设已更新");
    await loadControls(true);
  } catch (error) { toast(String(error.message ?? error)); }
}

function openAgentPresetSheet() {
  const current = controls?.session?.agentPreset;
  const locked = controls?.session?.blank !== true;
  openSheet("Agent 模式", locked ? "已有对话的会话不能更换工具组合；新建空白会话后可选择" : "选择当前空白会话使用的 Agent 工具组合", (content) => {
    for (const preset of controls?.agentPresets ?? []) {
      const name = preset.name ?? MODE_NAMES[preset.id] ?? titleCase(preset.id);
      const reason = preset.broken ?? preset.description ?? (preset.trust === "user" ? "本地自定义模式" : "系统模式");
      content.appendChild(optionRow(name, reason, preset.id === current, () => void setAgentPreset(preset.id), { disabled: locked || Boolean(preset.broken) }));
    }
  });
}

async function setAgentPreset(agentPreset) {
  if (currentSessionId === null) return;
  closeSheet();
  try {
    await api("/agent-preset", { method: "POST", body: { sessionId: currentSessionId, agentPreset } });
    toast("Agent 模式已更新");
    await Promise.all([refresh({ quiet: true }), loadControls(true)]);
  } catch (error) { toast(String(error.message ?? error)); }
}

function openModelSheet() {
  const models = controls?.models;
  openSheet("模型选择", models?.routable === false ? "当前会话的模型路由不可用" : "选择模型；支持的模型还可选择推理强度", (content) => {
    for (const group of models?.groups ?? []) {
      const heading = document.createElement("div");
      heading.className = "provider-title";
      heading.textContent = group.name ?? group.id;
      content.appendChild(heading);
      for (const model of group.models ?? []) {
        const current = models.current?.provider === group.id && models.current?.model === model.id;
        const efforts = model.reasoning?.efforts ?? [];
        const description = model.description ?? (efforts.length > 0 ? "可选择推理强度" : "");
        content.appendChild(optionRow(model.name ?? model.id, description, current, () => {
          if (efforts.length > 0) openReasoningSheet(group, model);
          else void setModel(group.id, model.id);
        }, { disabled: models.routable === false }));
      }
    }
    if ((models?.groups ?? []).length === 0) content.appendChild(optionRow("没有可用模型", "请先在电脑端配置模型提供方", false, () => {}, { disabled: true }));
  });
}

function openReasoningSheet(group, model) {
  const current = controls?.models?.current;
  const efforts = model.reasoning?.efforts ?? [];
  openSheet(model.name ?? model.id, "选择推理强度", (content) => {
    for (const effort of efforts) {
      const selected = current?.provider === group.id && current?.model === model.id && current?.reasoningEffort === effort.id;
      content.appendChild(optionRow(effort.name ?? titleCase(effort.id), effort.description, selected, () => void setModel(group.id, model.id, effort.id)));
    }
  });
}

async function setModel(provider, model, reasoningEffort) {
  if (currentSessionId === null) return;
  closeSheet();
  try {
    await api("/model", { method: "POST", body: { sessionId: currentSessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } });
    toast("模型已更新");
    await loadControls(true);
  } catch (error) { toast(String(error.message ?? error)); }
}

function renderWorkspace(workspace) {
  const select = $("workspace-select");
  select.innerHTML = "";
  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Harness 默认工作区";
  select.appendChild(automatic);
  for (const item of workspace?.options ?? []) {
    const option = document.createElement("option");
    option.value = item.workspaceId;
    option.textContent = item.title;
    select.appendChild(option);
  }
  select.value = workspace?.defaultWorkspaceId ?? "";
  const editable = workspace?.selectable === true;
  select.disabled = !editable;
  $("btn-save-workspace").disabled = !editable;
  $("workspace-description").textContent = editable ? "只影响本次配对中新建的会话，不修改电脑全局设置。" : workspace?.available === false ? "当前 Harness 未提供工作区服务。" : "工作区选择已被电脑端配置锁定。";
}

function currentWorkspaceName(workspaceId = state?.workspace?.defaultWorkspaceId) {
  return (state?.workspace?.options ?? []).find((item) => item.workspaceId === workspaceId)?.title ?? "Harness 默认工作区";
}

function renderDeviceSession(deviceSession) {
  const expiresAt = Number(deviceSession?.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { $("session-expiry").textContent = "配对失效后需要重新扫码。"; return; }
  const hours = Math.max(1, Math.ceil((expiresAt - Date.now()) / 3_600_000));
  const remaining = hours >= 48 ? `${Math.ceil(hours / 24)} 天` : `${hours} 小时`;
  $("session-expiry").textContent = `配对剩余约 ${remaining}，有效至 ${new Date(expiresAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function renderTheme() {
  const preference = window.DSHTheme?.get?.() ?? "system";
  $("theme-select").value = preference;
  $("theme-description").textContent = preference === "system" ? "当前跟随手机系统。" : preference === "light" ? "浅色模式使用明亮背景与深色文字。" : "深色模式使用高对比文字和图标。";
}

async function saveWorkspace() {
  try {
    const data = await api("/workspace", { method: "POST", body: { workspaceId: $("workspace-select").value || null } });
    state = { ...state, workspace: data.workspace };
    renderWorkspace(data.workspace);
    renderSessionGroups();
    renderStatusLine();
    toast("默认工作区已更新");
  } catch (error) { toast(String(error.message ?? error)); }
}

function scheduleStateRefresh(delay = 120) {
  if (stateRefreshTimer !== null) clearTimeout(stateRefreshTimer);
  stateRefreshTimer = setTimeout(async () => {
    stateRefreshTimer = null;
    await refresh({ quiet: true });
  }, delay);
}

function scheduleHistoryRefresh(delay = 100) {
  if (historyRefreshTimer !== null) clearTimeout(historyRefreshTimer);
  historyRefreshTimer = setTimeout(async () => {
    historyRefreshTimer = null;
    if (historyRefreshRunning) { historyRefreshPending = true; return; }
    historyRefreshRunning = true;
    try { await loadHistory(); }
    finally {
      historyRefreshRunning = false;
      if (historyRefreshPending) { historyRefreshPending = false; scheduleHistoryRefresh(0); }
    }
  }, delay);
}

function currentActivity() {
  return currentSummary()?.activity;
}

function applyAuxiliaryFrame(payload) {
  const activity = currentActivity();
  if (activity === undefined) return;
  if (payload.type === "session/queue") {
    activity.queueItems = (Array.isArray(payload.items) ? payload.items : []).map((item) => {
      const content = Array.isArray(item?.message?.content) ? item.message.content : [];
      return { id: item.id, placement: item.placement, text: blocksToText(content), editable: content.length > 0 && content.every((block) => block?.type === "text") };
    }).filter((item) => typeof item.id === "string");
    activity.queueLength = activity.queueItems.filter((item) => item.placement === "queued").length;
  } else if (payload.type === "session/jobs") activity.jobs = Array.isArray(payload.jobs) ? payload.jobs.length : 0;
  else if (payload.type === "approval/requested") activity.pendingApproval = { toolName: payload.toolName, reason: payload.reason };
  else if (payload.type === "approval/resolved") activity.pendingApproval = void 0;
  renderStatusLine();
}

function appendRealtimeNode(node) {
  if (node === null) return;
  appendLiveNode(node);
}

function handleRealtimePayload(payload, replay = false) {
  if (payload === null || typeof payload !== "object" || payload.sessionId !== currentSessionId) return;
  if (historyLoading && !replay) { liveEventBacklog.push(payload); return; }
  lastRealtimeEventAt = Date.now();
  if (payload.type !== "session/event") { applyAuxiliaryFrame(payload); if (["session/queue", "session/jobs", "approval/requested", "approval/resolved"].includes(payload.type)) return; }
  const event = payload.event;
  if (event === null || typeof event !== "object") return;
  if (replay && Number.isSafeInteger(event.seq) && historyEventSeqs.has(event.seq)) return;
  const type = event.type;
  if (type === "assistant/chunk") {
    setCurrentRunning(true);
    const chunkType = event.data?.chunk?.type;
    if (chunkType === "reasoning-delta") setWorkingPhase("正在思考");
    else if (chunkType === "text-delta") setWorkingPhase("正在生成回复");
    else if (chunkType === "tool-call-delta") setWorkingPhase("正在准备工具", { tool: event.data?.chunk?.name ?? workingTool });
    applyLiveChunk(event);
    return;
  }
  if (type === "turn/start" || type === "step/start") {
    setCurrentRunning(true);
    setWorkingPhase(type === "turn/start" ? "正在分析任务" : "正在准备模型请求", { startedAt: event.time });
    return;
  }
  if (type === "user/message") {
    const content = blocksToText(event.data?.content ?? event.data?.message?.content);
    if (event.data?.source?.kind === "user") {
      const pending = pendingOutbound.find((item) => item.text === content);
      if (pending !== undefined) { settlePendingMessage(pending, "received"); return; }
    } else setWorkingPhase("正在注入上下文");
    appendRealtimeNode(renderEvent(event, { seq: event.seq }));
    return;
  }
  if (type === "tool/call") {
    const callId = event.data?.callId;
    const toolName = event.data?.name ?? "工具";
    const activity = currentActivity();
    if (activity !== undefined) activity.activeTool = toolName;
    setWorkingPhase("正在执行工具", { tool: toolName });
    let node = liveToolNodes.get(callId);
    if (node === undefined) {
      node = renderToolCall({ event, view: payload.view });
      liveToolNodes.set(callId, node);
      appendRealtimeNode(node.details);
    } else {
      node.details.classList.add("running");
      node.details.classList.remove("complete", "failed");
      node.statusNode.textContent = "正在执行";
    }
    return;
  }
  if (type === "tool/result") {
    const resultBlock = event.data?.message?.content?.find?.((item) => item?.type === "tool-result");
    const callId = event.data?.message?.source?.callId ?? resultBlock?.toolCallId;
    let node = liveToolNodes.get(callId);
    if (node === undefined) {
      node = createOperationNode({ icon: "⚙", title: "工具结果", subtitle: "工具调用" });
      appendRealtimeNode(node.details);
      liveToolNodes.set(callId, node);
    }
    appendToolResult(node, { event, view: payload.view });
    const activity = currentActivity();
    if (activity !== undefined) activity.activeTool = void 0;
    setWorkingPhase("正在处理工具结果");
    return;
  }
  if (type === "command/run") {
    const node = renderCommandRun(event);
    liveCommandNodes.set(event.data?.commandId, node);
    appendRealtimeNode(node.details);
    return;
  }
  if (type === "command/done") {
    const node = liveCommandNodes.get(event.data?.commandId);
    if (node !== undefined) appendCommandResult(node, event);
    else {
      const fallback = createOperationNode({ icon: "/", title: "Harness 命令", subtitle: "命令结果" });
      appendCommandResult(fallback, event);
      appendRealtimeNode(fallback.details);
    }
    return;
  }
  if (type === "assistant/message") { setWorkingPhase("正在整理回复"); return; }
  if (type === "turn/end") {
    setCurrentRunning(false);
    const elapsed = finishWorking();
    const activity = currentActivity();
    const completedAt = Date.now();
    if (activity !== undefined) { activity.activeTool = void 0; activity.lastCompletedAt = completedAt; }
    lastCompletionAt = completedAt;
    toast(elapsed === null ? "任务已完成" : `任务已完成 · ${formatDuration(elapsed)}`);
    renderActivity(currentSummary());
    scheduleHistoryRefresh(120);
    scheduleStateRefresh(180);
  }
}

function startSse() {
  stopSse();
  try {
    eventSource = new EventSource("/mobile-api/events");
    eventSource.onopen = () => { lastRealtimeEventAt = Date.now(); setConnection("online", connection.detail, connection.latencyMs); void updateLatency(); };
    eventSource.onmessage = (message) => {
      try { handleRealtimePayload(JSON.parse(message.data)?.payload); } catch {}
    };
    eventSource.onerror = () => { stopSse(); if (state !== null) { setConnection("offline", "实时连接断开，正在自动重连…"); scheduleReconnect(); } };
  } catch { setConnection("offline", "无法建立实时连接，正在自动重连…"); scheduleReconnect(); }
}

function stopSse() { if (eventSource !== null) eventSource.close(); eventSource = null; }

function renderSsh(ssh) {
  const enabled = ssh?.available === true;
  $("nav-ssh").classList.toggle("hidden", !enabled);
  const select = $("ssh-host");
  select.innerHTML = "";
  for (const alias of ssh?.aliases ?? []) { const option = document.createElement("option"); option.value = alias; option.textContent = alias; select.appendChild(option); }
  select.disabled = !enabled;
  $("btn-ssh-run").disabled = !enabled;
  if (!enabled) $("ssh-output").textContent = ssh?.reason ?? "SSH 未针对手机配置。";
}

async function runSsh() {
  if (!state?.ssh?.available) return toast("SSH 未针对手机启用");
  const host = $("ssh-host").value;
  const command = $("ssh-command").value;
  if (!host || !command.trim()) return toast("请选择主机并输入命令");
  const output = $("ssh-output");
  const badge = $("ssh-exit");
  $("btn-ssh-run").disabled = true;
  $("ssh-output-title").textContent = `执行中 @${host}`;
  badge.className = "badge hidden";
  output.textContent = `$ ${command}\n…`;
  try {
    const data = await api("/ssh", { method: "POST", body: { host, command, timeoutMs: (Number($("ssh-timeout").value) || 60) * 1_000, workdir: $("ssh-workdir").value.trim() || undefined } });
    const result = data.result ?? {};
    let text = result.stdout?.text ?? "";
    if ((result.stderr?.text ?? "").length > 0) text += `${text.endsWith("\n") ? "" : "\n"}[stderr]\n${result.stderr.text}`;
    output.textContent = text || "（无输出）";
    badge.className = `badge ${result.exitCode === 0 ? "ok" : "fail"}`;
    badge.textContent = result.timedOut ? "超时" : `退出码 ${result.exitCode}`;
    badge.classList.remove("hidden");
  } catch (error) { badge.className = "badge fail"; badge.textContent = "错误"; badge.classList.remove("hidden"); output.textContent = String(error.message ?? error); }
  finally { $("btn-ssh-run").disabled = false; $("ssh-output-title").textContent = "输出"; }
}

function openDrawer() {
  renderSessionGroups();
  $("session-drawer").classList.add("open");
  $("session-drawer").setAttribute("aria-hidden", "false");
  $("drawer-scrim").classList.remove("hidden");
}

function closeDrawer() {
  $("session-drawer").classList.remove("open");
  $("session-drawer").setAttribute("aria-hidden", "true");
  $("drawer-scrim").classList.add("hidden");
}

function switchPage(name) {
  for (const page of ["chat", "ssh", "settings"]) $(`${page}-page`).classList.toggle("hidden", page !== name);
  closeDrawer();
}

document.addEventListener("DOMContentLoaded", () => {
  $("btn-login").addEventListener("click", async () => { $("login-error").classList.add("hidden"); try { await tryLogin($("login-token").value); } catch (error) { $("login-error").textContent = String(error.message ?? error); $("login-error").classList.remove("hidden"); } });
  $("login-token").addEventListener("keydown", (event) => { if (event.key === "Enter") $("btn-login").click(); });
  $("btn-refresh").addEventListener("click", () => reconnect());
  $("btn-reconnect").addEventListener("click", () => reconnect());
  $("btn-sidebar").addEventListener("click", openDrawer);
  $("btn-close-sidebar").addEventListener("click", closeDrawer);
  $("drawer-scrim").addEventListener("click", closeDrawer);
  $("btn-drawer-refresh").addEventListener("click", () => refresh());
  $("btn-logout").addEventListener("click", logoutDevice);
  $("btn-logout-settings").addEventListener("click", logoutDevice);
  $("btn-new-session").addEventListener("click", createSession);
  $("session-select").addEventListener("change", () => chooseSession($("session-select").value));
  $("composer-form").addEventListener("submit", (event) => { event.preventDefault(); void sendPrompt(); });
  $("btn-cancel").addEventListener("click", cancelTurn);
  $("input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if ((event.ctrlKey || event.metaKey) && $("input").value.trim() === "" && queueItemsFor().length > 0) void steerAll();
    else void sendPrompt();
  });
  $("input").addEventListener("input", syncComposer);
  $("btn-command-menu").addEventListener("click", () => $("command-menu").classList.contains("hidden") ? openCommandMenu() : closeCommandMenu());
  $("popover-scrim").addEventListener("click", closeCommandMenu);
  $("btn-permission").addEventListener("click", openPermissionSheet);
  $("btn-agent-preset").addEventListener("click", openAgentPresetSheet);
  $("btn-model").addEventListener("click", openModelSheet);
  $("queue-summary").addEventListener("click", () => { queueExpanded = !queueExpanded; renderQueue(); });
  $("btn-steer-all").addEventListener("click", () => void steerAll());
  $("sheet-scrim").addEventListener("click", closeSheet);
  $("btn-close-sheet").addEventListener("click", closeSheet);
  $("confirm-checkbox").addEventListener("change", () => { $("btn-confirm-danger").disabled = !$("confirm-checkbox").checked; });
  $("btn-confirm-cancel").addEventListener("click", closeDangerConfirmation);
  $("btn-confirm-danger").addEventListener("click", () => { const preset = pendingDangerPreset; closeDangerConfirmation(); if (preset) void setPermission(preset); });
  $("btn-save-workspace").addEventListener("click", saveWorkspace);
  $("theme-select").addEventListener("change", () => { window.DSHTheme?.set?.($("theme-select").value); renderTheme(); });
  $("btn-ssh-run").addEventListener("click", runSsh);
  $("ssh-command").addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void runSsh(); });
  for (const button of document.querySelectorAll("[data-page]")) button.addEventListener("click", () => switchPage(button.dataset.page));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeDrawer(); closeSheet(); closeCommandMenu(); closeDangerConfirmation(); } });
  if ("serviceWorker" in navigator) navigator.serviceWorker.getRegistrations().then((items) => Promise.all(items.map((item) => item.unregister()))).catch(() => {});
  renderTheme();
  void reconnect(true);
});
