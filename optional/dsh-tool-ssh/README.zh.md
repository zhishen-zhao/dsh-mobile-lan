# dsh-tool-ssh

为 [dsh](https://github.com/deepseek-ai/deepseek-harness)(DeepSeek Harness)增加一个 `ssh` 工具插件:让智能体可以通过 SSH 在**运维人员预先配置好的**远程主机上执行命令,适用于 Web GUI、headless、TUI 等所有 dsh 表面。

- 每次调用建立**全新连接**——远程侧不保留任何状态(工作目录、变量等)。
- 模型只传**主机别名**,永远不能传裸地址;只有 profile 配置中列出的主机可被访问。
- 认证方式:**密码**、私钥文件或 **ssh-agent**;默认只接受环境变量和文件路径,不把机密写进 profile。
- 默认**强制主机密钥指纹固定**(`SHA256:…` 优先),不匹配或未配置即拒绝连接。
- 每个主机默认使用**精确命令白名单**;只有显式确认后才可开放任意 shell 命令。
- 前后台执行均有超时上限;stdout/stderr 达到上限会停止远程命令,避免输出洪泛。
- 基于纯 JS 的 [`ssh2`](https://www.npmjs.com/package/ssh2) 客户端——Windows/macOS/Linux 均可用,不依赖系统 `ssh` 命令。

## 安装

本包是一个 dsh **bundle**:它的 `cordis.patch.yml` 会把 `tool-ssh` 行插入 profile 配置树。用 dsh 的插件管理器(本质是 pnpm 转发器)安装到某个 profile:

```powershell
dsh plugin --profile web add link:./dsh-tool-ssh     # 开发迭代:符号链接
dsh plugin --profile web add file:./dsh-tool-ssh     # 稳定安装:快照拷贝
dsh plugin --profile web add ./dsh-tool-ssh          # 等价于 file:
```

> `dsh plugin` 会在 profile 目录里执行 pnpm。首次使用会自动初始化 profile;如果 pnpm 提示 git 仓库插件需要允许构建脚本,按提示在 profile 的 `pnpm-workspace.yaml` 里补 `allowBuilds` 后重跑即可。

## 配置

bundle 默认以**禁用 + 空主机列表**安装该行。在 profile 自己的补丁层
`$DSH_HOME/profiles/<name>/cordis.patch.yml` 中启用并配置主机(该文件在
长期运行的程序面上支持热加载;bundle 变更需要重启):

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
          privateKeyPath: C:/Users/you/.ssh/id_ed25519   # 或 ~/.ssh/id_ed25519
          passphraseEnv: DEV_SSH_KEY_PASSPHRASE           # 可选,不要内联
        knownHostFingerprint: SHA256:…                    # 必填:用带外方式核验
        allowedCommands:                                  # 精确匹配,不是正则或前缀
          - docker ps
          - docker compose ps
          - df -h
        allowedWorkdirs:
          - /srv/app
      prod:
        host: 10.0.0.5
        username: dsh-prod                                # 使用受限服务账号,不要 root
        auth:
          type: password
          passwordEnv: PROD_SSH_PASSWORD                  # 密码只走环境变量,不写进配置
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

然后重启 profile(`dsh web`)。智能体即可使用 `ssh` 工具:

```
ssh(host: "dev", command: "docker ps", description: "列出运行中的容器")
```

### 主机配置参考

| 键 | 含义 |
| --- | --- |
| `host` | 远程主机名或 IP(必填)。 |
| `port` | SSH 端口(默认 `22`)。 |
| `username` | 登录用户名(必填)。 |
| `auth.type` | `password` \| `key` \| `agent`(默认 `agent`)。 |
| `auth.passwordEnv` | 密码环境变量名。内联 `auth.password` 默认被拒绝。 |
| `auth.privateKeyPath` | 私钥文件(支持 `~` 展开)。内联 `auth.privateKey` 默认被拒绝。 |
| `auth.passphraseEnv` | 私钥口令环境变量名。内联 `auth.passphrase` 默认被拒绝。 |
| `auth.socket` | agent 套接字(默认 `$SSH_AUTH_SOCK`;Windows 上如 `\\.\pipe\openssh-ssh-agent`)。 |
| `knownHostFingerprint` | 固定主机密钥:`SHA256:<base64>`(推荐;兼容接受 `MD5:<hex>`)。默认必填,不匹配即拒绝。 |
| `readyTimeoutMs` | 该主机的握手超时(默认取 `connectTimeoutMs`)。 |
| `allowedCommands` | 受限模式下允许的**精确**命令数组;不允许用通配符/正则绕过 shell 解析。 |
| `allowedWorkdirs` | 受限模式下允许传给 `workdir` 的精确路径数组。未配置时不允许 `workdir`。 |
| `allowUnrestrictedCommands` | 默认 `false`。设为 `true` 才允许该别名执行任意 shell 命令;仅限低权限账号和受控网络。 |

### 插件配置参考

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `hosts` | `{}` | 别名 → 主机条目映射。 |
| `requireHostKeyVerification` | `true` | 每个别名必须有 `knownHostFingerprint`。设为 `false` 会接受任意主机密钥,只可用于临时排障。 |
| `allowInlineSecrets` | `false` | 是否允许 profile 内的密码、私钥、口令字段;默认拒绝。 |
| `defaultTimeoutMs` | `60000` | 单次调用截止时间(连接 + 执行)。 |
| `maxTimeoutMs` | `300000` | 前台调用可请求的最大超时(1–300 秒)。 |
| `backgroundTimeoutMs` | `900000` | 后台任务默认截止时间。 |
| `maxBackgroundTimeoutMs` | `3600000` | 后台任务可请求的最大截止时间(最多 1 小时)。 |
| `connectTimeoutMs` | `30000` | SSH 握手(`readyTimeout`)超时。 |
| `maxOutputBytes` | `262144` | stdout/stderr 各自的上限(1 KiB–1 MiB);达到上限即终止远程命令并标记。 |
| `maxCommandBytes` | `16384` | 模型提交命令的 UTF-8 字节上限。 |
| `enableRunInBackground` | `true` | 是否暴露 `run_in_background`(需要 dsh jobs 注册表,内置 profile 均已包含)。 |

### 安全迁移与运维边界

0.2.0 起,已启用的主机若没有指纹或命令策略,会在启动时明确报错,而不是静默降级。请先通过独立、可信的运维渠道核验主机的 `SHA256` 指纹,再写入配置;不要把首次连接时得到的指纹直接当作可信值。

白名单是精确字符串比较,这样 `docker ps; rm -rf /` 不能借由 `docker ps` 前缀绕过。确实需要通用运维能力时可逐台设 `allowUnrestrictedCommands: true`,但这等价于允许模型在该账号权限内远程执行任意 shell。应配合低权限专用账号、服务端 `authorized_keys` 强制命令/限制、网络 ACL 和服务器审计日志。详见 [安全审计与部署边界](SECURITY.zh.md)。

## 工具语义(写给模型)

- POSIX `sh`,非交互、无 TTY;交互式程序会失败。
- `workdir` 会变成远程 `cd <workdir> &&` 前缀(已做 POSIX 引号转义);受限主机只能使用 `allowedWorkdirs` 里的路径。
- 非零退出码返回 `[exit code: N]` 标记;超时或输出达到上限会返回部分输出和对应标记;传输/认证失败作为不泄露裸地址的错误返回。
- `run_in_background: true` 返回 job id,用 `job_output` 读取、`job_kill` 停止,但仍受后台超时上限限制。取消会尽力向远端发送 `TERM` 并关闭连接;无法保证已脱离会话的子进程结束。

## 开发

```powershell
npm install        # 依赖 + devDeps(ssh2、schemastery、dsh-* peer)
node test/smoke.mjs
```

冒烟测试会在本机启动一个回环 `ssh2` 服务器,端到端覆盖:安全默认值、
密码/密钥认证、认证失败、主机密钥固定、超时、输出上限、中断(AbortSignal)、
workdir 引号转义、命令白名单、后台输出流,以及 Cordis 插件注册与工具执行。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `cordis.patch.yml` | bundle 补丁:插入 `tool-ssh` 行(默认禁用)。 |
| `lib/index.js` | Cordis 插件:配置 schema + `ssh` 工具注册。 |
| `lib/client.js` | 与框架无关的 `ssh2` 传输层(连接、认证、执行、输出上限)。 |
| `test/smoke.mjs` | 基于回环 SSH 服务器的端到端冒烟测试。 |
| `SECURITY.zh.md` | 安全审计、已缓解问题与部署残余风险。 |
