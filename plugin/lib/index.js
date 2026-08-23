/**
 * Mobile remote-control companion app for dsh.
 *
 * Host-plane plugin serving a phone PWA at `/mobile/` plus a token-guarded
 * REST/SSE API at `/mobile-api/`. The API proxies the host API gateway
 * (`ctx.apiProxy`) in-process — the phone never touches `/api` or its browser
 * trust fence — and SSH execution reuses the `ssh` tool registered by
 * `dsh-tool-ssh` through the host tools registry, so credentials are never
 * duplicated.
 *
 * The app shell and assets are public; every `/mobile-api/` endpoint answers
 * 401 until the profile sets a non-empty `accessToken`.
 *
 * @module dsh-mobile-remote
 */
import z from "@deepseek-ai/schemastery";
import QRCode from "qrcode";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const name = "mobile-remote";
const inject = ["webServer", "apiProxy"];

const Config = z.object({
	/** Legacy inline token; only honored with allowInlineAccessToken: true. */
	accessToken: z.string().default(""),
	/** Environment variable containing the long-lived pairing secret. */
	accessTokenEnv: z.string(),
	allowInlineAccessToken: z.boolean().default(false),
	/** HTTPS origin embedded in a QR code rendered only at localhost/mobile-pair. */
	pairingServerUrl: z.string().default(""),
	/** Optional JSON state file read on every pairing-page request. */
	pairingServerUrlFile: z.string().default(""),
	localPairingQrTtlMs: z.natural().min(60000).max(900000).default(300000),
	title: z.string().default("DSH 远程控制"),
	/** Explicit SSH aliases exposed to the phone. An empty list disables mobile SSH. */
	sshAliases: z.array(z.string()).default([]),
	/** A mobile session is isolated from desktop sessions unless this is enabled. */
	allowExistingSessions: z.boolean().default(false),
	/** Optional default workspace for every session created by this app. */
	workspaceId: z.string(),
	/** Optional workspace allowlist for the phone. An empty list permits every local workspace. */
	workspaceIds: z.array(z.string()).default([]),
	/** Lets the paired phone change its in-memory default workspace within the allowlist. */
	allowWorkspaceSelection: z.boolean().default(true),
	maxHistoryMessages: z.natural().min(1).max(500).default(80),
	maxPromptBytes: z.natural().min(256).max(65536).default(8192),
	maxSshTimeoutMs: z.natural().min(1000).max(300000).default(300000),
	sessionTtlMs: z.natural().min(300000).max(604800000).default(604800000),
	/** Require HTTPS (or a trusted TLS proxy's X-Forwarded-Proto header). */
	requireSecureTransport: z.boolean().default(true)
});

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".ico": "image/x-icon"
};

const sha256 = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);

function parsePairingServerOrigin(value, source) {
	try {
		if (typeof value !== "string" || value.trim().length === 0) throw new Error();
		const parsed = new URL(value.trim());
		if (parsed.protocol !== "https:" || parsed.hostname.length === 0 || parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0 || (parsed.pathname !== "" && parsed.pathname !== "/")) throw new Error();
		return parsed.origin;
	} catch {
		throw new Error(`mobile-remote: ${source} must be an HTTPS origin without a path, query, fragment, or credentials`);
	}
}

function compactHistoryEntries(entries) {
	if (!Array.isArray(entries)) return [];
	const output = [];
	const pending = /* @__PURE__ */ new Map();
	const keyOf = (event) => `${event?.data?.turn ?? ""}:${event?.data?.step ?? ""}`;
	const applyChunk = (record, entry) => {
		const event = entry.event;
		const chunk = event?.data?.chunk;
		if (chunk === null || typeof chunk !== "object" || !Number.isSafeInteger(chunk.index)) return;
		let block = record.blocks.get(chunk.index);
		if (chunk.type === "block-start") block = { type: chunk.blockType, text: "", id: "", name: "", arguments: "", firstSeq: event.seq, lastEntry: entry };
		else if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
			block ??= { type: chunk.type === "text-delta" ? "text" : "reasoning", text: "", id: "", name: "", arguments: "", firstSeq: event.seq, lastEntry: entry };
			block.type = chunk.type === "text-delta" ? "text" : "reasoning";
			block.text += typeof chunk.text === "string" ? chunk.text : "";
		} else if (chunk.type === "tool-call-delta") {
			block ??= { type: "tool-call", text: "", id: "", name: "", arguments: "", firstSeq: event.seq, lastEntry: entry };
			block.type = "tool-call";
			if (typeof chunk.id === "string" && chunk.id) block.id = chunk.id;
			if (typeof chunk.name === "string" && chunk.name) block.name = chunk.name;
			block.arguments += typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : "";
		} else if (chunk.type === "block-end" && chunk.block !== null && typeof chunk.block === "object") {
			const value = chunk.block;
			block = { type: value.type, text: value.text ?? "", id: value.id ?? "", name: value.name ?? "", arguments: value.arguments ?? "", firstSeq: block?.firstSeq ?? event.seq, lastEntry: entry };
		}
		if (block !== void 0) {
			block.lastEntry = entry;
			record.blocks.set(chunk.index, block);
		}
	};
	const flush = (key) => {
		const record = pending.get(key);
		if (record === void 0) return;
		pending.delete(key);
		for (const [index, block] of [...record.blocks].sort((a, b) => a[1].firstSeq - b[1].firstSeq)) {
			let value;
			if (block.type === "text" || block.type === "reasoning") value = { type: block.type, text: block.text };
			else if (block.type === "tool-call") value = { type: "tool-call", id: block.id, name: block.name, arguments: block.arguments };
			else continue;
			const source = block.lastEntry;
			output.push({
				...source,
				event: {
					...source.event,
					data: { ...source.event.data, chunk: { type: "block-end", index, block: value } }
				}
			});
		}
	};
	const flushTurn = (turn) => {
		for (const key of [...pending.keys()]) if (key.startsWith(`${turn}:`)) flush(key);
	};
	for (const entry of entries) {
		const event = entry?.event;
		if (event?.type === "assistant/chunk") {
			const key = keyOf(event);
			let record = pending.get(key);
			if (record === void 0) { record = { blocks: /* @__PURE__ */ new Map() }; pending.set(key, record); }
			applyChunk(record, entry);
			continue;
		}
		const key = keyOf(event);
		if (event?.type === "assistant/message") pending.delete(key);
		else if (event?.type === "step/end") flush(key);
		else if (event?.type === "turn/end") flushTurn(event.data?.turn);
		output.push(entry);
	}
	for (const key of pending.keys()) flush(key);
	return output;
}

const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"permissions-policy": "camera=(), geolocation=(), microphone=()",
	"content-security-policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' blob:; script-src 'self'; style-src 'self'"
};

const MOBILE_COMMANDS = Object.freeze([
	{ name: "compact", description: "压缩较早的会话历史", action: "execute" },
	{ name: "export", description: "下载此会话的 ZIP 日志", action: "download" },
	{ name: "feedback", description: "记录关于本会话的反馈", action: "insert", hint: "<反馈内容>" },
	{ name: "goal", description: "设置或查看长任务目标", action: "insert", hint: "<目标>" },
	{ name: "permission", description: "切换权限预设", action: "permission" },
	{ name: "plan", description: "进入或退出计划模式", action: "insert", hint: "<on|off>" },
	{ name: "model", description: "选择本会话使用的模型", action: "model" }
]);

