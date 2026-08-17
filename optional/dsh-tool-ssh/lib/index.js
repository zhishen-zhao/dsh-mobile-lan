/**
 * Model-facing SSH tool for dsh.
 *
 * Registers a tool named `ssh` into the host `tools` registry: each call
 * opens a fresh SSH connection to one of the OPERATOR-configured hosts (the
 * model passes an alias, never a raw address), runs one command on the remote
 * POSIX shell, and returns stdout/stderr plus the exit status. Authentication
 * supports password, private key, and ssh-agent; host keys are verified when
 * the operator pins a `knownHostFingerprint`.
 *
 * The row ships disabled with an empty host map — see `cordis.patch.yml` and
 * the README for the enable-and-configure flow in the profile patch layer.
 *
 * @module dsh-tool-ssh
 */
import z from "@deepseek-ai/schemastery";
import { TOOL_ABORTED, defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { parseExitStatus } from "@deepseek-ai/dsh-shell";
import { SshAbortedError, buildConnectOptions, execRemote, startRemoteProcess } from "./client.js";

const name = "tool-ssh";
const inject = ["tools", "systemPrompt"];

const Auth = z.union([
	z.object({
		type: z.const("password").required(),
		password: z.string(),
		passwordEnv: z.string()
	}),
	z.object({
		type: z.const("key").required(),
		privateKey: z.string(),
		privateKeyPath: z.string(),
		passphrase: z.string(),
		passphraseEnv: z.string()
	}),
	z.object({
		type: z.const("agent").required(),
		socket: z.string()
	})
]);

const Host = z.object({
	host: z.string().required(),
	port: z.natural().min(1).max(65535).default(22),
	username: z.string().required(),
	auth: Auth,
	knownHostFingerprint: z.string(),
	readyTimeoutMs: z.natural().min(1).max(300000),
	allowUnrestrictedCommands: z.boolean().default(false),
	allowedCommands: z.array(z.string().min(1).max(16384)).default([]),
	allowedWorkdirs: z.array(z.string().min(1).max(4096)).default([])
});

/** Runtime configuration schema for the ssh tool plugin. */
const Config = z.object({
	hosts: z.dict(Host).default({}),
	/** Require an explicit SHA256/MD5 host-key pin for every configured alias. */
	requireHostKeyVerification: z.boolean().default(true),
	/** Permit passwords, private keys, or passphrases embedded in the profile file. */
	allowInlineSecrets: z.boolean().default(false),
	defaultTimeoutMs: z.natural().min(1000).max(300000).default(60000),
	maxTimeoutMs: z.natural().min(1000).max(300000).default(300000),
	backgroundTimeoutMs: z.natural().min(1000).max(3600000).default(900000),
	maxBackgroundTimeoutMs: z.natural().min(1000).max(3600000).default(3600000),
	connectTimeoutMs: z.natural().min(1000).max(300000).default(30000),
	maxOutputBytes: z.natural().min(1024).max(1048576).default(262144),
	maxCommandBytes: z.natural().min(256).max(65536).default(16384),
	enableRunInBackground: z.boolean().default(true)
});

const DEFAULTS = Object.freeze({
	requireHostKeyVerification: true,
	allowInlineSecrets: false,
	defaultTimeoutMs: 60000,
	maxTimeoutMs: 300000,
	backgroundTimeoutMs: 900000,
	maxBackgroundTimeoutMs: 3600000,
	connectTimeoutMs: 30000,
	maxOutputBytes: 262144,
	maxCommandBytes: 16384,
	enableRunInBackground: true
});

function validatePositiveInteger(name, value, min, max) {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${name}: expected an integer between ${min} and ${max}`);
}

function validateText(name, value, maxBytes, required = true) {
	if (typeof value !== "string" || required && value.trim().length === 0) throw new Error(`invalid ${name}: expected ${required ? "a non-empty" : "a"} string`);
	if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`invalid ${name}: exceeds the ${maxBytes}-byte limit`);
}

function validateSshArgs(args, limits) {
	if (typeof args.command !== "string" || args.command.trim().length === 0) throw new Error("invalid command: expected a non-empty string");
	if (typeof args.description !== "string" || args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
	if (typeof args.host !== "string" || args.host.trim().length === 0) throw new Error("invalid host: expected a non-empty string");
	validateText("command", args.command, limits.maxCommandBytes);
	validateText("description", args.description, 1024);
	validateText("host", args.host, 128);
	if (args.workdir !== void 0) validateText("workdir", args.workdir, 4096);
	const timeoutLimit = args.run_in_background === true ? limits.maxBackgroundTimeoutMs : limits.maxTimeoutMs;
	if (args.timeoutMs !== void 0 && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0 || args.timeoutMs > timeoutLimit)) throw new Error(`invalid timeoutMs: expected an integer between 1 and ${timeoutLimit}`);
}

function commandPolicySummary(aliases, hosts) {
	return aliases.map((alias) => {
		const host = hosts[alias];
		if (host.allowUnrestrictedCommands === true) return `${alias}: unrestricted commands`;
		const commands = host.allowedCommands;
		const preview = commands.slice(0, 6).map((command) => JSON.stringify(command)).join(", ");
		return `${alias}: exact commands ${preview}${commands.length > 6 ? ` (+${commands.length - 6} more)` : ""}`;
	}).join("; ");
}

function sshDescription(aliases, hosts, backgroundEnabled, config) {
	const hostList = aliases.length > 0 ? aliases.join(", ") : "(none configured yet)";
	const policies = aliases.length > 0 ? commandPolicySummary(aliases, hosts) : "none";
	return `Execute a command on a remote host over SSH and return its stdout/stderr. Each call opens a FRESH connection (no cwd, variables, or state persist between calls) to one of the operator-configured hosts; pass the host ALIAS in \`host\` — never a raw address. Configured aliases: ${hostList}. Command policy: ${policies}. Restricted aliases accept only an EXACT configured command; their \`workdir\` is also restricted to the configured list. The remote command runs under a non-interactive POSIX shell (sh): no TTY, so interactive programs fail. Non-zero exits are reported as \`[exit code: N]\` markers; investigate failures before moving on. Connection or authentication failures are reported as errors — check the alias and credentials, do not retry blindly. Foreground calls default to ${config.defaultTimeoutMs}ms and can run at most ${config.maxTimeoutMs}ms; output is capped at ${config.maxOutputBytes} bytes per stream and the remote command is stopped at the cap.` + (backgroundEnabled ? ` Set \`run_in_background: true\` for long-running commands: the call returns a job id immediately; read its output with \`job_output\` and stop it with \`job_kill\`. Background jobs default to ${config.backgroundTimeoutMs}ms and cannot exceed ${config.maxBackgroundTimeoutMs}ms.` : " Background execution is not available; long-running commands must finish within the timeout.");
}

/** Append the truncation notice to a stream's text. */
function streamText(output) {
	if (!output.truncated) return output.text;
	return `${output.text}\n[output truncated at the configured byte limit; the remote command was stopped]`;
}

/**
 * Shape one finished run into the text the model sees, mirroring the bash /
 * pwsh tools' story: stdout, a marked stderr section, then exit markers. A
 * clean exit (0, no signal) produces no marker.
 * @param result - the settled foreground run from the transport.
 * @returns the model-facing text.
 */
function renderSshResult(result) {
	const out = streamText(result.stdout);
	const err = streamText(result.stderr);
	let body = out;
	if (err.length > 0) {
		if (body.length > 0 && !body.endsWith("\n")) body += "\n";
		body += `[stderr]\n${err}`;
	}
	if (body.length === 0) body = "(no output)";
	const markers = [];
	if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
	if (result.outputLimitExceeded) markers.push("[output limit reached; remote command stopped]");
	else if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
	else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`);
	if (markers.length === 0) return body;
	if (!body.endsWith("\n")) body += "\n";
	return body + markers.join("\n");
}

/** Canonical background-handle properties shared by the output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
	kind: {
		type: "string",
		required: true,
		const: "background"
	},
	jobId: {
		type: "string",
		required: true
	}
};

function normalizeConfig(config) {
	const normalized = {
		...DEFAULTS,
		...config,
		hosts: config.hosts ?? {}
	};
	for (const [name, value] of [
		["requireHostKeyVerification", normalized.requireHostKeyVerification],
		["allowInlineSecrets", normalized.allowInlineSecrets],
		["enableRunInBackground", normalized.enableRunInBackground]
	]) if (typeof value !== "boolean") throw new Error(`invalid ${name}: expected a boolean`);
	for (const [name, value, min, max] of [
		["defaultTimeoutMs", normalized.defaultTimeoutMs, 1000, 300000],
		["maxTimeoutMs", normalized.maxTimeoutMs, 1000, 300000],
		["backgroundTimeoutMs", normalized.backgroundTimeoutMs, 1000, 3600000],
		["maxBackgroundTimeoutMs", normalized.maxBackgroundTimeoutMs, 1000, 3600000],
		["connectTimeoutMs", normalized.connectTimeoutMs, 1000, 300000],
		["maxOutputBytes", normalized.maxOutputBytes, 1024, 1048576],
		["maxCommandBytes", normalized.maxCommandBytes, 256, 65536]
	]) validatePositiveInteger(name, value, min, max);
	if (normalized.defaultTimeoutMs > normalized.maxTimeoutMs) throw new Error("invalid SSH configuration: defaultTimeoutMs cannot exceed maxTimeoutMs");
	if (normalized.backgroundTimeoutMs > normalized.maxBackgroundTimeoutMs) throw new Error("invalid SSH configuration: backgroundTimeoutMs cannot exceed maxBackgroundTimeoutMs");
	if (typeof normalized.hosts !== "object" || normalized.hosts === null || Array.isArray(normalized.hosts)) throw new Error("invalid SSH configuration: hosts must be an alias map");
	for (const [alias, host] of Object.entries(normalized.hosts)) {
		validateText(`host alias ${JSON.stringify(alias)}`, alias, 128);
		if (typeof host !== "object" || host === null || Array.isArray(host)) throw new Error(`invalid SSH configuration for alias ${JSON.stringify(alias)}: host entry must be an object`);
		validateText(`host for alias ${JSON.stringify(alias)}`, host.host, 253);
		validateText(`username for alias ${JSON.stringify(alias)}`, host.username, 256);
		validatePositiveInteger(`port for alias ${JSON.stringify(alias)}`, host.port ?? 22, 1, 65535);
		if (host.readyTimeoutMs !== void 0) validatePositiveInteger(`readyTimeoutMs for alias ${JSON.stringify(alias)}`, host.readyTimeoutMs, 1000, 300000);
		if (normalized.requireHostKeyVerification && (typeof host.knownHostFingerprint !== "string" || host.knownHostFingerprint.trim().length === 0)) throw new Error(`invalid SSH configuration for alias ${JSON.stringify(alias)}: knownHostFingerprint is required`);
		const allowedCommands = host.allowedCommands ?? [];
		const allowedWorkdirs = host.allowedWorkdirs ?? [];
		if (!Array.isArray(allowedCommands) || !allowedCommands.every((command) => typeof command === "string" && command.trim().length > 0 && Buffer.byteLength(command, "utf8") <= normalized.maxCommandBytes)) throw new Error(`invalid SSH configuration for alias ${JSON.stringify(alias)}: allowedCommands must contain non-empty commands within maxCommandBytes`);
		if (new Set(allowedCommands).size !== allowedCommands.length) throw new Error(`invalid SSH configuration for alias ${JSON.stringify(alias)}: allowedCommands must not contain duplicates`);
		if (!Array.isArray(allowedWorkdirs) || !allowedWorkdirs.every((workdir) => typeof workdir === "string" && workdir.trim().length > 0 && Buffer.byteLength(workdir, "utf8") <= 4096)) throw new Error(`invalid SSH configuration for alias ${JSON.stringify(alias)}: allowedWorkdirs must contain non-empty paths`);
		if (new Set(allowedWorkdirs).size !== allowedWorkdirs.length) throw new Error(`invalid SSH configuration for alias ${JSON.stringify(alias)}: allowedWorkdirs must not contain duplicates`);
		if (host.allowUnrestrictedCommands !== true && allowedCommands.length === 0) throw new Error(`invalid SSH configuration for alias ${JSON.stringify(alias)}: set allowedCommands or explicitly set allowUnrestrictedCommands: true`);
	}
	return normalized;
}

function enforceCommandPolicy(alias, hostConfig, args) {
	if (hostConfig.allowUnrestrictedCommands === true) return;
	const allowedCommands = hostConfig.allowedCommands ?? [];
	if (!allowedCommands.includes(args.command)) throw new Error(`command rejected for host alias ${JSON.stringify(alias)}: restricted hosts only accept an exact configured command`);
	if (args.workdir !== void 0 && args.workdir.length > 0 && !(hostConfig.allowedWorkdirs ?? []).includes(args.workdir)) throw new Error(`workdir rejected for host alias ${JSON.stringify(alias)}: it is not in the configured allowedWorkdirs list`);
}

function apply(ctx, config = {}) {
	const runtimeConfig = normalizeConfig(config);
	const hosts = runtimeConfig.hosts;
	const aliases = Object.keys(hosts);
	const backgroundEnabled = runtimeConfig.enableRunInBackground;
	const defaultTimeoutMs = runtimeConfig.defaultTimeoutMs;
	const connectTimeoutMs = runtimeConfig.connectTimeoutMs;
	const maxOutputBytes = runtimeConfig.maxOutputBytes;

	ctx.systemPrompt.section({
		name: "tool:ssh",
		order: 106,
		text: "Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. Every `ssh` call opens a fresh connection to a configured host alias; connection and authentication failures are reported as errors and should not be retried blindly."
	});

	const resolveHostConfig = (alias) => {
		const hostConfig = hosts[alias];
		if (hostConfig === void 0) {
			const available = aliases.length > 0 ? aliases.join(", ") : "none";
			throw new Error(`unknown host ${JSON.stringify(alias)}: this deployment only allows the configured aliases (${available})`);
		}
		return hostConfig;
	};

	ctx.tools.register(defineTool({
		name: "ssh",
		description: sshDescription(aliases, hosts, backgroundEnabled, runtimeConfig),
		parameters: {
			host: {
				type: "string",
				required: true,
				description: "The configured host alias to connect to. One of: " + (aliases.length > 0 ? aliases.join(", ") : "(none configured)") + ". Never a raw address."
			},
			command: {
				type: "string",
				required: true,
				description: "The command to execute on the remote host (POSIX sh, non-interactive)."
			},
			description: {
				type: "string",
				required: true,
				description: "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"df -h\" → \"Show disk usage on remote host\"."
			},
				timeoutMs: {
					type: "number",
					description: "Timeout in milliseconds covering connect and execution. Foreground calls use defaultTimeoutMs/maxTimeoutMs; background calls use backgroundTimeoutMs/maxBackgroundTimeoutMs. The connection is closed on expiry."
			},
			workdir: {
				type: "string",
				description: "Remote working directory: the command runs after `cd <workdir> &&`. Defaults to the remote login directory."
			},
			...backgroundEnabled ? { run_in_background: {
				type: "boolean",
				description: "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). Execution remains bounded by backgroundTimeoutMs/maxBackgroundTimeoutMs."
			} } : {}
		},
		output: {
			schema: { oneOf: [{
				type: "object",
				additionalProperties: false,
				properties: BACKGROUND_OUTPUT_PROPERTIES
			}, {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "foreground"
					},
					host: {
						type: "string",
						required: true
					},
					exitCode: {
						required: true,
						oneOf: [{ type: "integer" }, { type: "null" }]
					},
					signal: {
						required: true,
						oneOf: [{ type: "string" }, { type: "null" }]
					},
						timedOut: {
							type: "boolean",
							required: true
						},
						outputLimitExceeded: {
							type: "boolean",
							required: true
						},
					timeoutMs: {
						type: "number",
						required: true
					},
					stdout: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							text: {
								type: "string",
								required: true
							},
							truncated: {
								type: "boolean",
								required: true
							}
						}
					},
					stderr: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							text: {
								type: "string",
								required: true
							},
							truncated: {
								type: "boolean",
								required: true
							}
						}
					}
				}
			}] },
			render: (_args, value) => [{
				type: "text",
				text: value.kind === "background" ? `started background job ${value.jobId}` : renderSshResult(value)
			}]
		},
		async execute(args, exec) {
			validateSshArgs(args, runtimeConfig);
			const hostConfig = resolveHostConfig(args.host);
			enforceCommandPolicy(args.host, hostConfig, args);
			const timeoutMs = args.timeoutMs ?? (args.run_in_background === true ? runtimeConfig.backgroundTimeoutMs : defaultTimeoutMs);
			let connect;
			try {
				connect = buildConnectOptions({
					...hostConfig,
					...hostConfig.readyTimeoutMs === void 0 ? { readyTimeoutMs: connectTimeoutMs } : {}
				}, process.env, {
					allowInlineSecrets: runtimeConfig.allowInlineSecrets,
					requireHostKeyVerification: runtimeConfig.requireHostKeyVerification,
					hostLabel: args.host
				});
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
			if (args.run_in_background === true) {
				if (!backgroundEnabled) throw new Error("run_in_background is disabled for this deployment (enableRunInBackground: false)");
				const jobs = ctx.get("jobs");
				if (jobs === void 0) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
				if (exec.signal.aborted) {
					const error = new HarnessError("tool call aborted", TOOL_ABORTED);
					error.name = "AbortError";
					throw error;
				}
				return {
					kind: "background",
					jobId: jobs.start({
						kind: "ssh",
						label: `${args.host}: ${args.command}`,
						...exec.agent ? { owner: exec.agent } : {},
						run: () => {
							const proc = startRemoteProcess({
								connect,
								command: args.command,
							workdir: args.workdir,
							timeoutMs,
							maxOutputBytes,
							hostLabel: args.host
							});
							return {
								cancel: () => proc.cancel(),
								done: proc.done.then((outcome) => ({
									status: outcome.status,
									detail: outcome.detail
								})),
								readOutput: () => proc.readOutput()
							};
						}
					})
				};
			}
			let result;
			try {
				result = await execRemote({
					connect,
					command: args.command,
				workdir: args.workdir,
				timeoutMs,
				maxOutputBytes,
				signal: exec.signal,
				hostLabel: args.host
				});
			} catch (error) {
				if (error instanceof SshAbortedError) {
					const aborted = new HarnessError("tool call aborted", TOOL_ABORTED);
					aborted.name = "AbortError";
					throw aborted;
				}
				throw error;
			}
			return {
				kind: "foreground",
				host: args.host,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				outputLimitExceeded: result.outputLimitExceeded,
				timeoutMs: result.timeoutMs,
				stdout: result.stdout,
				stderr: result.stderr
			};
		},
		presentCall: (args) => {
			if (args.run_in_background === true) return {
				card: "generic",
				title: args.command,
				kind: "execute",
				rawInput: args.command,
				content: [{
					type: "text",
					text: args.description
				}]
			};
			return {
				card: "terminal",
				title: args.command,
				description: args.description,
				host: args.host
			};
		},
		presentResult: (args, result) => {
			const block = result.content.length === 1 ? result.content[0] : void 0;
			if (block === void 0 || block.type !== "text") return void 0;
			const raw = block.text;
			if (typeof args === "object" && args !== null && args.run_in_background === true || result.isError) return {
				card: "generic",
				content: [{
					type: "text",
					text: `\`\`\`console\n${raw.replace(/\n+$/, "")}\n\`\`\``
				}]
			};
			const { body, ...exit } = parseExitStatus(raw);
			return {
				card: "terminal",
				output: body,
				...exit
			};
		}
	}));
}

export { Config, apply, inject, name };
