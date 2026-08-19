/**
 * End-to-end smoke test for dsh-mobile-remote.
 *
 * Boots the plugin in a Cordis context with mock webServer/apiProxy/tools
 * services, then serves the registered routes through a real node:http
 * server and exercises them over HTTP: static PWA assets, token auth,
 * session API proxying, SSH execution through the registered ssh tool,
 * the SSE event stream, and path traversal rejection.
 *
 * Run:  node test/smoke.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";
import { isAllowedProxyRequest, makeUpstreamHeaders } from "../scripts/lan-proxy-policy.mjs";

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`  ok - ${label}`);
};

assert.equal(isAllowedProxyRequest("GET", "/mobile/"), true);
assert.equal(isAllowedProxyRequest("GET", "/mobile/app.js?v=1"), true);
assert.equal(isAllowedProxyRequest("POST", "/mobile-api/prompt"), true);
assert.equal(isAllowedProxyRequest("GET", "/"), false);
assert.equal(isAllowedProxyRequest("GET", "/api/sessions"), false);
assert.equal(isAllowedProxyRequest("CONNECT", "/mobile/"), false);
const sanitizedProxyHeaders = makeUpstreamHeaders({ host: "phone.example", connection: "upgrade", upgrade: "websocket", "x-forwarded-for": "spoofed", "x-forwarded-proto": "http" }, "192.0.2.10");
assert.equal(sanitizedProxyHeaders.host, "phone.example");
assert.equal(sanitizedProxyHeaders.connection, undefined);
assert.equal(sanitizedProxyHeaders.upgrade, undefined);
assert.equal(sanitizedProxyHeaders["x-forwarded-for"], "192.0.2.10");
assert.equal(sanitizedProxyHeaders["x-forwarded-proto"], "https");
ok("LAN proxy allowlists only the mobile surface and overwrites forwarding headers");

// ── fakes ──────────────────────────────────────────────────────────────────
// The apiProxy domain contract: methods take {rpcId, payload} and answer
// {rpcId, result: {ok, value | error}}.
const calls = {
	prompts: [],
	responses: [],
	ssh: []
};
const fakeSessions = [{
	sessionId: "s1",
	updatedAt: 1000,
	running: false,
	blank: false,
	cwd: "C:/x",
	projections: { values: { title: "测试会话" } }
}];
const okResult = (request, value) => ({ rpcId: request.rpcId, result: { ok: true, value } });
const fakeApiProxy = {
	sessions: {
		list: async (request) => okResult(request, { items: fakeSessions }),
		create: async (request) => {
			fakeSessions.push({ sessionId: "s-new", updatedAt: 2000, running: false, blank: true, cwd: "C:/x", agentPreset: "standard", projections: { values: { title: "新会话", permissions: { options: [{ value: "read-only", name: "read-only" }, { value: "workspace-write", name: "workspace-write" }, { value: "danger-full-access", name: "danger-full-access" }], currentValue: "workspace-write" } } } });
			return okResult(request, { sessionId: "s-new", ...request.payload });
		},
		models: async (request) => okResult(request, { current: { provider: "test", model: "model-a", reasoningEffort: "high" }, routable: true, groups: [{ id: "test", name: "Test", models: [{ id: "model-a", name: "Model A", reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "high", name: "High" }] } }] }], failures: [] }),
		selectModel: async (request) => okResult(request, { selected: { provider: request.payload.provider, model: request.payload.model, reasoningEffort: request.payload.reasoningEffort } }),
		updateQueue: async (request) => okResult(request, { accepted: true }),
		fork: async (request) => { fakeSessions.push({ sessionId: "s-fork", updatedAt: 3000, running: false, blank: true, cwd: "C:/x", agentPreset: "standard", projections: { values: { title: "分支" } } }); return okResult(request, { sessionId: "s-fork" }); },
		prompt: async (request) => {
			calls.prompts.push(request.payload);
			return okResult(request, { accepted: true });
		},
		attachment: async (request) => okResult(request, { attachment: { attachmentId: request.payload.attachmentId, mediaType: "image/png", bytes: 8, width: 1, height: 1, name: "pixel.png" }, data: "iVBORw0KGgo=" }),
		cancel: async (request) => {
			calls.prompts.push({ cancel: request.payload });
			return okResult(request, { accepted: true });
		},
		history: async (request) => okResult(request, { events: [
			{ event: { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "你好" }] } } },
			{ event: { type: "assistant/chunk", seq: 2, data: { turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "reasoning" } } } },
			{ event: { type: "assistant/chunk", seq: 3, data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "思考" } } } },
			{ event: { type: "assistant/chunk", seq: 4, data: { turn: 1, step: 1, chunk: { type: "block-start", index: 1, blockType: "text" } } } },
			{ event: { type: "assistant/chunk", seq: 5, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 1, text: "完成" } } } },
			{ event: { type: "assistant/message", seq: 6, data: { turn: 1, step: 1, message: { content: [{ type: "reasoning", text: "思考" }, { type: "text", text: "完成" }] } } } }
		], hasMore: false, ...request.payload })
	},
	workspace: {
		list: async (request) => okResult(request, { items: [{
			workspaceId: "w1",
			title: "项目工作区",
			path: "C:/x",
			sessionIds: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z"
		}] })
	},
	agentPresets: {
		list: async (request) => okResult(request, { presets: [{ id: "standard", trust: "system", isDefault: true, name: "标准模式", description: "测试 Agent" }], authorable: false, hasDocument: false }),
		select: async (request) => okResult(request, { agentPreset: request.payload.agentPreset })
	},
	events: {
		mux: async function* (_request, signal) {
			// Long-lived stream like the real gateway: keep emitting frames so
			// SSE clients connected later still observe traffic; honors the
			// abort signal the plugin passes on dispose.
			for (;;) {
				yield { rpcId: "mux-queue", payload: { type: "session/queue", sessionId: "s-new", items: [{ id: "q1", placement: "queued", message: { content: [{ type: "text", text: "排队任务" }] } }] } };
				yield { rpcId: "mux-question", payload: { type: "question/requested", sessionId: "s-new", questions: [{ id: "choice", header: "确认", question: "选择方式", options: [{ label: "A" }, { label: "B" }] }] } };
				yield { rpcId: "mux-approval", payload: { type: "approval/requested", sessionId: "s-new", approvalId: "approval-1", toolName: "write", reason: "修改文件" } };
				yield { rpcId: "mux-plan", payload: { type: "session/projection", sessionId: "s-new", key: "plan", value: { active: true, pending: false }, seq: 3 } };
				yield { rpcId: "mux-1", payload: { type: "session/event", sessionId: "s-new", event: { type: "turn/end" } } };
				await new Promise((resolvePromise) => {
					const timer = setTimeout(resolvePromise, 50);
					signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						resolvePromise();
					}, { once: true });
				});
				if (signal?.aborted === true) return;
			}
		}
	},
	respond: async (message) => { calls.responses.push(message); return { accepted: true }; }
};
const fakeTools = {
	get(toolName) {
		if (toolName !== "ssh") return void 0;
		return {
			description: "Execute a command on a remote host over SSH. Configured aliases: dev, prod. Pass the host ALIAS in `host` — One of: dev, prod. Never a raw address.",
			execute: async (args, exec) => {
				calls.ssh.push({ args, exec });
				return {
					kind: "foreground",
					host: args.host,
					exitCode: 0,
					signal: null,
					timedOut: false,
					timeoutMs: 60000,
					stdout: { text: "ok\n", truncated: false },
					stderr: { text: "", truncated: false }
				};
			}
		};
	}
};

function makeContext(config) {
	const routes = [];
	const ctx = new Context();
	ctx.provide("webServer", { register(route) {
		routes.push(route);
		return () => {};
	} });
	ctx.provide("apiProxy", fakeApiProxy);
	ctx.provide("tools", fakeTools);
	ctx.plugin(plugin, config);
	return { ctx, routes };
}

/** Serve the captured routes like the webserver would: exact first, then longest prefix. */
function makeServer(bundle) {
	const { routes } = bundle;
	const match = (pathname) => {
		const exact = routes.find((route) => route.kind === "exact" && route.path === pathname);
		if (exact !== void 0) return exact;
		let best;
		for (const route of routes) {
			if (route.kind !== "prefix") continue;
			if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue;
			if (best === void 0 || route.path.length > best.path.length) best = route;
		}
		return best;
	};
	return http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const route = match(url.pathname);
		if (route === void 0) {
			res.writeHead(404);
			res.end();
			return;
		}
		await route.handler(req, res);
	});
}

