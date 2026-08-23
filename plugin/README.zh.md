# dsh-mobile-remote

面向**单一用户、一台或少量已配对手机**的 dsh 远程控制 PWA。Harness 在本机
运行，手机通过 HTTPS 打开 `/mobile/`；安装到主屏幕后，它以独立 App 外壳运行。

- **聊天**：创建、继续、停止手机 App 自己的会话。默认看不到桌面已有会话。
- **多模态**：通过输入框左下角 `+` 选择 PNG/JPEG/WebP/GIF，支持预览、移除、仅图片消息和历史图片；适配 Harness `0.1.1-rc.2` 的持久化附件流程，并按精确模型路由的 `inputModalities` 门控图片发送。
- **交互**：提问选项、Plan 审核、工具许可和运行中队列均通过受限接口实时同步；已完成消息的复制/分支操作默认收起，点击消息后显示。
- **运行结果**：读取 Harness 的 `turn/end.reason`，失败时显示持久的“本轮运行失败”卡片和具体错误，不再把失败误报为完成。
- **SSH**：复用可选的 [dsh-tool-ssh](../optional/dsh-tool-ssh) 的凭据和命令策略；手机端只可用
  profile 中明确列出的别名。
- **配对**：电脑本机的 `/mobile-pair` 页面显示短时、一次性二维码；App 扫码后才向
  `POST /mobile-api/login` 提交该码，随后使用最长 7 天的 `HttpOnly`、
  `SameSite=Strict` Cookie。Android 使用系统 Keystore 加密保存短期设备会话；长期
  配对密钥不会进入二维码、前端、URL 或磁盘。
- **App 模式**：原生 Android 壳通过 HTTPS 承载受限页面；手机端始终在线连接本机
  Harness，不使用离线缓存，以避免插件更新后显示旧页面。仓库自带 TLS 局域网代理，
  Harness 仍只监听 `127.0.0.1`。

完整的威胁模型和部署边界见 [安全说明](SECURITY.zh.md)。

## 安装

```powershell
dsh plugin --profile web add link:./plugin
```

## 配置

先为配对密钥设置一个至少 32 字节的随机环境变量；不要把它写入 profile、仓库或
截图。以下 PowerShell 会生成一个 32 字节随机值的 Base64 表示：

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:DSH_MOBILE_PAIRING_TOKEN = [Convert]::ToBase64String($bytes)
```

运行 `dsh web` 的同一进程环境必须能读取该变量。然后在 profile 补丁中配置：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: mobile-remote
  config:
    accessTokenEnv: DSH_MOBILE_PAIRING_TOKEN
    title: 'DSH 遥控'
    # 根目录启动脚本动态写入；每次刷新本机配对页都会重读。
    pairingServerUrlFile: 'C:/Users/你的用户名/.dsh/mobile-endpoint.json'
    # 可选 HTTPS 静态回退。
    pairingServerUrl: ''
    # 二维码仅一次有效，默认 5 分钟；范围为 1 至 15 分钟。
    localPairingQrTtlMs: 300000

    # 明确的手机 SSH 范围；空数组会禁用手机 SSH，不会自动开放全部别名。
    sshAliases: [dev]

    # 单用户安全默认值：只展示本次 Harness 运行中由手机创建的会话。
    # 若要同步 localhost:3080 的已有桌面任务，显式改为 true。
    allowExistingSessions: false
    # 可选：固定初始默认工作区。不填则使用 Harness 默认工作区。
    # workspaceId: 'workspace-id'
    # 空数组 = 已配对的单一用户可选择所有已登记工作区；可改成明确 ID 列表收紧范围。
    workspaceIds: []
    # 手机中改动只保留在当前 HttpOnly 会话，不会写入电脑的全局工作区设置。
    allowWorkspaceSelection: true

    maxHistoryMessages: 80
    maxPromptBytes: 8192
    maxSshTimeoutMs: 300000
    sessionTtlMs: 604800000      # 7 天；Harness 重启或主动断开会提前失效
    requireSecureTransport: true
```

改完后重启 `dsh web`。旧版内联 `accessToken` 默认不再生效；仅在短期迁移时才可
显式设置 `allowInlineAccessToken: true`。`allowExistingSessions: true` 会把全部
Harness 会话暴露给已配对手机，应只在确有需要时启用。

`sshAliases` 是**服务端授权**，而不只是界面下拉列表；它还会受到
`dsh-tool-ssh` 的精确命令、工作目录、主机密钥和超时策略约束。

## HTTPS 局域网访问与安装

不要使用 `dsh web --host 0.0.0.0` 或 `--trusted-host`。保留默认的本机监听，使用
本项目的 TLS 代理。完整安装建议按仓库根目录 README 运行
`.\scripts\start-mobile-lan.ps1`，它会自动启动 Harness、复用 CA 为当前物理局域网
IPv4 重签服务证书、重启代理并更新动态端点文件。以下是手动部署原理：

