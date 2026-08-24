# Security policy

This project is designed for one operator on a trusted local network. It is not
a multi-user service and must not be exposed directly to the public Internet.

## Supported deployment boundary

- Keep DeepSeek Harness bound to `127.0.0.1`.
- Expose only the bundled TLS proxy on a trusted private network.
- The proxy allowlists `/mobile`, `/mobile/`, and `/mobile-api/`; it does not
  forward the Harness desktop UI or `/api` surface.
- Generate a different CA and server key for every installation. Never commit
  files under `certs/`. The Android app binds the exact public leaf-certificate
  SHA-256 fingerprint delivered by the one-time QR and does not need a shared CA.
- Keep `allowExistingSessions: false` and `sshAliases: []` unless the broader
  scope is explicitly required.

See [`plugin/SECURITY.zh.md`](plugin/SECURITY.zh.md) and
[`optional/dsh-tool-ssh/SECURITY.zh.md`](optional/dsh-tool-ssh/SECURITY.zh.md)
for the detailed threat models.

## Reporting a vulnerability

Do not include pairing tokens, cookies, private keys, full configuration files,
or conversation logs in a public issue. Open a minimal issue describing the
affected component and request a private contact channel from the maintainer.
