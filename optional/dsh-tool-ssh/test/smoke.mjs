/**
 * End-to-end smoke test for dsh-tool-ssh.
 *
 * Boots a real `ssh2` server on 127.0.0.1 and exercises:
 *  - password and key authentication (and a failed-auth path);
 *  - stdout/stderr capture and exit-code reporting;
 *  - host-key fingerprint verification (pin and mismatch);
 *  - the timeout deadline;
 *  - abort via AbortSignal;
 *  - workdir `cd` prefixing and POSIX quoting;
 *  - the plugin layer: Cordis registration, tool schema, execute() against
 *    the live server, and background job hooks.
 *
 * Run:  node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { Context } from "@deepseek-ai/cordis";

const { Client, Server } = ssh2;
import * as plugin from "../lib/index.js";
import { buildConnectOptions, classifyConnectError, execRemote, startRemoteProcess } from "../lib/client.js";

const HOST = "127.0.0.1";
const PASSWORD_ENV = "DSH_TOOL_SSH_TEST_PASSWORD";
process.env[PASSWORD_ENV] = "test123";
let port = 0;
let serverFingerprint;

/** One ssh2 test server on an ephemeral port. */
async function startServer() {
	const { privateKey: keyObject } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const privateKey = keyObject.export({ format: "pem", type: "pkcs1" }).toString();
	const server = new Server({ hostKeys: [privateKey] }, (client) => {
		// A deliberately rejected handshake (host-key mismatch) surfaces as an
		// error on the server-side connection; swallow it — the client side is
		// what asserts the rejection.
		client.on("error", () => {});
		client.on("authentication", (ctx) => {
			if (ctx.method === "password") {
				if (ctx.username === "tester" && ctx.password === "test123") return ctx.accept();
				return ctx.reject();
			}
			if (ctx.method === "publickey" && ctx.key.algo === "ssh-rsa") return ctx.accept();
			ctx.reject();
		}).on("ready", () => {
			client.on("session", (accept) => {
				const session = accept();
				session.on("exec", (acceptExec, rejectExec, info) => {
					const stream = acceptExec();
					const cmd = info.command;
					if (cmd.includes("slow-command")) {
						stream.stdout.write("slow start\n");
						setTimeout(() => {
							stream.stdout.write("slow done\n");
							stream.exit(0);
							stream.end();
						}, 3000);
					} else if (cmd.includes("fail-command")) {
						stream.stderr.write("boom\n");
						stream.exit(3);
						stream.end();
					} else if (cmd.includes("noisy-command")) {
						stream.stdout.write("0123456789abcdef0123456789abcdef\n");
						stream.exit(0);
						stream.end();
					} else {
						stream.stdout.write(`cmd was: ${cmd}\n`);
						stream.exit(0);
						stream.end();
					}
				});
			});
		});
	});
	await new Promise((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, HOST, () => {
			port = server.address().port;
			resolvePromise();
		});
	});
	return server;
}

const passwordHost = {
	host: HOST,
	username: "tester",
	auth: { type: "password", passwordEnv: PASSWORD_ENV }
};
const connectFor = (host, policy = {}) => buildConnectOptions({ ...host, port, auth: host.auth }, process.env, {
	allowInlineSecrets: true,
	requireHostKeyVerification: false,
	...policy
});

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`  ok - ${label}`);
};

