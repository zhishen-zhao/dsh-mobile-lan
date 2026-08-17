/**
 * SSH transport for the dsh `ssh` tool — plain `ssh2` client logic with no
 * dsh imports, so the connection layer is testable standalone (see
 * `test/smoke.mjs`, which runs a loopback `ssh2` server).
 *
 * Contract summary:
 * - every call opens a FRESH connection (no state persists between calls);
 * - one deadline covers connect + exec; expiry reports `timedOut` instead of
 *   throwing, and an external AbortSignal rejects with `SshAbortedError`;
 * - stdout/stderr are captured independently, each capped at `maxOutputBytes`;
 *   reaching either cap terminates the remote command and reports truncation;
 * - transport failures (socket, DNS, handshake, auth) reject with
 *   `SshConnectError` / `SshAuthError` carrying a stable `code`.
 *
 * @module dsh-tool-ssh/client
 */
import ssh2 from "ssh2";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const { Client } = ssh2;

/** The transport refused or dropped the connection (DNS, socket, handshake, timeout). */
export class SshConnectError extends Error {
	code = "SSH_CONNECT";
	constructor(message) {
		super(message);
		this.name = "SshConnectError";
	}
}

/** Credentials were missing or the server rejected authentication. */
export class SshAuthError extends Error {
	code = "SSH_AUTH";
	constructor(message) {
		super(message);
		this.name = "SshAuthError";
	}
}

/** The caller's AbortSignal fired; the caller maps this to the harness abort error. */
export class SshAbortedError extends Error {
	code = "SSH_ABORTED";
	constructor(message = "ssh call aborted") {
		super(message);
		this.name = "SshAbortedError";
	}
}

/**
 * Expand `~` and resolve a key path: absolute paths pass through, `~/…` goes
 * under the home directory, everything else resolves against the process cwd.
 * @param path - configured `privateKeyPath`.
 * @returns an absolute filesystem path.
 */