const MOBILE_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MOBILE_MAX_IMAGES_PER_MESSAGE = 4;
const MOBILE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MOBILE_MAX_MESSAGE_IMAGE_BYTES = 16 * 1024 * 1024;
const MOBILE_MAX_PROMPT_BODY_BYTES = 24 * 1024 * 1024;

function mobileImagePart(value) {
	if (value === null || typeof value !== "object" || value.type !== "image") throw new Error("image entry is invalid");
	if (!MOBILE_IMAGE_MEDIA_TYPES.has(value.mediaType)) throw new Error("image type must be PNG, JPEG, WebP, or GIF");
	if (typeof value.data !== "string" || value.data.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data) || value.data.length % 4 !== 0) throw new Error("image data must be canonical base64");
	const bytes = Buffer.from(value.data, "base64");
	if (bytes.length === 0 || bytes.toString("base64") !== value.data) throw new Error("image data must be canonical base64");
	if (bytes.length > MOBILE_MAX_IMAGE_BYTES) throw new Error(`each image must be at most ${MOBILE_MAX_IMAGE_BYTES} bytes`);
	if (value.name !== void 0 && (typeof value.name !== "string" || value.name.length === 0 || Buffer.byteLength(value.name, "utf8") > 255)) throw new Error("image name is invalid");
	return { part: { type: "image", mediaType: value.mediaType, data: value.data, ...(value.name === void 0 ? {} : { name: value.name }) }, bytes: bytes.length };
}

/** Resolve the optional LLM service without making it a hard plugin dependency. */
function llmService(ctx) {
	try {
		return (typeof ctx.get === "function" ? ctx.get("llm") : void 0) ?? ctx.llm;
	} catch {
		return void 0;
	}
}

function withSecurityHeaders(headers = {}) {
	return { ...SECURITY_HEADERS, ...headers };
}

function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, withSecurityHeaders({
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	}));
	res.end(body);
}