async function main() {
	const server = await startServer();
	console.log(`loopback ssh2 server on ${HOST}:${port}`);

	// ── transport layer ──────────────────────────────────────────────────────
	console.log("transport:");
	{
		assert.throws(() => buildConnectOptions({
			host: HOST,
			username: "tester",
			auth: { type: "password", password: "test123" }
		}, process.env, { requireHostKeyVerification: false }), (error) => error?.code === "SSH_AUTH");
		assert.throws(() => buildConnectOptions(passwordHost), (error) => error?.code === "SSH_CONNECT");
		const safeError = classifyConnectError({ message: "connect ECONNREFUSED 10.0.0.5:22" }, "prod");
		assert.doesNotMatch(safeError.message, /10\.0\.0\.5/);
		assert.match(safeError.message, /"prod"/);
		ok("secure defaults reject inline secrets and unpinned hosts");
	}
	{
		const result = await execRemote({
			connect: connectFor(passwordHost),
			command: "echo hello-from-remote",
			timeoutMs: 10000
		});
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout.text, /cmd was: echo hello-from-remote/);
		assert.equal(result.stderr.text, "");
		assert.equal(result.timedOut, false);
		ok("password auth + stdout + exit 0");
	}
	{
		const result = await execRemote({
			connect: connectFor(passwordHost),
			command: "fail-command",
			timeoutMs: 10000
		});
		assert.equal(result.exitCode, 3);
		assert.match(result.stderr.text, /boom/);
		ok("stderr + exit code 3");
	}
	{
		const result = await execRemote({
			connect: connectFor(passwordHost),
			command: "pwd",
			workdir: "/tmp",
			timeoutMs: 10000
		});
		assert.match(result.stdout.text, /cd '\/tmp' && pwd/);
		ok("workdir cd prefix");
	}
	{
		const result = await execRemote({
			connect: connectFor(passwordHost),
			command: "quoted 'it'",
			workdir: "a'b'c",
			timeoutMs: 10000
		});
		assert.match(result.stdout.text, /cd 'a'\\''b'\\''c' && quoted 'it'/);
		ok("POSIX quoting of workdir");
	}
	{
		const result = await execRemote({
			connect: connectFor(passwordHost),
			command: "slow-command",
			timeoutMs: 400
		});
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, null);
		ok("timeout kills connection, reports timedOut");
	}
	{
		const result = await execRemote({
			connect: connectFor(passwordHost),
			command: "noisy-command",
			timeoutMs: 10000,
			maxOutputBytes: 16
		});
		assert.equal(result.outputLimitExceeded, true);
		assert.equal(result.timedOut, false);
		assert.equal(result.stdout.truncated, true);
		ok("output cap stops the remote command and returns partial output");
	}
	{
		const controller = new AbortController();
		const pending = execRemote({
			connect: connectFor(passwordHost),
			command: "slow-command",
			timeoutMs: 10000,
			signal: controller.signal
		});
		setTimeout(() => controller.abort(), 150);
		await assert.rejects(pending, (error) => error?.code === "SSH_ABORTED");
		ok("AbortSignal rejects with SshAbortedError");
	}
	{
		await assert.rejects(execRemote({
			connect: connectFor({ ...passwordHost, auth: { type: "password", password: "wrong" } }),
			command: "true",
			timeoutMs: 10000
		}), (error) => error?.code === "SSH_AUTH");
		ok("wrong password → SshAuthError");
	}
	{
		const { privateKey: clientKeyObject } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const clientKey = clientKeyObject.export({ format: "pem", type: "pkcs1" }).toString();
		const keyHost = { host: HOST, username: "tester", auth: { type: "key", privateKey: clientKey } };
		const result = await execRemote({
			connect: connectFor(keyHost),
			command: "keyed",
			timeoutMs: 10000
		});
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout.text, /keyed/);
		ok("public-key auth");
	}
	{
		// Learn the real fingerprint by capturing what ssh2 hashes.
		const probe = await new Promise((resolvePromise) => {
			const conn = new Client();
			conn.on("ready", () => {
				resolvePromise(null);
				conn.end();
			});
			conn.on("error", () => resolvePromise(null));
			conn.connect({
				...connectFor(passwordHost),
				hostHash: "sha256",
				hostVerifier: (hash, verify) => {
					resolvePromise(Buffer.from(hash).toString("base64").replace(/=+$/, ""));
					verify(true);
				}
			});
		});
		assert.equal(typeof probe, "string");
		serverFingerprint = `SHA256:${probe}`;
		const pinned = { ...passwordHost, knownHostFingerprint: serverFingerprint };
		const good = await execRemote({ connect: connectFor(pinned), command: "pinned", timeoutMs: 10000 });
		assert.equal(good.exitCode, 0);
		const bad = { ...passwordHost, knownHostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
		await assert.rejects(execRemote({ connect: connectFor(bad), command: "pinned", timeoutMs: 10000 }), (error) => error?.code === "SSH_CONNECT");
		ok("host-key fingerprint pin accepts / mismatch rejects");
	}
	{
		// Background handle over the live server: incremental reads then completion.
		const proc = startRemoteProcess({
			connect: connectFor(passwordHost),
			command: "slow-command"
		});
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
		const delta = proc.readOutput();
		assert.match(delta, /slow start/);
		const outcome = await proc.done;
		assert.equal(outcome.status, "completed");
		assert.match(outcome.detail ?? "", /exit code: 0/);
		assert.match(proc.readOutput(), /slow done/);
		ok("background process: incremental read + completion");
	}
	{
		// Background cancel.
		const proc = startRemoteProcess({
			connect: connectFor(passwordHost),
			command: "slow-command"
		});
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
		proc.cancel();
		const outcome = await proc.done;
		assert.equal(outcome.status, "killed");
		ok("background cancel → killed");
	}

	// ── plugin layer ─────────────────────────────────────────────────────────
	console.log("plugin:");
	{
		assert.throws(() => plugin.apply(new Context(), {
			hosts: {
				unsafe: { ...passwordHost, port }
			}
		}), /knownHostFingerprint is required/);
		ok("plugin refuses enabled host configuration without a trust policy");
	}
	const ctx = new Context();
	const registered = [];
	const jobs = [];
	ctx.provide("tools", {
		register(definition) {
			registered.push(definition);
			return () => {};
		}
	});
	ctx.provide("systemPrompt", {
		section() {
			return () => {};
		}
	});
	ctx.provide("jobs", {
		start(spec) {
			const id = `ssh-${jobs.length + 1}`;
			const hooks = spec.run();
			jobs.push({ id, hooks, spec });
			return id;
		}
	});
	await ctx.plugin(plugin, {
		hosts: {
			test: {
				...passwordHost,
				port,
				knownHostFingerprint: serverFingerprint,
				allowedCommands: ["echo plugin-path", "fail-command", "slow-command"]
			}
		},
		defaultTimeoutMs: 10000,
		connectTimeoutMs: 5000,
		maxOutputBytes: 65536,
		enableRunInBackground: true
	});
	assert.equal(registered.length, 1);
	const tool = registered[0];
	assert.equal(tool.name, "ssh");
	ok("plugin registers one tool named 'ssh'");

	const execLike = {
		agent: undefined,
		callId: "test-call",
		signal: new AbortController().signal
	};
	{
		const result = await tool.execute({ host: "test", command: "echo plugin-path", description: "test plugin execute" }, execLike);
		assert.equal(result.kind, "foreground");
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout.text, /plugin-path/);
		assert.equal(result.host, "test");
		ok("execute() end-to-end through the registered tool");
	}
	{
		await assert.rejects(tool.execute({ host: "nope", command: "true", description: "unknown host" }, execLike), /unknown host "nope".*aliases \(test\)/);
		ok("unknown alias rejected with the configured list");
	}
	{
		await assert.rejects(tool.execute({ host: "test", command: "uname -a", description: "unlisted command" }, execLike), /restricted hosts only accept an exact configured command/);
		ok("restricted host rejects an unlisted command");
	}
	{
		await assert.rejects(tool.execute({ host: "test", command: "echo plugin-path", description: "unlisted workdir", workdir: "/tmp" }, execLike), /allowedWorkdirs/);
		ok("restricted host rejects an unlisted workdir");
	}
	{
		const result = await tool.execute({ host: "test", command: "fail-command", description: "fail path" }, execLike);
		assert.equal(result.exitCode, 3);
		assert.match(result.stderr.text, /boom/);
		const rendered = tool.output.render({}, { kind: "foreground", ...result });
		assert.match(rendered[0].text, /\[exit code: 3\]/);
		ok("render() carries stderr and exit marker");
	}
	{
		const result = await tool.execute({ host: "test", command: "slow-command", description: "background", run_in_background: true }, execLike);
		assert.equal(result.kind, "background");
		assert.match(result.jobId, /^ssh-/);
		const job = jobs[0];
		assert.match(job.spec.label, /^test: slow-command/);
		const hooks = job.hooks;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
		const delta = hooks.readOutput();
		assert.match(delta, /slow start/);
		const outcome = await hooks.done;
		assert.equal(outcome.status, "completed");
		ok("background path registers with ctx.jobs and streams output");
	}
	await ctx.fiber.dispose();

	await new Promise((resolvePromise) => server.close(resolvePromise));
	console.log(`\nall ${passed} checks passed`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
