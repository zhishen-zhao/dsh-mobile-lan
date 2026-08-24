# dsh-mobile-remote

A **single-user** dsh remote-control PWA. The Harness stays on the local machine; a paired phone opens `/mobile/` over HTTPS and can install it as an app-like home-screen experience.

- Chat through mobile-created sessions. Desktop sessions are hidden by default.
- Multimodal image prompts from the composer `+` menu, with local preview and scoped historical attachment loading. The plugin targets Harness `0.1.1-rc.2` durable attachments and gates image prompts using the exact route's `inputModalities`.
- Structured user-question answers, Plan review, tool approvals, optimistic queue updates, and collapsed message actions.
- Structured `turn/end.reason` handling keeps failed turns visible with their concrete error instead of reporting every ending as completed.
- Reuse the optional [dsh-tool-ssh](../optional/dsh-tool-ssh) without copying credentials. Phone SSH is limited to explicitly configured aliases and follows the SSH tool's policy.
- A one-time pairing code is submitted to `/mobile-api/login`; the app then uses an up-to-7-day `HttpOnly`, `SameSite=Strict` device session. Android encrypts the short-lived session with Android Keystore. The long-lived root secret is never stored in browser storage, a URL, or the app.
- HTTPS is required for transport protection and PWA installation. The bundled LAN proxy terminates TLS while the Harness remains loopback-only.

See [the security notes](SECURITY.zh.md) for the threat model and residual risk.

## Install and configure

```powershell
dsh plugin --profile web add link:./plugin
```

Create a random secret of at least 32 bytes in the environment that starts `dsh web`. Do not put it in the profile or repository.

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:DSH_MOBILE_PAIRING_TOKEN = [Convert]::ToBase64String($bytes)
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: mobile-remote
  config:
    accessTokenEnv: DSH_MOBILE_PAIRING_TOKEN
    title: 'DSH Remote'
    pairingServerUrlFile: 'C:/Users/your-name/.dsh/mobile-endpoint.json'
    pairingServerUrl: ''          # optional static HTTPS fallback
    sshAliases: [dev]             # explicit mobile scope; [] disables mobile SSH
    allowExistingSessions: false  # mobile-created sessions only
    maxHistoryMessages: 80
    maxPromptBytes: 8192
    maxSshTimeoutMs: 300000
    sessionTtlMs: 604800000
    requireSecureTransport: true
```

Restart `dsh web` after changing configuration. The legacy inline `accessToken` is ignored unless `allowInlineAccessToken: true` is explicitly set for a short migration. `allowExistingSessions: true` exposes all Harness sessions to the paired device.

When this plugin and the local settings provider are enabled, the `http://127.0.0.1:3080` Settings dialog adds a **Mobile** page in its left navigation beside **Desktop pet**. It persists the mobile title, retained-history count, session lifetime, and the option to select only already-configured workspaces. The same page renders a local-only one-time pairing QR and can refresh it without exposing the long-lived pairing secret. Before minting a QR it verifies that the advertised LAN TLS endpoint is listening; an offline proxy produces a `start-mobile-lan.ps1` recovery hint instead of an unusable QR. Pairing secrets, HTTPS origins, SSH aliases, and workspace scope remain deployment-only YAML settings.

## HTTPS phone access

Keep `dsh web` on its default loopback binding. For a complete Windows installation, use `.\scripts\install.ps1` from the repository root. It creates the environment secret, installs this bundle, registers per-user startup, and launches the address watcher. The watcher reuses a valid leaf certificate on the same address and records its SHA-256 fingerprint for app-specific QR pinning. The manual proxy equivalent is:

```powershell
dsh web
node scripts/lan-proxy.mjs 3080 192.168.1.10 3080 `
  --tls-cert C:\certs\dsh-mobile.pem `
  --tls-key C:\certs\dsh-mobile-key.pem
```

Open `https://192.168.1.10:3080/mobile/`, pair once, then install from the browser menu. Do not use `dsh web --host 0.0.0.0`, `--trusted-host`, or a plaintext HTTP proxy. The proxy forwards only `/mobile` and `/mobile-api`; it rejects the desktop root UI, `/api`, unsupported methods, and WebSocket upgrades before they reach Harness.

HTTPS protects web traffic from reading and modification in transit, and service workers require HTTPS except on localhost. [MDN TLS](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Transport_Layer_Security), [MDN Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

## API

`POST /mobile-api/login` accepts `{token}` and creates the cookie session. Authenticated endpoints include session state/history and scoped message-content search, durable rename/archive operations, queue editing and steering, anchored or whole-session forks, multimodal prompts and scoped attachments, question/approval responses, permission/model/preset controls, SSH, SSE events, and logout. Desktop credentials, file management, desktop-pet preferences, and unrelated global settings are never exposed to the phone. URL query tokens are not supported. Default scope permits only mobile-created sessions.

## Development

```powershell
npm install
node scripts/make-icons.mjs
node test/smoke.mjs
npm audit --omit=dev
```

`dist/` is a no-build, online-only native frontend.
