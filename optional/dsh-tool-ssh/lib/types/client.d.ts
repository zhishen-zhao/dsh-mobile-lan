/**
 * Type surface of the framework-free SSH transport (`dsh-tool-ssh/client`).
 * @module dsh-tool-ssh/client
 */
export class SshConnectError extends Error {
	code: string;
}
export class SshAuthError extends Error {
	code: string;
}
export class SshAbortedError extends Error {
	code: string;
}
export function resolvePrivateKeyPath(path: string): string;
export function normalizeFingerprint(fingerprint: string): {
	algorithm: "sha256" | "md5";
	matches(hash: Buffer): boolean;
};
export function classifyConnectError(error: unknown, hostLabel?: string): SshConnectError | SshAuthError;
export function buildConnectOptions(hostConfig: import("./index.js").SshHost, env?: NodeJS.ProcessEnv, policy?: {
	allowInlineSecrets?: boolean;
	requireHostKeyVerification?: boolean;
	hostLabel?: string;
}): Record<string, unknown>;
export function quotePosix(text: string): string;
export class Capture {
	constructor(maxBytes: number);
	write(data: string | Buffer): void;
	text(): string;
	take(): { text: string; truncated: boolean };
}
export interface SshStream {
	text: string;
	truncated: boolean;
}
export interface SshRunResult {
	kind: "foreground";
	timedOut: boolean;
	outputLimitExceeded: boolean;
	timeoutMs: number | undefined;
	exitCode: number | null;
	signal: string | null;
	stdout: SshStream;
	stderr: SshStream;
}
export function execRemote(options: {
	connect: Record<string, unknown>;
	command: string;
	workdir?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
	hostLabel?: string;
}): Promise<SshRunResult>;
export function startRemoteProcess(options: {
	connect: Record<string, unknown>;
	command: string;
	workdir?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	hostLabel?: string;
}): {
	cancel(): void;
	done: Promise<{ status: "completed" | "killed" | "failed"; detail?: string }>;
	readOutput(): string;
};