export function resolvePrivateKeyPath(path) {
	if (path.startsWith("~/") || path === "~") return resolve(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * Parse an OpenSSH-style fingerprint (`SHA256:base64` or `MD5:hex`, padding
 * optional) into a matcher over the raw hash buffer ssh2 hands to
 * `hostVerifier`.
 * @param fingerprint - the configured `knownHostFingerprint`.
 * @returns `{ algorithm, matches }` where `matches` accepts the hashed key buffer.
 */
export function normalizeFingerprint(fingerprint) {
	const sha = /^SHA256:([A-Za-z0-9+/]+={0,2})$/.exec(fingerprint.trim());
	if (sha?.[1] !== void 0) {
		const expected = sha[1];
		return {
			algorithm: "sha256",
			matches(hash) {
				const actual = Buffer.from(hash).toString("base64").replace(/=+$/, "");
				return actual === expected.replace(/=+$/, "");
			}
		};
	}
	const md5 = /^MD5:([0-9a-fA-F:]{47}|[0-9a-fA-F]{32})$/.exec(fingerprint.trim());
	if (md5?.[1] !== void 0) {
		const expected = md5[1].replace(/:/g, "").toLowerCase();
		return {
			algorithm: "md5",
			matches(hash) {
				return Buffer.from(hash).toString("hex").toLowerCase() === expected;
			}
		};
	}
	throw new SshAuthError(`invalid knownHostFingerprint ${JSON.stringify(fingerprint)}: expected "SHA256:<base64>" or "MD5:<hex>"`);
}

/**
 * Build the `ssh2` connect options for one configured host entry: address,
 * credentials (password / key / agent), readiness timeout, keepalive, strict
 * RFC compliance, and — when configured — host-key verification.
 * @param hostConfig - one entry of the plugin's `hosts` config map.
 * @param env - environment to resolve `*Env` credential references from.
 * @returns ssh2 `Client.connect` options.
 */
export function buildConnectOptions(hostConfig, env = process.env, policy = {}) {
	const { host, port = 22, username, auth } = hostConfig;
	const {
		allowInlineSecrets = false,
		requireHostKeyVerification = true,
		hostLabel = "configured SSH host"
	} = policy;
	const target = `SSH host alias ${JSON.stringify(hostLabel)}`;
	const options = {
		host,
		port,
		username,
		strictVendor: true,
		agentForward: false,
		tryKeyboard: false,
		keepaliveInterval: 15000,
		...hostConfig.readyTimeoutMs !== void 0 ? { readyTimeout: hostConfig.readyTimeoutMs } : {}
	};
	const type = auth?.type ?? "agent";
	if (type === "password") {
		if (!allowInlineSecrets && auth.password !== void 0) throw new SshAuthError(`${target}: inline passwords are disabled; use passwordEnv or enable allowInlineSecrets explicitly`);
		const password = auth.password ?? (auth.passwordEnv !== void 0 ? env[auth.passwordEnv] : void 0);
		if (typeof password !== "string" || password.length === 0) throw new SshAuthError(`${target}: password authentication has no usable secret`);
		options.password = password;
	} else if (type === "key") {
		if (!allowInlineSecrets && (auth.privateKey !== void 0 || auth.passphrase !== void 0)) throw new SshAuthError(`${target}: inline key material is disabled; use privateKeyPath and passphraseEnv or enable allowInlineSecrets explicitly`);
		let privateKey = auth.privateKey;
		if (privateKey === void 0 && auth.privateKeyPath !== void 0) {
			try {
				privateKey = readFileSync(resolvePrivateKeyPath(auth.privateKeyPath), "utf8");
			} catch (error) {
				throw new SshAuthError(`${target}: cannot read the configured private key`);
			}
		}
		if (typeof privateKey !== "string" || privateKey.length === 0) throw new SshAuthError(`${target}: key authentication has no usable private key`);
		options.privateKey = privateKey;
		const passphrase = auth.passphrase ?? (auth.passphraseEnv !== void 0 ? env[auth.passphraseEnv] : void 0);
		if (typeof passphrase === "string" && passphrase.length > 0) options.passphrase = passphrase;
	} else if (type === "agent") {
		const socket = auth.socket ?? env.SSH_AUTH_SOCK;
		if (typeof socket !== "string" || socket.length === 0) throw new SshAuthError(`${target}: SSH agent authentication has no configured socket`);
		options.agent = socket;
	} else {
		throw new SshAuthError(`${target}: unknown authentication type`);
	}
	const fingerprintText = hostConfig.knownHostFingerprint?.trim();
	if (requireHostKeyVerification && !fingerprintText) throw new SshConnectError(`${target}: host-key verification is required but no fingerprint is configured`);
	if (fingerprintText) {
		let fingerprint;
		try {
			fingerprint = normalizeFingerprint(fingerprintText);
		} catch {
			throw new SshConnectError(`${target}: configured host-key fingerprint is invalid`);
		}
		options.hostHash = fingerprint.algorithm;
		options.hostVerifier = (hash, verify) => {
			if (fingerprint.matches(hash)) {
				verify(true);
			} else {
				verify(false);
			}
		};
	}
	return options;
}

/**
 * POSIX single-quote a shell word: `'` → `'\''`, safe to prefix `cd <dir> &&`.
 * @param text - raw text to quote.
 * @returns the quoted shell word.
 */
export function quotePosix(text) {
	return `'${String(text).replace(/'/g, "'\\''")}'`;
}

/**
 * Cap stdout/stderr capture. One instance per stream; bytes beyond the cap
 * are dropped and `truncated` records that loss. The caller terminates the
 * remote command once truncation occurs. `take()` drains the current text
 * (background deltas), while `text()` peeks (foreground).
 */
export class Capture {
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
		this.chunks = [];
		this.length = 0;
		this.truncated = false;
	}
	write(data) {
		const piece = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		if (this.length >= this.maxBytes) {
			this.truncated = true;
			return;
		}
		const room = this.maxBytes - this.length;
		if (piece.length > room) {
			this.chunks.push(piece.subarray(0, room));
			this.length = this.maxBytes;
			this.truncated = true;
			return;
		}
		this.chunks.push(piece);
		this.length += piece.length;
	}
	text() {
		return Buffer.concat(this.chunks).toString("utf8");
	}
	take() {
		const text = this.text();
		const wasTruncated = this.truncated;
		this.chunks = [];
		this.length = 0;
		this.truncated = false;
		return { text, truncated: wasTruncated };
	}
}

/**
 * Map an ssh2 client error onto the stable failure vocabulary.
 * @param error - the ssh2 `error` event payload.
 * @returns an `SshConnectError` or `SshAuthError`.
 */
export function classifyConnectError(error, hostLabel = "configured SSH host") {
	const level = error?.level;
	const message = String(error?.message ?? error);
	const target = `SSH host alias ${JSON.stringify(hostLabel)}`;
	if (level === "client-authentication") return new SshAuthError(`ssh authentication failed for ${target}`);
	if (level === "client-timeout" || /timed out/i.test(message)) return new SshConnectError(`ssh handshake timed out for ${target}`);
	if (/host (fingerprint|key) verification failed/i.test(message)) return new SshConnectError(`ssh host-key verification failed for ${target}`);
	return new SshConnectError(`ssh connection failed for ${target}`);
}

/**
 * One SSH command execution. Opens a fresh connection, runs `command` (with
 * an optional `cd` prefix), and resolves with the captured result. `timeoutMs`
 * bounds connect + exec together; `signal` aborts the connection and rejects
 * with `SshAbortedError`.
 * @param options - {@link RemoteExecOptions}.
 * @returns the settled foreground run.
 */
export function execRemote(options) {
	const { connect, command, workdir, timeoutMs, maxOutputBytes = 262144, signal, hostLabel = "configured SSH host" } = options;
	if (typeof command !== "string" || command.length === 0) throw new TypeError("execRemote: command must be a non-empty string");
	const conn = new Client();
	const stdout = new Capture(maxOutputBytes);
	const stderr = new Capture(maxOutputBytes);
	let settled = false;
	const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : void 0;
	let timer;
	let remoteStream;
	return new Promise((resolvePromise, rejectPromise) => {
		const terminateRemoteCommand = () => {
			try {
				remoteStream?.signal("TERM");
			} catch {}
		};
		const cleanup = (destroy = false) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (destroy) conn.destroy();
			else conn.end();
		};
		const settle = (value, destroy = false) => {
			if (settled) return;
			settled = true;
			cleanup(destroy);
			resolvePromise(value);
		};
		const fail = (error, destroy = false) => {
			if (settled) return;
			settled = true;
			cleanup(destroy);
			rejectPromise(error);
		};
		const onAbort = () => {
			terminateRemoteCommand();
			fail(new SshAbortedError(), true);
		};
		if (signal?.aborted === true) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (deadline !== void 0) timer = setTimeout(() => {
			terminateRemoteCommand();
			settle({
				kind: "foreground",
				timedOut: true,
				outputLimitExceeded: false,
				timeoutMs,
				exitCode: null,
				signal: null,
				stdout: stdout.take(),
				stderr: stderr.take()
			}, true);
		}, Math.max(1, deadline - Date.now()));
		conn.on("ready", () => {
			const remote = workdir !== void 0 && workdir.length > 0 ? `cd ${quotePosix(workdir)} && ${command}` : command;
			conn.exec(remote, (error, stream) => {
				if (error !== void 0 && error !== null) return fail(classifyConnectError(error, hostLabel), true);
				remoteStream = stream;
				const stopForOutputLimit = () => {
					terminateRemoteCommand();
					settle({
						kind: "foreground",
						timedOut: false,
						outputLimitExceeded: true,
						timeoutMs,
						exitCode: null,
						signal: "TERM",
						stdout: stdout.take(),
						stderr: stderr.take()
					}, true);
				};
				stream.on("data", (data) => {
					stdout.write(data);
					if (stdout.truncated) stopForOutputLimit();
				});
				stream.stderr.on("data", (data) => {
					stderr.write(data);
					if (stderr.truncated) stopForOutputLimit();
				});
				stream.on("close", (code, sig) => {
					settle({
						kind: "foreground",
						timedOut: false,
						outputLimitExceeded: false,
						timeoutMs,
						exitCode: code ?? null,
						signal: sig !== void 0 && sig !== null ? sig : null,
						stdout: stdout.take(),
						stderr: stderr.take()
					});
				});
			});
		});
		conn.on("error", (error) => fail(classifyConnectError(error, hostLabel), true));
		conn.on("close", () => {
			if (!settled) fail(new SshConnectError(`ssh connection to host alias ${JSON.stringify(hostLabel)} closed before the command finished`));
		});
		conn.connect(connect);
	});
}

