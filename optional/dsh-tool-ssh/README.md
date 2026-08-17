# dsh-tool-ssh

A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the
agent an `ssh` tool: run commands on **operator-configured** remote hosts over
SSH, from any dsh surface (Web GUI, headless, TUI).

- Each call opens a **fresh connection** — no remote state persists between calls.
- The model passes a **host alias**, never a raw address; only the hosts named
  in the profile configuration are reachable.
- Auth: **password**, private-key files, or **ssh-agent**. By default secrets
  must come from environment variables or files, never the profile itself.
- **Host-key fingerprint pinning is required by default** (`SHA256:…` preferred).
- Each host uses an **exact-command allowlist** by default; arbitrary shell
  commands require an explicit per-host opt-in.
- Foreground and background jobs have bounded deadlines. Reaching either output
  cap stops the remote command to prevent output flooding.
- Built on the pure-JS [`ssh2`](https://www.npmjs.com/package/ssh2) client —
  works on Windows, macOS, and Linux without a system `ssh` binary.

## Install

The package is a dsh **bundle**: its `cordis.patch.yml` inserts the `tool-ssh`
row into the profile tree. Install it into a profile with the dsh plugin
manager (a thin pnpm forwarder):

```powershell
dsh plugin --profile web add link:./dsh-tool-ssh     # dev iteration: symlink
dsh plugin --profile web add file:./dsh-tool-ssh     # stable: snapshot copy
dsh plugin --profile web add ./dsh-tool-ssh          # same as file:
```

> `dsh plugin` runs pnpm in the profile directory. On first use it initializes
> the profile; if pnpm warns about build scripts for git-hosted packages,
> follow its `allowBuilds` hint in the profile's `pnpm-workspace.yaml`.

## Configure

The bundle ships the row **disabled with an empty host list**. Enable it and
name your hosts in the profile's own patch layer —
`$DSH_HOME/profiles/<name>/cordis.patch.yml` (hot-reloaded on long-lived
surfaces; a restart applies bundle changes):

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: tool-ssh
  disabled: false
  config:
    hosts:
      dev:
        host: dev.example.com
        port: 22
        username: deploy
        auth:
          type: key
          privateKeyPath: C:/Users/you/.ssh/id_ed25519   # or ~/.ssh/id_ed25519
          passphraseEnv: DEV_SSH_KEY_PASSPHRASE           # optional; never inline
        knownHostFingerprint: SHA256:…                    # required; verify out of band
        allowedCommands:                                  # exact strings, not patterns
          - docker ps
          - docker compose ps
          - df -h
        allowedWorkdirs:
          - /srv/app
      prod:
        host: 10.0.0.5
        username: dsh-prod                                # a restricted service account
        auth:
          type: password
          passwordEnv: PROD_SSH_PASSWORD                  # never inline secrets
        knownHostFingerprint: SHA256:…
        allowedCommands:
          - systemctl status app.service
          - journalctl -u app.service -n 100 --no-pager
    requireHostKeyVerification: true
    allowInlineSecrets: false
    defaultTimeoutMs: 60000
    maxTimeoutMs: 300000
    backgroundTimeoutMs: 900000
    maxBackgroundTimeoutMs: 3600000
    connectTimeoutMs: 30000
    maxOutputBytes: 262144
    maxCommandBytes: 16384
    enableRunInBackground: true
```

Then restart the profile (`dsh web`). The agent sees an `ssh` tool:

```
ssh(host: "dev", command: "docker ps", description: "List running containers")
```

### Host configuration reference

| Key | Meaning |
| --- | --- |
| `host` | Remote hostname or IP (required). |
| `port` | SSH port (default `22`). |
| `username` | Login user (required). |
| `auth.type` | `password` \| `key` \| `agent` (default `agent`). |
| `auth.passwordEnv` | Password environment-variable name. Inline `auth.password` is rejected by default. |
| `auth.privateKeyPath` | Private-key file (`~` expanded). Inline `auth.privateKey` is rejected by default. |
| `auth.passphraseEnv` | Key-passphrase environment-variable name. Inline `auth.passphrase` is rejected by default. |
| `auth.socket` | Agent socket (default `$SSH_AUTH_SOCK`; on Windows e.g. `\\.\pipe\openssh-ssh-agent`). |
| `knownHostFingerprint` | Pin the host key: `SHA256:<base64>` is recommended (`MD5:<hex>` remains compatible). Required by default; mismatch fails the connection. |
| `readyTimeoutMs` | Handshake timeout for this host (default: `connectTimeoutMs`). |
| `allowedCommands` | Exact commands accepted in restricted mode. Patterns and prefixes are deliberately unsupported. |
| `allowedWorkdirs` | Exact values accepted for `workdir` in restricted mode. Without it, `workdir` is rejected. |
| `allowUnrestrictedCommands` | Defaults to `false`. Set `true` only to deliberately grant arbitrary-shell access to this alias. |

### Plugin configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `hosts` | `{}` | Alias → host entry map. |
| `requireHostKeyVerification` | `true` | Every alias must set `knownHostFingerprint`; `false` accepts any host key and is for temporary diagnostics only. |
| `allowInlineSecrets` | `false` | Whether passwords, keys, and passphrases can be embedded in the profile. |
| `defaultTimeoutMs` | `60000` | Per-call deadline covering connect + exec. |
| `maxTimeoutMs` | `300000` | Maximum foreground timeout (1–300 seconds). |
| `backgroundTimeoutMs` | `900000` | Default background-job deadline. |
| `maxBackgroundTimeoutMs` | `3600000` | Maximum requested background deadline (one hour). |
| `connectTimeoutMs` | `30000` | SSH handshake (`readyTimeout`) deadline. |
| `maxOutputBytes` | `262144` | Per-stream cap (1 KiB–1 MiB); reaching it terminates the remote command and marks the result. |
| `maxCommandBytes` | `16384` | UTF-8 byte limit for a model-submitted command. |
| `enableRunInBackground` | `true` | Expose `run_in_background` (requires the dsh jobs registry, present in shipped profiles). |

### Secure migration and operating boundary

From 0.2.0 onward, an enabled alias without a fingerprint or command policy
fails clearly at startup instead of silently falling back. Verify the `SHA256`
fingerprint through an independent trusted operations channel before entering
it; never trust a fingerprint learned during an unverified first connection.

An allowlist compares the entire command string, so `docker ps; rm -rf /`
cannot bypass an entry for `docker ps`. If general operations are genuinely
needed, set `allowUnrestrictedCommands: true` only per intended alias. That is
equivalent to granting the model arbitrary shell access within that account.
Use a low-privilege account, server-side `authorized_keys` restrictions/network
ACLs, and server audit logs. See [the Chinese security audit](SECURITY.zh.md)
for the threat model and residual risks.

## Tool semantics (for the model)

- POSIX `sh`, non-interactive, no TTY. Interactive programs fail.
- `workdir` becomes a remote `cd <workdir> &&` prefix (POSIX-quoted). A
  restricted host only accepts entries from `allowedWorkdirs`.
- Non-zero exits return `[exit code: N]` markers. Timeouts and output caps
  return partial output and a marker; transport/auth errors do not disclose raw
  configured addresses.
- `run_in_background: true` returns a job id; read it with `job_output`, stop
  it with `job_kill`, and note that it remains bounded by the background cap.
  Cancellation attempts a remote `TERM` and closes the connection, but cannot
  guarantee termination of detached child processes.

## Development

```powershell
npm install        # deps + devDeps (ssh2, schemastery, dsh-* peers)
node test/smoke.mjs
```

The smoke test boots a loopback `ssh2` server and exercises secure defaults,
password/key auth, auth failures, host-key pinning, timeouts, output limits,
aborts, workdir quoting, command allowlists, background streams, and the
Cordis plugin registration end-to-end.

## Layout

| File | Role |
| --- | --- |
| `cordis.patch.yml` | The bundle patch: inserts the `tool-ssh` row (disabled by default). |
| `lib/index.js` | The Cordis plugin: config schema + `ssh` tool registration. |
| `lib/client.js` | Framework-free `ssh2` transport (connection, auth, exec, caps). |
| `test/smoke.mjs` | End-to-end smoke test against a loopback SSH server. |
| `SECURITY.zh.md` | Security audit, mitigations, and residual deployment risk. |
