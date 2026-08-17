/**
 * Type surface of the dsh `ssh` tool plugin.
 * @module dsh-tool-ssh
 */
export type SshAuth = {
	type: "password";
	password?: string;
	passwordEnv?: string;
} | {
	type: "key";
	privateKey?: string;
	privateKeyPath?: string;
	passphrase?: string;
	passphraseEnv?: string;
} | {
	type: "agent";
	socket?: string;
};

export interface SshHost {
	host: string;
	port?: number;
	username: string;
	auth?: SshAuth;
	knownHostFingerprint?: string;
	readyTimeoutMs?: number;
	/** Opt out of the exact-command allowlist for this host. Defaults to false. */
	allowUnrestrictedCommands?: boolean;
	/** Exact commands accepted when allowUnrestrictedCommands is false. */
	allowedCommands?: string[];
	/** Exact working directories accepted on a restricted host. */
	allowedWorkdirs?: string[];
}

export interface SshConfig {
	hosts: Record<string, SshHost>;
	/** Require knownHostFingerprint on every configured host. Defaults to true. */
	requireHostKeyVerification?: boolean;
	/** Allow password/private key/passphrase values in the profile. Defaults to false. */
	allowInlineSecrets?: boolean;
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
	backgroundTimeoutMs?: number;
	maxBackgroundTimeoutMs?: number;
	connectTimeoutMs?: number;
	maxOutputBytes?: number;
	maxCommandBytes?: number;
	enableRunInBackground?: boolean;
}

export const Config: import("@deepseek-ai/schemastery").default;
export const name: string;
export const inject: string[];
export function apply(ctx: import("@deepseek-ai/cordis").Context, config?: SshConfig): void;