1. 为电脑的局域网 IP 或名称取得一张 TLS 证书。此仓库的 Android App 可将这台电脑
   的本地 CA 固定内置，因此无需让手机全局信任 CA；若使用 PWA 或其他客户端，仍应
   使用该客户端信任的 CA 或受管证书。
2. 保持 Harness 运行：

   ```powershell
   dsh web
   ```

3. 启动 TLS 代理。证书的 SAN 必须包含手机实际访问的 IP 或 DNS 名称：

   ```powershell
   node scripts/lan-proxy.mjs 3080 192.168.1.10 3080 `
     --tls-cert C:\certs\dsh-mobile.pem `
     --tls-key C:\certs\dsh-mobile-key.pem
   ```

   它只允许 `/mobile` 与 `/mobile-api` 路径并代理到 `127.0.0.1:3080`；桌面根页面、
   `/api`、其他方法与 WebSocket Upgrade 会在代理层直接拒绝。首次绑定时 Windows 可能询问是否允许 `node.exe`
   通过专用网络；只在受信任网络允许。
4. 在**电脑本机**浏览器打开 `http://127.0.0.1:3080/mobile-pair`。它仅接受
   `localhost` / 回环 Host，显示一个短时一次性二维码；不要截屏、转发或在局域网
   地址打开此页面。
5. 在 Android App 中点“扫描电脑二维码”并扫描。随后按浏览器提示安装 PWA 到主屏幕
   （或直接使用原生 App）；会话有效期内重新打开 App 不需再次输入配对密钥。

若浏览器提示证书不受信任，请先修复证书链，不要降级到 HTTP。HTTPS 为传输提供
加密、完整性和服务端认证，[MDN 的 TLS 说明](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Transport_Layer_Security)；Service Worker 也要求 HTTPS（`localhost` 除外），[MDN 说明](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)。

## API（供二次开发）

除登录外，API 使用浏览器自动携带的配对 Cookie；不接受 URL Token。

| 端点 | 说明 |
| --- | --- |
| `POST /mobile-api/login` | `{token}` 配对，并签发 HttpOnly Cookie；本机二维码的 token 只能使用一次。 |
| `POST /mobile-api/logout` | 使本设备 Cookie 失效。 |
| `GET /mobile-api/state` | 手机范围内的会话、SSH、工作区选项及队列/工具/待确认状态。 |
| `POST /mobile-api/workspace` | `{workspaceId}` 或 `{workspaceId:null}`，更新本次手机连接中新会话的默认工作区。 |
| `POST /mobile-api/create-session` | 创建并登记为手机会话。 |
| `POST /mobile-api/prompt` / `cancel` | 仅操作手机范围内的 `sessionId`。 |
| `POST /mobile-api/respond` | 回传当前会话仍待处理的提问或工具许可；服务端校验 `rpcId`，不接受过期请求。 |
| `GET /mobile-api/attachment?sessionId=&attachmentId=` | 在会话范围内读取已持久化的图片附件。 |
| `GET /mobile-api/history?sessionId=` | 仅返回手机范围内的会话历史。 |
| `GET /mobile-api/session-controls?sessionId=` | 返回该会话可用的权限预设、Agent 模式、模型与受限命令目录。 |
| `POST /mobile-api/queue` | 编辑、删除或把一条仍在排队的文本消息严格插话到当前轮次。 |
| `POST /mobile-api/fork` | `{sessionId, atSeq}`，从已完成回答所在轮次创建新会话分支。 |
| `POST /mobile-api/permission` / `model` / `agent-preset` | 通过 Host 正式接口更新当前会话控制项。 |
| `POST /mobile-api/ssh` | `{host, command, timeoutMs?, workdir?}`；`host` 必须在 `sshAliases` 中。 |
| `GET /mobile-api/events` | 仅转发手机范围内会话的 SSE 事件。 |

## 开发与验证

```powershell
npm install
node scripts/make-icons.mjs
node test/smoke.mjs
npm audit --omit=dev
```

`dist/` 是无构建依赖的原生前端。页面是在线模式；修改后重新打开 Android App 或刷新。
浏览器即可得到新版本，不会被离线壳固定在旧资源上。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 一次性二维码、API 配对、Cookie 会话、会话/SSH 范围和 PWA 静态服务。 |
| `dist/` | App 外壳、聊天、SSH、设置、Service Worker 与图标。 |
| `scripts/lan-proxy.mjs` | TLS 局域网反向代理。 |
| `test/smoke.mjs` | API、范围隔离、认证和 SSE 冒烟测试。 |
| `SECURITY.zh.md` | 威胁模型、已缓解问题和残余风险。 |
