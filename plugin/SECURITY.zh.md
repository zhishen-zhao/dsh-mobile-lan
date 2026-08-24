# 安全设计与部署边界

`dsh-mobile-remote` 将手机浏览器接入本机 Harness，因而它既是聊天入口，也是可能的远程命令入口。本版本的设计目标是**单一用户、受信任手机、最小权限**，而不是多用户协作或公网服务。

## 信任边界

- Harness、SSH 凭据和 `dsh-tool-ssh` 配置只存在电脑上；手机永远不获得 SSH 密钥。
- 手机通过 HTTPS TLS 代理访问；代理只允许 `/mobile` 与 `/mobile-api`，Harness 仍只绑定回环地址。`/mobile-pair`、`/mobile-pair.json` 与 `/mobile-admin` 只接受 `localhost`、`127.0.0.1` 或 `::1`。Android 客户端固定二维码携带的当前叶证书 SHA-256 指纹，并继续校验证书有效期与服务端 SAN；不要将其 Web 服务直接绑定到 `0.0.0.0`，也不要添加
  `--trusted-host`。
- 配对密钥只用于建立会话，随后请求依赖 HttpOnly Cookie。它不可被前端 JS 读取，也不会出现在查询参数、浏览器历史或 Service Worker 请求缓存中。
- `/mobile-pair` 只接受电脑的回环 Host，二维码采用随机、单次有效且最长 15 分钟的
  设备配对码；长期环境变量密钥不会被渲染或发送给手机。
- 默认会话范围仅包含本次 Harness 运行期间由手机 API 创建的会话；手机不能读取、取消或提示桌面现有会话。
- 手机 SSH 范围是 `sshAliases` 的显式服务端白名单；实际命令仍由 `dsh-tool-ssh` 的精确命令、工作目录、主机指纹和资源限制决定。

## 0.2.0 已缓解的问题

| 编号 | 旧行为 | 风险 | 当前措施 |
| --- | --- | --- | --- |
| M-01 | `sshAliases` 只影响界面，不检查 API 请求。 | 拿到口令者可尝试所有 SSH 别名。 | `/mobile-api/ssh` 服务端强制匹配 `sshAliases`；空数组禁用手机 SSH。 |
| M-02 | 单一 URL Token 可访问所有会话、历史和 SSE。 | 令牌泄漏即获得全部 Harness 上下文。 | 首次配对后使用最长 7 天的 HttpOnly/Strict Cookie，Android Keystore 加密保存；默认只暴露手机会话并过滤 SSE。 |
| M-03 | Token 写入查询参数和 `localStorage`。 | 容易进入日志、历史、截图或被前端脚本读取。 | 移除 URL/本地存储 Token；只允许登录接口 POST body 的配对密钥。 |
| M-04 | LAN 代理是明文 HTTP。 | 局域网攻击者可窃听配对密钥、会话和命令，或篡改前端。 | API 默认要求 HTTPS；TLS 代理最低 TLS 1.2；PWA 仅在安全上下文注册 Service Worker。 |
| M-05 | 需要手输长期配对密钥，或把它放入二维码。 | 密钥容易被截图、剪贴板、相册或旁人复用。 | 本机回环页面发放短时、单次二维码；二维码不含环境变量中的长期密钥。 |
| M-05 | 手机可指定任意工作区、超大 prompt/SSH 超时。 | 越权范围和资源消耗。 | 固定可选 `workspaceId`、prompt/history/SSH 超时上限，以及 SSH 断开时取消请求。 |
| M-06 | 缺少基础浏览器防护头。 | 点击劫持、MIME 猜测和跨源泄露风险增加。 | 静态和 API 响应增加 CSP、`frame-ancestors`、`nosniff`、`no-referrer` 与权限策略。 |

## 残余风险

- 手机解锁且 Cookie 未过期时，持有手机的人可使用该 App；请使用系统锁屏，并在设置页执行“退出此设备”以撤销会话。
- TLS 只在证书指纹与配对二维码完全一致时有效。指纹变化、SAN 错误、过期证书或 HTTP 降级都会被拒绝；应刷新本机二维码并重新配对，而不是关闭校验。
- `allowExistingSessions: true` 会扩大手机可见范围；仅在你确实需要控制桌面会话时启用。
- 悬浮宠物、电脑凭据、文件管理及无关全局设置不进入手机状态或 API；“断开此设备”仅位于手机设置的危险操作区，并要求二次确认。
- `allowUnrestrictedCommands: true` 的 SSH 别名等同于在对应远程账号权限内赋予手机任意 Shell；应继续使用低权限账号和服务器侧限制。
- 插件不提供多用户身份、设备撤销列表、审计归属或公网暴露保护。若需多人/多设备，应重新设计为每设备配对密钥、角色、持久会话和完整审计的服务。

## 上线检查

1. 用 `accessTokenEnv` 注入至少 32 字节随机密钥；不要设置 `allowInlineAccessToken: true`。
2. 为手机实际访问的 IP/DNS 生成带正确 SAN 的 TLS 证书，并使用 `scripts/lan-proxy.mjs`；二维码必须携带该叶证书的 SHA-256 指纹。
3. 保持 `allowExistingSessions: false`，仅将必要别名写入 `sshAliases`。
4. 让 `dsh-tool-ssh` 保持主机指纹固定、精确命令白名单和低权限远程账号。
5. 执行 `node test/smoke.mjs` 与 `npm audit --omit=dev` 后再安装或发布。