/**
 * A long-running SSH command handle for the generic background-jobs registry:
 * incremental output reads plus a kill switch. The producer hooks match the
 * `JobHooks` contract of `@deepseek-ai/dsh-jobs`.
 * @param options - same shape as {@link execRemote}.
 * @returns `{ cancel, done, readOutput }`.
 */
export function startRemoteProcess(options) {
	const { connect, command, workdir, timeoutMs, maxOutputBytes = 262144, hostLabel = "configured SSH host" } = options;
	const conn = new Client();
	const stdout = new Capture(maxOutputBytes);
	const stderr = new Capture(maxOutputBytes);
	let settled = false;
	let timer;
	let remoteStream;
	const terminateRemoteCommand = () => {
		try {
			remoteStream?.signal("TERM");
		} catch {}
	};
	const cleanup = (destroy = false) => {
		clearTimeout(timer);
		if (destroy) conn.destroy();
		else conn.end();
	};
	const finish = (outcome) => {
		if (settled) return;
		settled = true;
		cleanup(outcome.status === "failed" || outcome.timedOut === true || outcome.outputLimitExceeded === true);
		doneResolve(outcome);
	};
	let doneResolve;
	const done = new Promise((resolvePromise) => {
		doneResolve = resolvePromise;
	});
	conn.on("ready", () => {
		const remote = workdir !== void 0 && workdir.length > 0 ? `cd ${quotePosix(workdir)} && ${command}` : command;
		conn.exec(remote, (error, stream) => {
			if (error !== void 0 && error !== null) return finish({
				status: "failed",
				detail: classifyConnectError(error, hostLabel).message
			});
			remoteStream = stream;
			const stopForOutputLimit = () => {
				terminateRemoteCommand();
				finish({
					status: "completed",
					detail: `output limit of ${maxOutputBytes} bytes reached; remote command stopped`,
					outputLimitExceeded: true
				});
			};
			stream.on("data", (data) => {
				stdout.write(data);
				if (stdout.truncated) stopForOutputLimit();
			});
			stream.stderr.on("data", (data) => {
				stderr.write(data);
				if (stderr.truncated) stopForOutputLimit();
			});
			stream.on("close", (code, sig) => {
				finish({
					status: "completed",
					detail: `exit code: ${code ?? 0}`,
					exitCode: code ?? 0,
					signal: sig !== void 0 && sig !== null ? sig : null
				});
			});
		});
	});
	conn.on("error", (error) => finish({
		status: "failed",
		detail: classifyConnectError(error, hostLabel).message
	}));
	conn.on("close", () => {
		if (!settled) finish({
			status: "failed",
			detail: `ssh connection to host alias ${JSON.stringify(hostLabel)} closed before the command finished`
		});
	});
	if (Number.isFinite(timeoutMs)) timer = setTimeout(() => {
		terminateRemoteCommand();
		finish({
			status: "completed",
			detail: `timed out after ${timeoutMs}ms`,
			timedOut: true
		});
	}, timeoutMs);
	conn.connect(connect);
	return {
		cancel() {
			if (settled) return;
			settled = true;
			terminateRemoteCommand();
			cleanup(true);
			doneResolve({
				status: "killed",
				detail: "killed"
			});
		},
		done,
		readOutput() {
			const out = stdout.take();
			const err = stderr.take();
			const parts = [];
			if (out.text.length > 0) parts.push(out.text);
			if (err.text.length > 0) parts.push(`[stderr]\n${err.text}`);
			if (out.truncated || err.truncated) parts.push("[some output was dropped from memory]");
			return parts.join(parts.length > 1 ? "\n" : "");
		}
	};
}