function sendHtml(res, status, body) {
	res.writeHead(status, withSecurityHeaders({
		"content-type": "text/html; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	}));
	res.end(body);
}

/** Read a JSON request body with a 1 MiB cap; rejects on overflow or parse errors. */
function readJsonBody(req, limit = 1 << 20) {
	return new Promise((resolvePromise, rejectPromise) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				rejectPromise(new Error("payload too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			} catch (error) {
				rejectPromise(new Error("body is not JSON"));
			}
		});
		req.on("error", rejectPromise);
	});
}

function apply(ctx, config = {}) {
	const resolveAccessToken = () => {
		if (typeof config.accessTokenEnv === "string" && config.accessTokenEnv.length > 0) return process.env[config.accessTokenEnv] ?? "";
		if (config.allowInlineAccessToken === true && typeof config.accessToken === "string") return config.accessToken;
		return "";
	};
	const token = resolveAccessToken();
	if (token.length > 0 && Buffer.byteLength(token, "utf8") < 32) throw new Error("mobile-remote: access token must be at least 32 bytes; configure accessTokenEnv with a random secret");
	const title = typeof config.title === "string" ? config.title : "DSH 远程控制";
	const maxHistoryMessages = Number.isSafeInteger(config.maxHistoryMessages) ? config.maxHistoryMessages : 80;
	const maxPromptBytes = Number.isSafeInteger(config.maxPromptBytes) ? config.maxPromptBytes : 8192;
	const maxSshTimeoutMs = Number.isSafeInteger(config.maxSshTimeoutMs) ? config.maxSshTimeoutMs : 300000;
	const sessionTtlMs = Number.isSafeInteger(config.sessionTtlMs) ? config.sessionTtlMs : 604800000;
	const localPairingQrTtlMs = Number.isSafeInteger(config.localPairingQrTtlMs) ? config.localPairingQrTtlMs : 300000;
	const requireSecureTransport = config.requireSecureTransport ?? true;
	const allowExistingSessions = config.allowExistingSessions === true;
	const workspaceId = typeof config.workspaceId === "string" && config.workspaceId.length > 0 ? config.workspaceId : void 0;
	const configuredWorkspaceIds = Array.isArray(config.workspaceIds) ? config.workspaceIds.filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()) : [];
	const allowWorkspaceSelection = config.allowWorkspaceSelection !== false;
	if (!Number.isSafeInteger(maxHistoryMessages) || maxHistoryMessages < 1 || maxHistoryMessages > 500) throw new Error("mobile-remote: maxHistoryMessages must be an integer between 1 and 500");
	if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 256 || maxPromptBytes > 65536) throw new Error("mobile-remote: maxPromptBytes must be an integer between 256 and 65536");
	if (!Number.isSafeInteger(maxSshTimeoutMs) || maxSshTimeoutMs < 1000 || maxSshTimeoutMs > 300000) throw new Error("mobile-remote: maxSshTimeoutMs must be an integer between 1000 and 300000");
	if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 300000 || sessionTtlMs > 604800000) throw new Error("mobile-remote: sessionTtlMs must be an integer between 300000 and 604800000");
	if (!Number.isSafeInteger(localPairingQrTtlMs) || localPairingQrTtlMs < 60000 || localPairingQrTtlMs > 900000) throw new Error("mobile-remote: localPairingQrTtlMs must be an integer between 60000 and 900000");
	if (typeof requireSecureTransport !== "boolean") throw new Error("mobile-remote: requireSecureTransport must be a boolean");
	const configuredAliases = Array.isArray(config.sshAliases) ? config.sshAliases.filter((alias) => typeof alias === "string" && alias.trim().length > 0).map((alias) => alias.trim()) : [];
	if (new Set(configuredAliases).size !== configuredAliases.length) throw new Error("mobile-remote: sshAliases must not contain duplicates");
	if (new Set(configuredWorkspaceIds).size !== configuredWorkspaceIds.length) throw new Error("mobile-remote: workspaceIds must not contain duplicates");
	let configuredPairingServerUrl;
	if (typeof config.pairingServerUrl === "string" && config.pairingServerUrl.trim().length > 0) {
		configuredPairingServerUrl = parsePairingServerOrigin(config.pairingServerUrl, "pairingServerUrl");
	}
	const pairingServerUrlFile = typeof config.pairingServerUrlFile === "string" && config.pairingServerUrlFile.trim().length > 0 ? config.pairingServerUrlFile.trim() : void 0;
	if (pairingServerUrlFile?.includes("\0")) throw new Error("mobile-remote: pairingServerUrlFile contains an invalid null character");
	const resolvePairingServerUrl = () => {
		if (pairingServerUrlFile === void 0) return configuredPairingServerUrl;
		let bytes;
		try {
			bytes = readFileSync(pairingServerUrlFile);
		} catch (error) {
			if (error?.code === "ENOENT" && configuredPairingServerUrl !== void 0) return configuredPairingServerUrl;
			throw new Error(`mobile-remote: cannot read pairingServerUrlFile: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (bytes.length > 4096) throw new Error("mobile-remote: pairingServerUrlFile exceeds 4096 bytes");
		let state;
		try {
			state = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new Error("mobile-remote: pairingServerUrlFile is not valid JSON");
		}
		if (state === null || typeof state !== "object" || Array.isArray(state)) throw new Error("mobile-remote: pairingServerUrlFile must contain a JSON object");
		return parsePairingServerOrigin(state.pairingServerUrl, "pairingServerUrlFile.pairingServerUrl");
	};
	const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
	const vendorAssets = new Map([
		["vendor/marked.js", fileURLToPath(import.meta.resolve("marked"))],
		["vendor/dompurify.js", fileURLToPath(import.meta.resolve("dompurify"))]
	]);

	const tokenDigest = sha256(token);
	const pairingTokenMatches = (candidate) => {
		if (token.length === 0 || typeof candidate !== "string" || candidate.length === 0) return false;
		return timingSafeEqual(Buffer.from(sha256(candidate), "hex"), Buffer.from(tokenDigest, "hex"));
	};
	const localPairingCodes = /* @__PURE__ */ new Map();
	const issueLocalPairingCode = () => {
		const now = Date.now();
		for (const [key, expiresAt] of localPairingCodes) if (expiresAt <= now) localPairingCodes.delete(key);
		if (localPairingCodes.size >= 64) localPairingCodes.delete(localPairingCodes.keys().next().value);
		const value = randomBytes(32).toString("base64url");
		localPairingCodes.set(sha256(value), now + localPairingQrTtlMs);
		return value;
	};
	const consumeLocalPairingCode = (candidate) => {
		if (typeof candidate !== "string" || candidate.length === 0) return false;
		const key = sha256(candidate);
		const expiresAt = localPairingCodes.get(key);
		if (expiresAt === void 0 || expiresAt <= Date.now()) {
			localPairingCodes.delete(key);
			return false;
		}
		localPairingCodes.delete(key);
		return true;
	};
	const mobileSessions = /* @__PURE__ */ new Set();
	/** Runtime-only view state bound to the HttpOnly phone session. */
	const authenticatedSessions = /* @__PURE__ */ new Map();
	const sessionRuntime = /* @__PURE__ */ new Map();
	const sessionCookieName = "dsh_mobile_session";
	const parseCookies = (req) => Object.fromEntries(String(req.headers.cookie ?? "").split(";").map((part) => {
		const index = part.indexOf("=");
		if (index < 0) return ["", ""];
		try {
			return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
		} catch {
			return ["", ""];
		}
	}).filter(([key]) => key.length > 0));
	const isSecureTransport = (req) => req.socket?.encrypted === true || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase() === "https";
	const isLoopbackRequest = (req) => {
		const header = String(req.headers.host ?? "").trim().toLowerCase();
		const hostname = header.startsWith("[") ? header.slice(1, header.indexOf("]")) : header.split(":")[0];
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
	};
	const sessionRecord = (req) => {
		const value = parseCookies(req)[sessionCookieName];
		if (typeof value !== "string" || value.length === 0) return void 0;
		const key = sha256(value);
		const record = authenticatedSessions.get(key);
		if (record === void 0 || record.expiresAt <= Date.now()) {
			authenticatedSessions.delete(key);
			return void 0;
		}
		return record;
	};
	const sessionExpiresAt = (req) => sessionRecord(req)?.expiresAt;
	const sessionOf = (req) => sessionRecord(req) !== void 0;
	const cookie = (value, maxAge, secure) => `${sessionCookieName}=${encodeURIComponent(value)}; HttpOnly; Max-Age=${maxAge}; Path=/mobile-api; SameSite=Strict${secure ? "; Secure" : ""}`;
	const startSession = (res, secure) => {
		const value = randomBytes(32).toString("base64url");
		const expiresAt = Date.now() + sessionTtlMs;
		authenticatedSessions.set(sha256(value), { expiresAt, workspaceId });
		res.setHeader("set-cookie", cookie(value, Math.floor(sessionTtlMs / 1000), secure));
		return expiresAt;
	};
	const endSession = (req, res) => {
		const value = parseCookies(req)[sessionCookieName];
		if (typeof value === "string" && value.length > 0) authenticatedSessions.delete(sha256(value));
		res.setHeader("set-cookie", cookie("", 0, isSecureTransport(req)));
	};
	const sessionAllowed = (sessionId) => allowExistingSessions || mobileSessions.has(sessionId);
	const runtimeFor = (sessionId) => {
		let runtime = sessionRuntime.get(sessionId);
		if (runtime === void 0) {
			runtime = { queueLength: 0, queueItems: [], activeTool: void 0, jobs: 0, pendingApproval: void 0, pendingQuestion: void 0, lastCompletedAt: void 0, lastFailure: void 0 };
			sessionRuntime.set(sessionId, runtime);
		}
		return runtime;
	};
	const queueItemView = (item) => {
		if (item === null || typeof item !== "object" || typeof item.id !== "string") return void 0;
		const content = Array.isArray(item.message?.content) ? item.message.content : [];
		const text = content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
		return {
			id: item.id,
			placement: item.placement,
			text,
			editable: content.length > 0 && content.every((block) => block?.type === "text")
		};
	};

	// ── SSH tool discovery ───────────────────────────────────────────────────
	const sshTool = () => {
		const tools = ctx.get("tools");
		if (tools === void 0) return void 0;
		return tools.get("ssh");
	};
	// Do not infer an authorization boundary from prose intended for a model.
	// A phone gets only the aliases explicitly named in this plugin's profile.
	const sshAliases = () => configuredAliases;

	// ── static PWA assets ────────────────────────────────────────────────────
	const assetCache = /* @__PURE__ */ new Map();
	function serveAsset(res, asset) {
		const requested = asset === "" ? "index.html" : asset;
		const normalized = normalize(requested).replace(/\\/g, "/");
		const vendorFile = vendorAssets.get(normalized);
		const file = vendorFile ?? join(distDir, normalized);
		const relativePath = relative(distDir, file);
		if (vendorFile === void 0 && (relativePath.startsWith("..") || relativePath === "" || file === distDir)) {
			sendJson(res, 404, { ok: false, error: "not found" });
			return;
		}
		let entry = assetCache.get(file);
		try {
			const mtime = statSync(file).mtimeMs;
			if (entry === void 0 || entry.mtime !== mtime) {
				entry = { mtime, body: readFileSync(file) };
				assetCache.set(file, entry);
			}
		} catch {
			sendJson(res, 404, { ok: false, error: `asset not found: ${requested}` });
			return;
		}
		res.writeHead(200, withSecurityHeaders({
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"content-length": entry.body.length,
			"cache-control": "no-cache"
		}));
		res.end(entry.body);
	}

	const serveLocalPairingQr = async (req, res) => {
		// The long-lived root token is never rendered. This page exists only on
		// the desktop loopback origin and creates a short-lived, single-use code.
		if (!isLoopbackRequest(req) || token.length === 0) {
			return sendJson(res, 404, { ok: false, error: "not found" });
		}
		let pairingServerUrl;
		try {
			pairingServerUrl = resolvePairingServerUrl();
		} catch (error) {
			return sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error), hint: "局域网端点尚未就绪；请启动 scripts/start-mobile-lan.ps1 后刷新本页。" });
		}
		if (pairingServerUrl === void 0) return sendJson(res, 503, { ok: false, error: "mobile pairing server URL is not configured", hint: "请配置 pairingServerUrlFile 或 pairingServerUrl。" });
		const oneTimeToken = issueLocalPairingCode();
		const pairingUri = `dshmobile://pair?server=${encodeURIComponent(pairingServerUrl)}&token=${encodeURIComponent(oneTimeToken)}`;
		const svg = await QRCode.toString(pairingUri, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
		const expiresMinutes = Math.ceil(localPairingQrTtlMs / 60000);
		const sessionDays = Math.max(1, Math.ceil(sessionTtlMs / 86400000));
		const safeTitle = escapeHtml(title);
		const safeServer = escapeHtml(pairingServerUrl);
		const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="theme-color" content="#f5f6f8"><link rel="stylesheet" href="/mobile/pair.css"><link rel="icon" href="/mobile/icon-192.png" type="image/png"><title>${safeTitle} · 配对手机</title></head><body><main class="pair-shell"><header class="brand"><span class="brand-name">deepseek</span><span class="brand-tag">HARNESS</span><span class="local-pill"><i></i>仅限本机</span></header><section class="pair-card"><div class="copy"><p class="eyebrow">DSH MOBILE</p><h1>把 Harness 安全带到手机上</h1><p class="lead">打开 Android App 扫描二维码，即可查看会话、发送任务并接收实时输出。</p><ol><li><b>打开 DSH Mobile</b><span>点击“扫描电脑二维码”</span></li><li><b>扫描右侧二维码</b><span>一次性使用，约 ${expiresMinutes} 分钟后失效</span></li><li><b>开始远程工作</b><span>配对后最长保持 ${sessionDays} 天</span></li></ol></div><div class="qr-column"><div class="qr-frame">${svg}</div><p class="scan-label">使用 DSH Mobile 扫描</p><code>${safeServer}</code></div></section><aside class="security-note"><span>◆</span><p><b>本地安全边界</b><br>本页仅由 <code>localhost</code> 提供；二维码不包含长期密钥。Harness 重启、主动断开或会话到期后需要重新配对。</p></aside><footer>DSH Mobile · 单用户局域网遥控</footer></main></body></html>`;
		sendHtml(res, 200, page);
	};

	// ── live event fan-out (SSE) ─────────────────────────────────────────────
	const clients = /* @__PURE__ */ new Map();
	ctx.effect(() => {
		const muxAbort = new AbortController();
		(async () => {
			try {
				for await (const frame of ctx.apiProxy.events.mux({
					rpcId: `mobile-${Date.now()}`,
					payload: {}
				}, muxAbort.signal)) {
					const sessionId = frame.payload?.sessionId;
					if (!allowExistingSessions && (typeof sessionId !== "string" || !mobileSessions.has(sessionId))) continue;
					observeRuntimeFrame(frame.payload, frame.rpcId);
					const line = `data: ${JSON.stringify({ type: "server-request", rpcId: frame.rpcId, method: frame.payload?.type, payload: frame.payload })}\n\n`;
					for (const [client, expiresAt] of clients) {
						if (expiresAt <= Date.now()) {
							clients.delete(client);
							try {
								client.end();
							} catch {}
							continue;
						}
						try {
							client.write(line);
						} catch {}
					}
				}
			} catch {}
		})();
		const heartbeat = setInterval(() => {
			for (const [client, expiresAt] of clients) {
				if (expiresAt <= Date.now()) {
					clients.delete(client);
					try {
						client.end();
					} catch {}
					continue;
				}
				try {
					client.write(": ping\n\n");
				} catch {}
			}
		}, 20000);
		heartbeat.unref?.();
		return () => {
			muxAbort.abort();
			clearInterval(heartbeat);
			for (const client of clients.keys()) {
				try {
					client.end();
				} catch {}
			}
			clients.clear();
		};
	});

	// ── gateway adapter ──────────────────────────────────────────────────────
	// The apiProxy domain methods speak the narrow wire request shape
	// `{rpcId, payload}` and answer `{rpcId, result: {ok, value | error}}`.
	let rpcSeq = 0;
	const call = async (domain, payload, signal) => {
		const request = { rpcId: `mobile-${++rpcSeq}-${Date.now()}`, payload };
		const response = await domain(request, signal);
		const result = response?.result;
		if (result === void 0 || result.ok !== true) {
			const error = result?.error;
			const wrapped = new Error(error?.message ?? `gateway call failed (${domain.name ?? "unknown"})`);
			if (error?.code !== void 0) wrapped.code = error.code;
			if (error?.details !== void 0) wrapped.details = error.details;
			throw wrapped;
		}
		return result.value;
	};

	const visibleWorkspaces = async (req) => {
		const record = sessionRecord(req);
		const defaultId = record?.workspaceId ?? workspaceId;
		const domain = ctx.apiProxy.workspace?.list;
		if (typeof domain !== "function") return { available: false, selectable: false, defaultWorkspaceId: defaultId, options: [] };
		const listed = await call(domain, {});
		const items = Array.isArray(listed?.items) ? listed.items : [];
		const options = items
			.filter((item) => configuredWorkspaceIds.length === 0 || configuredWorkspaceIds.includes(item.workspaceId))
			.map((item) => ({
				workspaceId: item.workspaceId,
				title: typeof item.title === "string" && item.title.length > 0 ? item.title : "未命名工作区",
				path: typeof item.path === "string" ? item.path : void 0,
				sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds : []
			}));
		const selectedWorkspaceId = defaultId !== void 0 && options.some((item) => item.workspaceId === defaultId) ? defaultId : void 0;
		return {
			available: true,
			selectable: allowWorkspaceSelection && options.length > 0,
			defaultWorkspaceId: selectedWorkspaceId,
			options,
			archivedSessionIds: Array.isArray(listed?.archivedSessionIds) ? listed.archivedSessionIds : []
		};
	};

	const requireMobileSession = (sessionId) => {
		if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) throw new Error("sessionId is invalid");
		if (!sessionAllowed(sessionId)) {
			const error = new Error("session is outside the mobile-app scope");
			error.code = "mobile-session-forbidden";
			throw error;
		}
		return sessionId;
	};

	const sessionControls = async (sessionId) => {
		requireMobileSession(sessionId);
		const listed = await call(ctx.apiProxy.sessions.list, {});
		const summary = (Array.isArray(listed?.items) ? listed.items : []).find((item) => item.sessionId === sessionId);
		if (summary === void 0) throw new Error("session not found");
		const permissions = summary.projections?.values?.permissions;
		const models = typeof ctx.apiProxy.sessions.models === "function"
			? await call(ctx.apiProxy.sessions.models, { sessionId })
			: { current: void 0, routable: false, groups: [], failures: [] };
		let imageInput;
		const current = models?.current;
		const llm = llmService(ctx);
		if (typeof llm?.resolveModelInfo === "function" && Array.isArray(models?.groups)) {
			models.groups = await Promise.all(models.groups.map(async (group) => ({
				...group,
				models: await Promise.all((group.models ?? []).map(async (model) => {
					try {
						const info = await llm.resolveModelInfo(group.id, model.id);
						return { ...model, ...(Array.isArray(info?.inputModalities) ? { inputModalities: [...info.inputModalities] } : {}) };
					} catch {
						return model;
					}
				}))
			})));
		}
		if (current !== null && typeof current === "object" && typeof llm?.resolveModelInfo === "function") {
			try {
				const selected = models.groups?.find((group) => group.id === current.provider)?.models?.find((model) => model.id === current.model);
				const info = selected?.inputModalities === void 0 ? await llm.resolveModelInfo(current.provider, current.model) : selected;
				const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : void 0;
				imageInput = {
					supported: modalities === void 0 || modalities.includes("image"),
					declared: modalities !== void 0,
					modalities: modalities ?? ["text"]
				};
			} catch {
				// Catalog failures must not make text-only mobile control unavailable.
			}
		}
		const presetResult = typeof ctx.apiProxy.agentPresets?.list === "function"
			? await call(ctx.apiProxy.agentPresets.list, {})
			: { presets: [] };
		return {
			session: { sessionId, blank: summary.blank === true, running: summary.running === true, agentPreset: summary.agentPreset },
			permissions: permissions !== null && typeof permissions === "object" ? permissions : void 0,
			models,
			imageInput,
			agentPresets: Array.isArray(presetResult?.presets) ? presetResult.presets : [],
			commands: MOBILE_COMMANDS
		};
	};

	const setDefaultWorkspace = async (req, candidate) => {
		const record = sessionRecord(req);
		if (record === void 0) throw new Error("unauthorized");
		if (!allowWorkspaceSelection) throw new Error("workspace selection is disabled by this mobile profile");
		if (candidate === null || candidate === "") {
			record.workspaceId = workspaceId;
			return visibleWorkspaces(req);
		}
		if (typeof candidate !== "string") throw new Error("workspaceId must be a string or null");
		const available = await visibleWorkspaces(req);
		if (!available.options.some((item) => item.workspaceId === candidate)) throw new Error("workspace is outside the mobile-app scope");
		record.workspaceId = candidate;
		return visibleWorkspaces(req);
	};

	const observeRuntimeFrame = (payload, rpcId) => {
		const sessionId = payload?.sessionId;
		if (typeof sessionId !== "string" || !sessionAllowed(sessionId)) return;
		const runtime = runtimeFor(sessionId);
		if (payload.type === "session/queue") {
			runtime.queueItems = Array.isArray(payload.items) ? payload.items.map(queueItemView).filter(Boolean) : [];
			runtime.queueLength = runtime.queueItems.filter((item) => item.placement === "queued").length;
		} else if (payload.type === "session/jobs") {
			runtime.jobs = Array.isArray(payload.jobs) ? payload.jobs.length : 0;
		} else if (payload.type === "approval/requested") {
			runtime.pendingApproval = { rpcId, approvalId: payload.approvalId, toolName: payload.toolName, reason: payload.reason };
		} else if (payload.type === "approval/resolved") {
			runtime.pendingApproval = void 0;
		} else if (payload.type === "question/requested") {
			runtime.pendingQuestion = { rpcId, questions: Array.isArray(payload.questions) ? payload.questions : [] };
		} else if (payload.type === "question/resolved") {
			runtime.pendingQuestion = void 0;
		} else if (payload.type === "session/projection") {
			runtime.projections ??= {};
			runtime.projections[payload.key] = payload.value;
		} else if (payload.type === "host/agent-error") {
			runtime.lastFailure = { kind: "error", message: typeof payload.message === "string" && payload.message.length > 0 ? payload.message : "Harness Agent 运行失败", at: Date.now() };
		} else if (payload.type === "session/event") {
			const event = payload.event;
			if (event?.type === "turn/start") runtime.lastFailure = void 0;
			else if (event?.type === "tool/call") runtime.activeTool = typeof event.data?.name === "string" ? event.data.name : "工具";
			else if (event?.type === "tool/result") runtime.activeTool = void 0;
			else if (event?.type === "turn/end") {
				runtime.activeTool = void 0;
				const reason = event.data?.reason;
				if (reason?.kind === "completed" || reason?.kind === "max-tokens" || reason === void 0) runtime.lastCompletedAt = Date.now();
				if (reason?.kind === "error" || reason?.kind === "blocked" || reason?.kind === "interrupted") {
					runtime.lastFailure = {
						kind: reason.kind,
						message: reason.kind === "error" ? reason.error?.message : reason.kind === "blocked" ? "任务被 Harness 运行策略阻止" : "Harness 重启或异常退出导致本轮中断",
						code: reason.kind === "error" ? reason.error?.code : void 0,
						at: Number.isFinite(event.time) ? event.time : Date.now(),
						seq: event.seq
					};
				}
			}
		}
	};

	// ── API router ───────────────────────────────────────────────────────────
	const handleApi = async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const path = url.pathname.slice("/mobile-api".length) || "/";
		const secure = isSecureTransport(req);
		if (requireSecureTransport && !secure) return sendJson(res, 426, { ok: false, error: "mobile-remote requires HTTPS; start the TLS LAN proxy and open https://<computer>/mobile/" });
		let body = {};
		if (req.method === "POST") {
			try {
				body = await readJsonBody(req, path === "/prompt" ? MOBILE_MAX_PROMPT_BODY_BYTES : 1 << 20);
			} catch (error) {
				return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
		if (req.method === "POST" && path === "/login") {
			if (token.length === 0) return sendJson(res, 401, { ok: false, error: "mobile-remote: accessTokenEnv is not configured, API is disabled" });
			if (typeof body.token !== "string" || (!pairingTokenMatches(body.token) && !consumeLocalPairingCode(body.token))) return sendJson(res, 401, { ok: false, error: "unauthorized: wrong pairing token" });
			const expiresAt = startSession(res, secure);
			return sendJson(res, 200, { ok: true, expiresInMs: sessionTtlMs, expiresAt });
		}
		if (!sessionOf(req)) {
			return sendJson(res, 401, { ok: false, error: token.length === 0 ? "mobile-remote: accessTokenEnv is not configured, API is disabled" : "unauthorized: pair this device first" });
		}
		try {
			if (req.method === "GET" && path === "/ping") {
				return sendJson(res, 200, { ok: true, serverTime: Date.now() });
			}
			if (req.method === "POST" && path === "/logout") {
				endSession(req, res);
				return sendJson(res, 200, { ok: true });
			}
			if (req.method === "GET" && path === "/state") {
				const list = await call(ctx.apiProxy.sessions.list, {});
				const workspace = await visibleWorkspaces(req);
				const archived = new Set(workspace.archivedSessionIds ?? []);
				const workspaceBySession = new Map();
				for (const option of workspace.options ?? []) for (const sessionId of option.sessionIds ?? []) workspaceBySession.set(sessionId, option.workspaceId);
				const sessions = (Array.isArray(list?.items) ? list.items : []).filter((item) => sessionAllowed(item.sessionId)).map((item) => ({
					sessionId: item.sessionId,
					updatedAt: item.updatedAt,
					running: item.running,
					blank: item.blank,
					cwd: item.cwd,
					agentPreset: item.agentPreset,
					workspaceId: workspaceBySession.get(item.sessionId),
					archived: archived.has(item.sessionId),
					parentSessionId: item.parentSessionId,
					origin: item.origin,
					title: item.projections?.values?.title ?? void 0,
					plan: item.projections?.values?.plan ?? void 0,
					imageLimits: item.projections?.values?.imageLimits ?? void 0,
					activity: runtimeFor(item.sessionId)
				}));
				return sendJson(res, 200, {
					ok: true,
					title,
					sessions,
					workspace,
					deviceSession: { expiresAt: sessionExpiresAt(req), ttlMs: sessionTtlMs },
					ssh: {
						available: sshTool() !== void 0 && sshAliases().length > 0,
						aliases: sshAliases(),
						reason: sshTool() === void 0 ? "SSH tool is not enabled" : sshAliases().length === 0 ? "No mobile SSH aliases are configured" : void 0
					},
					sessionScope: allowExistingSessions ? "all" : "mobile"
				});
			}
			if (req.method === "POST" && path === "/workspace") {
				const workspace = await setDefaultWorkspace(req, body.workspaceId ?? null);
				return sendJson(res, 200, { ok: true, workspace });
			}
			if (req.method === "POST" && path === "/create-session") {
				const workspace = await visibleWorkspaces(req);
				const created = await call(ctx.apiProxy.sessions.create, {
					...workspace.defaultWorkspaceId !== void 0 ? { workspaceId: workspace.defaultWorkspaceId } : {}
				});
				mobileSessions.add(created.sessionId);
				return sendJson(res, 200, { ok: true, sessionId: created.sessionId, agentPreset: created.agentPreset, workspaceId: workspace.defaultWorkspaceId });
			}
			if (req.method === "POST" && path === "/prompt") {
				const sessionId = requireMobileSession(body.sessionId);
				if (typeof body.text !== "string") return sendJson(res, 400, { ok: false, error: "prompt text must be a string" });
				if (body.clientTimeZone !== void 0 && (typeof body.clientTimeZone !== "string" || body.clientTimeZone.length > 128 || (body.clientTimeZone !== "UTC" && !/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/.test(body.clientTimeZone)))) return sendJson(res, 400, { ok: false, error: "clientTimeZone must be UTC or an IANA Area/Location name" });
				if (Buffer.byteLength(body.text, "utf8") > maxPromptBytes) return sendJson(res, 400, { ok: false, error: `prompt exceeds the ${maxPromptBytes}-byte text limit` });
				if (body.images !== void 0 && !Array.isArray(body.images)) return sendJson(res, 400, { ok: false, error: "images must be an array" });
				const images = Array.isArray(body.images) ? body.images : [];
				if (images.length > MOBILE_MAX_IMAGES_PER_MESSAGE) return sendJson(res, 400, { ok: false, error: `a message can contain at most ${MOBILE_MAX_IMAGES_PER_MESSAGE} images` });
				let totalImageBytes = 0;
				let imageParts;
				try {
					imageParts = images.map((image) => {
						const parsed = mobileImagePart(image);
						totalImageBytes += parsed.bytes;
						return parsed.part;
					});
				} catch (error) {
					return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				if (totalImageBytes > MOBILE_MAX_MESSAGE_IMAGE_BYTES) return sendJson(res, 400, { ok: false, error: `message images must total at most ${MOBILE_MAX_MESSAGE_IMAGE_BYTES} bytes` });
				const text = body.text.trim();
				if (text.length === 0 && imageParts.length === 0) return sendJson(res, 400, { ok: false, error: "prompt needs text or at least one image" });
				try {
					if (imageParts.length > 0) {
						const models = typeof ctx.apiProxy.sessions.models === "function" ? await call(ctx.apiProxy.sessions.models, { sessionId }) : void 0;
						const current = models?.current;
						const llm = llmService(ctx);
						if (current !== null && typeof current === "object" && typeof llm?.resolveModelInfo === "function") {
							const info = await llm.resolveModelInfo(current.provider, current.model);
							if (Array.isArray(info?.inputModalities) && !info.inputModalities.includes("image")) {
								return sendJson(res, 400, { ok: false, code: "attachment-error", reason: "MODEL_DOES_NOT_SUPPORT_IMAGES", error: `模型 ${current.model} 不支持图片输入，请先切换到支持视觉输入的模型。` });
							}
						}
					}
					const accepted = await call(ctx.apiProxy.sessions.prompt, {
						sessionId,
						mode: "queue",
						content: [...(text.length === 0 ? [] : [{ type: "text", text }]), ...imageParts],
						...(body.clientTimeZone === void 0 ? {} : { clientTimeZone: body.clientTimeZone })
					});
					return sendJson(res, 200, { ok: true, accepted: accepted.accepted === true });
				} catch (error) {
					if (error?.code === "attachment-error") return sendJson(res, 400, { ok: false, code: error.code, reason: error.details?.reason, error: error.message });
					throw error;
				}
			}
			if (req.method === "POST" && path === "/respond") {
				const sessionId = requireMobileSession(body.sessionId);
				if (typeof body.rpcId !== "string" || body.rpcId.length === 0 || body.rpcId.length > 256) return sendJson(res, 400, { ok: false, error: "rpcId is invalid" });
				const runtime = runtimeFor(sessionId);
				let message;
				if (body.kind === "question") {
					if (runtime.pendingQuestion?.rpcId !== body.rpcId) return sendJson(res, 409, { ok: false, error: "question is no longer pending" });
					if (body.cancel === true) message = { type: "client-response", rpcId: body.rpcId, result: { ok: false, error: { code: "cancelled", message: "the user closed this question request", details: {} } } };
					else {
						if (!Array.isArray(body.answers)) return sendJson(res, 400, { ok: false, error: "question answers must be an array" });
						const questions = runtime.pendingQuestion.questions;
						if (body.answers.length !== questions.length) return sendJson(res, 400, { ok: false, error: "every question must have an answer" });
						const answers = [];
						for (const answer of body.answers) {
							const question = questions.find((item) => item?.id === answer?.id);
							if (question === void 0 || !Array.isArray(answer.selected) || answer.selected.some((label) => typeof label !== "string" || !(question.options ?? []).some((option) => option?.label === label))) return sendJson(res, 400, { ok: false, error: "question answer is invalid" });
							if (question.multiSelect !== true && answer.selected.length > 1) return sendJson(res, 400, { ok: false, error: "question allows only one selected option" });
							if (answer.custom !== void 0 && (typeof answer.custom !== "string" || Buffer.byteLength(answer.custom, "utf8") > maxPromptBytes)) return sendJson(res, 400, { ok: false, error: "custom answer is invalid" });
							answers.push({ id: question.id, selected: answer.selected, ...(typeof answer.custom === "string" && answer.custom.trim() ? { custom: answer.custom.trim() } : {}) });
						}
						message = { type: "client-response", rpcId: body.rpcId, result: { ok: true, value: { sessionId, answer: { answers } } } };
					}
				} else if (body.kind === "approval") {
					const pending = runtime.pendingApproval;
					if (pending?.rpcId !== body.rpcId) return sendJson(res, 409, { ok: false, error: "approval is no longer pending" });
					if (body.outcome !== "allowed-once" && body.outcome !== "rejected") return sendJson(res, 400, { ok: false, error: "approval outcome is invalid" });
					message = { type: "client-response", rpcId: body.rpcId, result: { ok: true, value: { sessionId, approvalId: pending.approvalId, outcome: body.outcome } } };
				} else return sendJson(res, 400, { ok: false, error: "response kind must be question or approval" });
				const receipt = await ctx.apiProxy.respond(message);
				if (receipt?.accepted !== true) return sendJson(res, 409, { ok: false, error: `response was rejected (${receipt?.reason ?? "unknown"})` });
				return sendJson(res, 200, { ok: true, accepted: true });
			}
			if (req.method === "GET" && path === "/attachment") {
				const sessionId = requireMobileSession(url.searchParams.get("sessionId"));
				const attachmentId = url.searchParams.get("attachmentId");
				if (typeof attachmentId !== "string" || attachmentId.length === 0 || attachmentId.length > 256) return sendJson(res, 400, { ok: false, error: "attachmentId is invalid" });
				const result = await call(ctx.apiProxy.sessions.attachment, { sessionId, attachmentId });
				const mediaType = result?.attachment?.mediaType;
				if (!MOBILE_IMAGE_MEDIA_TYPES.has(mediaType) || typeof result.data !== "string") return sendJson(res, 502, { ok: false, error: "attachment response is invalid" });
				const bytes = Buffer.from(result.data, "base64");
				res.writeHead(200, withSecurityHeaders({ "content-type": mediaType, "content-length": bytes.length, "cache-control": "private, max-age=3600" }));
				res.end(bytes);
				return;
			}
			if (req.method === "GET" && path === "/session-controls") {
				const sessionId = requireMobileSession(url.searchParams.get("sessionId"));
				return sendJson(res, 200, { ok: true, ...await sessionControls(sessionId) });
			}
			if (req.method === "POST" && path === "/command") {
				const sessionId = requireMobileSession(body.sessionId);
				if (typeof body.line !== "string" || !body.line.startsWith("/") || body.line.length > 4096 || /[\r\n]/.test(body.line)) return sendJson(res, 400, { ok: false, error: "command must be one slash-command line within 4096 characters" });
				const commandName = body.line.slice(1).trimStart().split(/\s/, 1)[0].toLowerCase();
				if (!MOBILE_COMMANDS.some((item) => item.name === commandName && item.action !== "download" && item.action !== "model")) return sendJson(res, 403, { ok: false, error: "command is not exposed to the mobile app" });
				const accepted = await call(ctx.apiProxy.sessions.prompt, {
					sessionId,
					mode: "queue",
					content: [{ type: "text", text: body.line }]
				});
				return sendJson(res, 200, { ok: true, accepted: accepted.accepted === true, command: accepted.command });
			}
			if (req.method === "POST" && path === "/permission") {
				const sessionId = requireMobileSession(body.sessionId);
				if (typeof body.preset !== "string" || body.preset.length === 0 || body.preset.length > 128 || !/^[a-z0-9][a-z0-9-]*$/.test(body.preset)) return sendJson(res, 400, { ok: false, error: "permission preset is invalid" });
				const controls = await sessionControls(sessionId);
				const allowed = Array.isArray(controls.permissions?.options) && controls.permissions.options.some((item) => item?.value === body.preset);
				if (!allowed) return sendJson(res, 403, { ok: false, error: "permission preset is not offered for this session" });
				const accepted = await call(ctx.apiProxy.sessions.prompt, {
					sessionId,
					mode: "queue",
					content: [{ type: "text", text: `/permission ${body.preset}` }]
				});
				return sendJson(res, 200, { ok: true, accepted: accepted.accepted === true, command: accepted.command });
			}
			if (req.method === "POST" && path === "/model") {
				const sessionId = requireMobileSession(body.sessionId);
				if (typeof body.provider !== "string" || typeof body.model !== "string" || body.provider.length > 128 || body.model.length > 256) return sendJson(res, 400, { ok: false, error: "model selection is invalid" });
				if (body.reasoningEffort !== void 0 && (typeof body.reasoningEffort !== "string" || body.reasoningEffort.length > 64)) return sendJson(res, 400, { ok: false, error: "reasoning effort is invalid" });
				const catalog = await call(ctx.apiProxy.sessions.models, { sessionId });
				const group = (catalog.groups ?? []).find((item) => item.id === body.provider);
				const model = group?.models?.find((item) => item.id === body.model);
				if (model === void 0) return sendJson(res, 403, { ok: false, error: "model is not offered for this session" });
				if (body.reasoningEffort !== void 0 && !(model.reasoning?.efforts ?? []).some((item) => item.id === body.reasoningEffort)) return sendJson(res, 403, { ok: false, error: "reasoning effort is not offered for this model" });
				const result = await call(ctx.apiProxy.sessions.selectModel, {
					sessionId,
					provider: body.provider,
					model: body.model,
					...body.reasoningEffort !== void 0 ? { reasoningEffort: body.reasoningEffort } : {}
				});
				return sendJson(res, 200, { ok: true, selected: result.selected });
			}
			if (req.method === "POST" && path === "/agent-preset") {
				const sessionId = requireMobileSession(body.sessionId);
				if (typeof body.agentPreset !== "string" || body.agentPreset.length === 0 || body.agentPreset.length > 128) return sendJson(res, 400, { ok: false, error: "agent preset is invalid" });
				const roster = await call(ctx.apiProxy.agentPresets.list, {});
				const preset = (roster.presets ?? []).find((item) => item.id === body.agentPreset && item.broken === void 0);
				if (preset === void 0) return sendJson(res, 403, { ok: false, error: "agent preset is not available" });
				const result = await call(ctx.apiProxy.agentPresets.select, { sessionId, agentPreset: body.agentPreset });
				return sendJson(res, 200, { ok: true, agentPreset: result.agentPreset });
			}
			if (req.method === "GET" && path === "/export") {
				const sessionId = requireMobileSession(url.searchParams.get("sessionId"));
				if (typeof ctx.apiProxy.downloads?.sessionLog !== "function") return sendJson(res, 503, { ok: false, error: "session export is unavailable" });
				const controller = new AbortController();
				req.once("close", () => controller.abort());
				const download = await ctx.apiProxy.downloads.sessionLog({ sessionId, includeDescendants: true }, controller.signal);
				if (!download.ok || download.body === null) return sendJson(res, download.status || 500, { ok: false, error: "session export failed" });
				res.writeHead(200, withSecurityHeaders({
					"content-type": download.headers.get("content-type") ?? "application/zip",
					"content-disposition": download.headers.get("content-disposition") ?? `attachment; filename="dsh-session-${sessionId.slice(0, 8)}.zip"`,
					"cache-control": "no-store"
				}));
				for await (const chunk of download.body) res.write(chunk);
				res.end();
				return;
			}
			if (req.method === "POST" && path === "/cancel") {
				if (typeof body.sessionId !== "string") return sendJson(res, 400, { ok: false, error: "cancel needs sessionId" });
				if (!sessionAllowed(body.sessionId)) return sendJson(res, 403, { ok: false, error: "session is outside the mobile-app scope" });
				const accepted = await call(ctx.apiProxy.sessions.cancel, { sessionId: body.sessionId });
				return sendJson(res, 200, { ok: true, accepted: accepted.accepted === true });
			}
			if (req.method === "POST" && path === "/queue") {
				const sessionId = requireMobileSession(body.sessionId);
				if (typeof body.itemId !== "string" || body.itemId.length === 0 || body.itemId.length > 256) return sendJson(res, 400, { ok: false, error: "queue itemId is invalid" });
				const queued = runtimeFor(sessionId).queueItems.find((item) => item.id === body.itemId && item.placement === "queued");
				if (queued === void 0) return sendJson(res, 404, { ok: false, error: "queued item is no longer pending" });
				let action;
				if (body.action === "remove" || body.action === "steer") action = { kind: body.action };
				else if (body.action === "edit") {
					if (!queued.editable) return sendJson(res, 400, { ok: false, error: "this queued item contains non-text content and cannot be edited on mobile" });
					if (typeof body.text !== "string" || body.text.trim().length === 0) return sendJson(res, 400, { ok: false, error: "queue edit needs non-empty text" });
					if (Buffer.byteLength(body.text, "utf8") > maxPromptBytes) return sendJson(res, 400, { ok: false, error: `queue edit exceeds the ${maxPromptBytes}-byte limit` });
					action = { kind: "edit", content: [{ type: "text", text: body.text }] };
				} else return sendJson(res, 400, { ok: false, error: "queue action must be edit, remove, or steer" });
				const updated = await call(ctx.apiProxy.sessions.updateQueue, { sessionId, itemId: body.itemId, action });
				return sendJson(res, 200, { ok: true, accepted: updated.accepted === true });
			}
			if (req.method === "POST" && path === "/fork") {
				const sessionId = requireMobileSession(body.sessionId);
				if (!Number.isSafeInteger(body.atSeq) || body.atSeq < 0) return sendJson(res, 400, { ok: false, error: "fork needs a non-negative message event sequence" });
				const forked = await call(ctx.apiProxy.sessions.fork, { sessionId, atSeq: body.atSeq });
				mobileSessions.add(forked.sessionId);
				return sendJson(res, 200, { ok: true, sessionId: forked.sessionId });
			}
			if (req.method === "GET" && path === "/history") {
				const sessionId = url.searchParams.get("sessionId");
				if (typeof sessionId !== "string" || sessionId.length === 0) return sendJson(res, 400, { ok: false, error: "history needs sessionId" });
				if (!sessionAllowed(sessionId)) return sendJson(res, 403, { ok: false, error: "session is outside the mobile-app scope" });
				const requested = Number(url.searchParams.get("maxMessages"));
				const maxMessages = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), maxHistoryMessages) : maxHistoryMessages;
				const history = await call(ctx.apiProxy.sessions.history, { sessionId, maxMessages });
				return sendJson(res, 200, { ok: true, ...history, events: compactHistoryEntries(history.events) });
			}
			if (req.method === "POST" && path === "/ssh") {
				const definition = sshTool();
				if (definition === void 0) return sendJson(res, 503, { ok: false, error: "ssh 工具未启用:请先在 profile 中启用 dsh-tool-ssh 的 tool-ssh 行" });
				if (typeof body.host !== "string" || body.host.length === 0) return sendJson(res, 400, { ok: false, error: "ssh needs host alias" });
				if (!configuredAliases.includes(body.host)) return sendJson(res, 403, { ok: false, error: "SSH host alias is outside the mobile-app scope" });
				if (typeof body.command !== "string" || body.command.trim().length === 0) return sendJson(res, 400, { ok: false, error: "ssh needs a non-empty command" });
				if (Buffer.byteLength(body.command, "utf8") > 16384) return sendJson(res, 400, { ok: false, error: "ssh command exceeds the 16384-byte limit" });
				if (body.timeoutMs !== void 0 && (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 1000 || body.timeoutMs > maxSshTimeoutMs)) return sendJson(res, 400, { ok: false, error: `ssh timeoutMs must be an integer between 1000 and ${maxSshTimeoutMs}` });
				if (body.workdir !== void 0 && body.workdir !== null && (typeof body.workdir !== "string" || Buffer.byteLength(body.workdir, "utf8") > 4096)) return sendJson(res, 400, { ok: false, error: "ssh workdir must be a string within 4096 bytes" });
				const controller = new AbortController();
				const abortOnDisconnect = () => {
					if (!res.writableEnded) controller.abort();
				};
				res.once("close", abortOnDisconnect);
				let result;
				try {
					result = await definition.execute({
						host: body.host,
						command: body.command,
						description: `手机远程执行: ${body.command.slice(0, 60)}`,
						...body.timeoutMs !== void 0 ? { timeoutMs: body.timeoutMs } : {},
						...body.workdir !== void 0 && body.workdir !== null && body.workdir !== "" ? { workdir: String(body.workdir) } : {}
					}, {
						agent: void 0,
						callId: `mobile-ssh-${Date.now()}`,
						signal: controller.signal
					});
				} finally {
					res.off("close", abortOnDisconnect);
				}
				return sendJson(res, 200, { ok: true, result });
			}
			if (req.method === "GET" && path === "/events") {
				req.socket?.setNoDelay?.(true);
				res.writeHead(200, withSecurityHeaders({
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-transform",
					"connection": "keep-alive",
					"x-accel-buffering": "no"
				}));
				res.flushHeaders?.();
				res.write("retry: 1000\n: connected\n\n");
				res.on("error", () => {});
				clients.set(res, sessionExpiresAt(req));
				res.on("close", () => clients.delete(res));
				req.on("close", () => clients.delete(res));
				return;
			}
			return sendJson(res, 404, { ok: false, error: `unknown endpoint ${req.method} ${path}` });
		} catch (error) {
			const status = error?.code === "mobile-session-forbidden" ? 403 : 500;
			return sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code });
		}
	};

	ctx.effect(() => {
		const disposePairing = ctx.webServer.register({ kind: "exact", path: "/mobile-pair", handler: serveLocalPairingQr });
		const disposeRoute = ctx.webServer.register({ kind: "prefix", path: "/mobile-api", handler: handleApi });
		const disposeApp = ctx.webServer.register({ kind: "prefix", path: "/mobile", handler: (req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			const asset = url.pathname.slice("/mobile".length).replace(/^\/+/, "");
			serveAsset(res, asset);
		} });
		const disposeIndex = ctx.webServer.register({ kind: "exact", path: "/mobile", handler: (_req, res) => serveAsset(res, "") });
		return () => {
			disposePairing();
			disposeRoute();
			disposeApp();
			disposeIndex();
		};
	});
}

export { Config, apply, inject, name };