const request = async (server, port, path, options = {}) => {
	const headers = {
		...options.body !== undefined ? { "content-type": "application/json" } : {},
		...options.headers ?? {},
		...request.cookie.length > 0 ? { cookie: request.cookie } : {}
	};
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body !== undefined ? JSON.stringify(options.body) : void 0,
		signal: options.signal
	});
	const setCookie = response.headers.get("set-cookie");
	if (setCookie !== null) request.cookie = setCookie.split(";", 1)[0];
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = void 0;
	}
	return { status: response.status, text, json, headers: response.headers };
};
request.cookie = "";

/** Node fetch normalizes the Host header, so use http.request for this boundary test. */
const requestWithHost = (port, path, host) => new Promise((resolvePromise, rejectPromise) => {
	const req = http.request({ hostname: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
		let text = "";
		res.setEncoding("utf8");
		res.on("data", (chunk) => { text += chunk; });
		res.on("end", () => resolvePromise({ status: res.statusCode, text }));
	});
	req.on("error", rejectPromise);
	req.end();
});

const openServers = [];
const tempRoots = [];
async function main() {
	const listen = (bundle) => new Promise((resolvePromise) => {
		const server = makeServer(bundle);
		openServers.push(server);
		server.listen(0, "127.0.0.1", () => resolvePromise(server));
	});
	const endpointRoot = mkdtempSync(join(tmpdir(), "dsh-mobile-endpoint-"));
	tempRoots.push(endpointRoot);
	const endpointFile = join(endpointRoot, "endpoint.json");
	writeFileSync(endpointFile, JSON.stringify({ schemaVersion: 1, pairingServerUrl: "https://192.168.1.10:3080" }));
	const bundle = makeContext({ accessToken: "0123456789abcdef0123456789abcdef", allowInlineAccessToken: true, requireSecureTransport: false, title: "测试遥控", pairingServerUrl: "https://192.168.1.9:3080", pairingServerUrlFile: endpointFile, sshAliases: ["dev"], workspaceId: "w1", workspaceIds: ["w1"], maxHistoryMessages: 80 });
	const ctx = bundle.ctx;
	const server = await listen(bundle);
	const port = server.address().port;
	console.log(`test server on 127.0.0.1:${port}`);

	// ── static PWA assets ───────────────────────────────────────────────────
	{
		const page = await request(server, port, "/mobile");
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-type"), /text\/html/);
		assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
		assert.match(page.text, /DSH 远程控制/);
		ok("GET /mobile serves the PWA shell");
	}
	{
		const app = await request(server, port, "/mobile/app.js");
		assert.equal(app.status, 200);
		assert.match(app.headers.get("content-type"), /javascript/);
		assert.match(app.text, /mobile-api/);
		assert.doesNotMatch(app.text, /localStorage/);
		assert.doesNotMatch(app.text, /serviceWorker\.register/);
		assert.match(app.text, /data\.message\?\.content \?\? data\.content/);
		assert.match(app.text, /assistant\/chunk/);
		assert.match(app.text, /data\.source\?\.kind !== "user"/);
		assert.match(app.text, /historyActiveTool/);
		assert.match(app.text, /renderDeviceSession/);
		assert.match(app.text, /reasoning-delta/);
		assert.match(app.text, /tool-call-delta/);
		assert.match(app.text, /contextSourceMeta/);
		assert.match(app.text, /requestAnimationFrame/);
		assert.match(app.text, /Harness 已接收/);
		assert.match(app.text, /formatDuration/);
		assert.match(app.text, /DOMPurify\.sanitize/);
		assert.match(app.text, /historyEventSeqs\.has\(event\.seq\)/);
		assert.doesNotMatch(app.text, /queueEventRefresh/);
		assert.match(app.text, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
		assert.match(app.text, /imageDrafts/);
		assert.match(app.text, /question\/requested/);
		assert.match(app.text, /plan-review/);
		assert.match(app.text, /optimistic/);
		assert.match(app.text, /options\.actions === true/);
		assert.match(app.text, /actions-visible/);
		assert.match(app.text, /closeMessageActions/);
		assert.doesNotMatch(app.text, /fork\.textContent = "⎇"/);
		ok("GET /mobile/app.js serves the online-only client script");
	}
	{
		const marked = await request(server, port, "/mobile/vendor/marked.js");
		const purify = await request(server, port, "/mobile/vendor/dompurify.js");
		assert.equal(marked.status, 200);
		assert.equal(purify.status, 200);
		assert.match(marked.headers.get("content-type"), /javascript/);
		assert.match(purify.headers.get("content-type"), /javascript/);
		assert.match(marked.text, /marked/);
		assert.match(purify.text, /DOMPurify/);
		ok("GFM parser and HTML sanitizer are served as same-origin modules");
	}
	{
		const appCss = await request(server, port, "/mobile/app.css");
		assert.equal(appCss.status, 200);
		assert.match(appCss.headers.get("content-type"), /text\/css/);
		assert.match(appCss.text, /\.branch-action svg[^}]+stroke-width: 1\.55/);
		assert.match(appCss.text, /\.message-actions \{ display: none/);
		ok("message branch action uses the thin vector icon style");
	}
	{
		const pairCss = await request(server, port, "/mobile/pair.css");
		assert.equal(pairCss.status, 200);
		assert.match(pairCss.headers.get("content-type"), /text\/css/);
		assert.match(pairCss.text, /\.pair-card/);
		ok("pairing page stylesheet is served");
	}
	{
		const theme = await request(server, port, "/mobile/theme.js");
		assert.equal(theme.status, 200);
		assert.match(theme.headers.get("content-type"), /javascript/);
		assert.match(theme.text, /dsh_mobile_theme/);
		assert.doesNotMatch(theme.text, /token|cookie/i);
		ok("theme preference script stores no credentials");
	}
	{
		const manifest = await request(server, port, "/mobile/manifest.webmanifest");
		assert.equal(manifest.status, 200);
		assert.match(manifest.headers.get("content-type"), /manifest\+json/);
		ok("manifest served with the right content type");
	}
	{
		const icon = await request(server, port, "/mobile/icon-192.png");
		assert.equal(icon.status, 200);
		assert.equal(icon.headers.get("content-type"), "image/png");
		ok("PNG icon served");
	}
	{
		const missing = await request(server, port, "/mobile/nope.txt");
		assert.equal(missing.status, 404);
		ok("unknown asset → 404");
	}
	{
		const traversal = await request(server, port, "/mobile/..%2fpackage.json");
		assert.notEqual(traversal.status, 200);
		ok("path traversal does not leak files");
	}
	{
		const page = await request(server, port, "/mobile-pair");
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-type"), /text\/html/);
		assert.equal(page.headers.get("cache-control"), "no-store");
		assert.match(page.text, /<svg/);
		assert.match(page.text, /https:\/\/192\.168\.1\.10:3080/);
		assert.doesNotMatch(page.text, /0123456789abcdef0123456789abcdef/);
		ok("localhost pairing page renders a one-time QR without the root secret");
	}
	{
		writeFileSync(endpointFile, JSON.stringify({ schemaVersion: 1, pairingServerUrl: "https://192.168.1.11:3080", updatedAt: new Date().toISOString() }));
		const refreshed = await request(server, port, "/mobile-pair");
		assert.equal(refreshed.status, 200);
		assert.match(refreshed.text, /https:\/\/192\.168\.1\.11:3080/);
		assert.doesNotMatch(refreshed.text, /https:\/\/192\.168\.1\.10:3080/);
		ok("pairing page refresh reads the current LAN endpoint from disk");
	}
	{
		for (const badValue of ["http://192.168.1.11:3080", "https://user:pass@192.168.1.11:3080", "https://192.168.1.11:3080/mobile", "https://192.168.1.11:3080?token=x"]) {
			writeFileSync(endpointFile, JSON.stringify({ pairingServerUrl: badValue }));
			const rejected = await request(server, port, "/mobile-pair");
			assert.equal(rejected.status, 503);
		}
		writeFileSync(endpointFile, "{broken");
		const corrupted = await request(server, port, "/mobile-pair");
		assert.equal(corrupted.status, 503);
		ok("dynamic endpoint rejects HTTP, credentials, paths, queries, and corrupt JSON");
	}
	{
		rmSync(endpointFile);
		const fallback = await request(server, port, "/mobile-pair");
		assert.equal(fallback.status, 200);
		assert.match(fallback.text, /https:\/\/192\.168\.1\.9:3080/);
		ok("missing endpoint state safely falls back to the configured HTTPS origin");
	}
	{
		const blocked = await requestWithHost(port, "/mobile-pair", "192.168.1.10:3080");
		assert.equal(blocked.status, 404);
		ok("LAN host cannot retrieve the local pairing QR");
	}

	// ── token auth ──────────────────────────────────────────────────────────
	{
		const denied = await request(server, port, "/mobile-api/state");
		assert.equal(denied.status, 401);
		ok("no token → 401");
	}
	{
		const denied = await request(server, port, "/mobile-api/state?token=0123456789abcdef0123456789abcdef");
		assert.equal(denied.status, 401);
		ok("legacy URL token is ignored");
	}
	{
		const wrong = await request(server, port, "/mobile-api/login", { method: "POST", body: { token: "nope" } });
		assert.equal(wrong.status, 401);
		ok("wrong pairing token → 401");
	}
	{
		const paired = await request(server, port, "/mobile-api/login", { method: "POST", body: { token: "0123456789abcdef0123456789abcdef" } });
		assert.equal(paired.status, 200);
		assert.match(paired.headers.get("set-cookie"), /HttpOnly/);
		assert.match(paired.headers.get("set-cookie"), /SameSite=Strict/);
		assert.match(request.cookie, /^dsh_mobile_session=/);
		ok("pairing token creates an HttpOnly session cookie");
	}

	// ── state ───────────────────────────────────────────────────────────────
	{
		const state = await request(server, port, "/mobile-api/state");
		assert.equal(state.status, 200);
		assert.equal(state.json.ok, true);
		assert.equal(state.json.title, "测试遥控");
		assert.equal(state.json.sessions.length, 0);
		assert.equal(state.json.ssh.available, true);
		assert.deepEqual(state.json.ssh.aliases, ["dev"]);
		assert.equal(state.json.workspace.defaultWorkspaceId, "w1");
		assert.deepEqual(state.json.workspace.options, [{ workspaceId: "w1", title: "项目工作区", path: "C:/x", sessionIds: [] }]);
		assert.equal(state.json.sessionScope, "mobile");
		assert.equal(typeof state.json.deviceSession.expiresAt, "number");
		ok("state scopes sessions, SSH aliases, and workspace choices to the mobile app");
	}
	{
		const ping = await request(server, port, "/mobile-api/ping");
		assert.equal(ping.status, 200);
		assert.equal(typeof ping.json.serverTime, "number");
		ok("lightweight ping measures transport latency without loading session state");
	}
	{
		const workspace = await request(server, port, "/mobile-api/workspace", { method: "POST", body: { workspaceId: "w1" } });
		assert.equal(workspace.status, 200);
		assert.equal(workspace.json.workspace.defaultWorkspaceId, "w1");
		ok("workspace endpoint accepts a phone-allowed default workspace");
	}

	// ── session API proxying ────────────────────────────────────────────────
	{
		const created = await request(server, port, "/mobile-api/create-session", { method: "POST", body: {} });
		assert.equal(created.json.sessionId, "s-new");
		assert.equal(created.json.workspaceId, "w1");
		ok("create-session proxies sessions.create");
	}
	{
		const controls = await request(server, port, "/mobile-api/session-controls?sessionId=s-new");
		assert.equal(controls.status, 200);
		assert.equal(controls.json.permissions.currentValue, "workspace-write");
		assert.equal(controls.json.models.current.model, "model-a");
		assert.equal(controls.json.agentPresets[0].id, "standard");
		assert.deepEqual(controls.json.commands.map((item) => item.name), ["compact", "export", "feedback", "goal", "permission", "plan", "model"]);
		ok("session controls expose permission, model, preset, and command catalogs");
	}
	{
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
		const state = await request(server, port, "/mobile-api/state");
		const session = state.json.sessions.find((item) => item.sessionId === "s-new");
		assert.equal(session.activity.queueItems[0].text, "排队任务");
		assert.equal(session.activity.queueItems[0].editable, true);
		assert.equal(session.activity.pendingQuestion.rpcId, "mux-question");
		assert.equal(session.activity.pendingApproval.rpcId, "mux-approval");
		const edited = await request(server, port, "/mobile-api/queue", { method: "POST", body: { sessionId: "s-new", itemId: "q1", action: "edit", text: "修改后的任务" } });
		assert.equal(edited.status, 200);
		ok("queue snapshots expose text safely and queue edits use session.updateQueue");
	}
	{
		const forked = await request(server, port, "/mobile-api/fork", { method: "POST", body: { sessionId: "s-new", atSeq: 5 } });
		assert.equal(forked.status, 200);
		assert.equal(forked.json.sessionId, "s-fork");
		ok("message fork creates and admits the child session into mobile scope");
	}
	{
		const permission = await request(server, port, "/mobile-api/permission", { method: "POST", body: { sessionId: "s-new", preset: "read-only" } });
		assert.equal(permission.status, 200);
		assert.equal(calls.prompts.at(-1).content[0].text, "/permission read-only");
		ok("permission selection executes the host slash command");
	}
	{
		const command = await request(server, port, "/mobile-api/command", { method: "POST", body: { sessionId: "s-new", line: "/compact" } });
		assert.equal(command.status, 200);
		assert.equal(calls.prompts.at(-1).content[0].text, "/compact");
		ok("mobile command execution is allowlisted and routed through the session");
	}
	{
		const model = await request(server, port, "/mobile-api/model", { method: "POST", body: { sessionId: "s-new", provider: "test", model: "model-a", reasoningEffort: "high" } });
		assert.equal(model.status, 200);
		assert.equal(model.json.selected.reasoningEffort, "high");
		ok("model selection validates against the session catalog");
	}
	{
		const preset = await request(server, port, "/mobile-api/agent-preset", { method: "POST", body: { sessionId: "s-new", agentPreset: "standard" } });
		assert.equal(preset.status, 200);
		assert.equal(preset.json.agentPreset, "standard");
		ok("blank-session agent preset selection uses the host roster");
	}
	{
		const prompted = await request(server, port, "/mobile-api/prompt", { method: "POST", body: { sessionId: "s-new", text: "帮我看看磁盘" } });
		assert.equal(prompted.json.accepted, true);
		assert.deepEqual(calls.prompts.at(-1), { sessionId: "s-new", mode: "queue", content: [{ type: "text", text: "帮我看看磁盘" }] });
		ok("prompt proxies sessions.prompt with queue mode");
	}
	{
		const imageData = "iVBORw0KGgo=";
		const prompted = await request(server, port, "/mobile-api/prompt", { method: "POST", body: { sessionId: "s-new", text: "", images: [{ type: "image", mediaType: "image/png", data: imageData, name: "pixel.png" }] } });
		assert.equal(prompted.status, 200);
		assert.deepEqual(calls.prompts.at(-1).content, [{ type: "image", mediaType: "image/png", data: imageData, name: "pixel.png" }]);
		const invalid = await request(server, port, "/mobile-api/prompt", { method: "POST", body: { sessionId: "s-new", text: "", images: [{ type: "image", mediaType: "image/svg+xml", data: imageData }] } });
		assert.equal(invalid.status, 400);
		ok("image-only prompts pass canonical raster attachments and reject unsupported media");
	}
	{
		const question = await request(server, port, "/mobile-api/respond", { method: "POST", body: { sessionId: "s-new", kind: "question", rpcId: "mux-question", answers: [{ id: "choice", selected: ["A"] }] } });
		assert.equal(question.status, 200);
		assert.equal(calls.responses.at(-1).rpcId, "mux-question");
		const approval = await request(server, port, "/mobile-api/respond", { method: "POST", body: { sessionId: "s-new", kind: "approval", rpcId: "mux-approval", outcome: "allowed-once" } });
		assert.equal(approval.status, 200);
		assert.equal(calls.responses.at(-1).result.value.approvalId, "approval-1");
		const stale = await request(server, port, "/mobile-api/respond", { method: "POST", body: { sessionId: "s-new", kind: "question", rpcId: "unknown", cancel: true } });
		assert.equal(stale.status, 409);
		ok("question and approval responses echo only current pending rpc ids");
	}
	{
		const attachment = await request(server, port, "/mobile-api/attachment?sessionId=s-new&attachmentId=image-1");
		assert.equal(attachment.status, 200);
		assert.equal(attachment.headers.get("content-type"), "image/png");
		ok("durable session image bytes are exposed only through the scoped attachment route");
	}
	{
		const bad = await request(server, port, "/mobile-api/prompt", { method: "POST", body: { sessionId: "s-new", text: "  " } });
		assert.equal(bad.status, 400);
		ok("empty prompt rejected");
	}
	{
		const scoped = await request(server, port, "/mobile-api/history?sessionId=s1");
		assert.equal(scoped.status, 403);
		ok("desktop session remains outside the mobile scope");
	}
	{
		const cancelled = await request(server, port, "/mobile-api/cancel", { method: "POST", body: { sessionId: "s-new" } });
		assert.equal(cancelled.json.accepted, true);
		ok("cancel proxies sessions.cancel");
	}
	{
		const history = await request(server, port, "/mobile-api/history?sessionId=s-new");
		assert.equal(history.status, 200);
		assert.equal(history.json.events[0].event.type, "user/message");
		assert.deepEqual(history.json.events.map((entry) => entry.event.type), ["user/message", "assistant/message"]);
		ok("history removes completed token chunks while retaining the finalized reasoning and answer");
	}

	// ── SSH execution through the registered ssh tool ───────────────────────
	{
		const run = await request(server, port, "/mobile-api/ssh", { method: "POST", body: { host: "dev", command: "uname -a", timeoutMs: 30000, workdir: "/tmp" } });
		assert.equal(run.status, 200);
		assert.equal(run.json.result.exitCode, 0);
		assert.match(run.json.result.stdout.text, /ok/);
		assert.equal(calls.ssh.length, 1);
		assert.equal(calls.ssh[0].args.host, "dev");
		assert.equal(calls.ssh[0].args.command, "uname -a");
		assert.equal(calls.ssh[0].args.timeoutMs, 30000);
		assert.equal(calls.ssh[0].args.workdir, "/tmp");
		assert.equal(typeof calls.ssh[0].exec.signal, "object");
		ok("ssh endpoint executes the registered ssh tool with the right args");
	}
	{
		const blocked = await request(server, port, "/mobile-api/ssh", { method: "POST", body: { host: "prod", command: "uname -a" } });
		assert.equal(blocked.status, 403);
		ok("SSH alias outside mobile scope is rejected server-side");
	}
	{
		const missing = await request(server, port, "/mobile-api/ssh", { method: "POST", body: { host: "dev", command: "" } });
		assert.equal(missing.status, 400);
		ok("ssh empty command rejected");
	}

	// ── SSE event stream ────────────────────────────────────────────────────
	{
		const controller = new AbortController();
		const response = await fetch(`http://127.0.0.1:${port}/mobile-api/events`, { headers: { cookie: request.cookie }, signal: controller.signal });
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type"), /text\/event-stream/);
		const reader = response.body.getReader();
		let received = "";
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const chunk = await reader.read();
			if (chunk.done) break;
			received += new TextDecoder().decode(chunk.value);
			if (received.includes("session/event")) break;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
		}
		assert.match(received, /data: /);
		assert.match(received, /session\/event/);
		controller.abort();
		ok("SSE stream forwards mux frames");
	}
	{
		const loggedOut = await request(server, port, "/mobile-api/logout", { method: "POST", body: {} });
		assert.equal(loggedOut.status, 200);
		const denied = await request(server, port, "/mobile-api/state");
		assert.equal(denied.status, 401);
		ok("logout revokes the device session");
	}

	// ── disabled-token posture ──────────────────────────────────────────────
	{
		const lockedBundle = makeContext({ requireSecureTransport: false });
		const lockedServer = await listen(lockedBundle);
		const lockedPort = lockedServer.address().port;
		const savedCookie = request.cookie;
		request.cookie = "";
		const state = await request(lockedServer, lockedPort, "/mobile-api/login", { method: "POST", body: { token: "anything" } });
		request.cookie = savedCookie;
		assert.equal(state.status, 401);
		assert.match(state.json.error, /not configured/);
		await lockedBundle.ctx.fiber.dispose();
		lockedServer.close();
		ok("missing accessTokenEnv keeps the API closed with a config hint");
	}
	{
		const tlsBundle = makeContext({ accessToken: "0123456789abcdef0123456789abcdef", allowInlineAccessToken: true, requireSecureTransport: true });
		const tlsServer = await listen(tlsBundle);
		const tlsPort = tlsServer.address().port;
		const response = await request(tlsServer, tlsPort, "/mobile-api/state");
		assert.equal(response.status, 426);
		assert.match(response.json.error, /requires HTTPS/);
		await tlsBundle.ctx.fiber.dispose();
		tlsServer.close();
		ok("secure transport is required by default");
	}

	await ctx.fiber.dispose();
	for (const openServer of openServers) await new Promise((resolvePromise) => openServer.close(resolvePromise));
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
	console.log(`\nall ${passed} checks passed`);
}

main().catch(async (error) => {
	console.error(error);
	for (const openServer of openServers) await new Promise((resolvePromise) => openServer.close(resolvePromise));
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
	process.exitCode = 1;
});
