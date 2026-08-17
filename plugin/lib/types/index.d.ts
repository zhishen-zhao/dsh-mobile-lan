/**
 * Type surface of the dsh mobile remote-control plugin.
 * @module dsh-mobile-remote
 */
export interface MobileRemoteConfig {
	/** Legacy inline pairing token; needs allowInlineAccessToken: true. */
	accessToken?: string;
	/** Environment variable name containing the pairing token. */
	accessTokenEnv?: string;
	allowInlineAccessToken?: boolean;
	/** Public HTTPS origin the Android app should use after scanning a local QR code. */
	pairingServerUrl?: string;
	/** Lifetime of the one-time QR pairing code, from 60 seconds to 15 minutes. */
	localPairingQrTtlMs?: number;
	title?: string;
	/** Explicit SSH aliases accessible from the phone. Empty disables mobile SSH. */
	sshAliases?: string[];
	/** Include sessions not created during the current mobile-plugin runtime. */
	allowExistingSessions?: boolean;
	/** Default workspace for mobile-created sessions. */
	workspaceId?: string;
	/** Workspace ids that the phone may choose. Empty permits all local workspaces. */
	workspaceIds?: string[];
	/** Allow changing the runtime-only default workspace from the phone. */
	allowWorkspaceSelection?: boolean;
	maxHistoryMessages?: number;
	maxPromptBytes?: number;
	maxSshTimeoutMs?: number;
	sessionTtlMs?: number;
	requireSecureTransport?: boolean;
}

export const Config: import("@deepseek-ai/schemastery").default;
export const name: string;
export const inject: string[];
export function apply(ctx: import("@deepseek-ai/cordis").Context, config?: MobileRemoteConfig): void;
