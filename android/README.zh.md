# DSH Mobile（Android）

原生 Android 安全启动器。它通过扫描电脑本机的短时一次性二维码配对，随后在受限
WebView 中呈现现有的 dsh 手机网页 UI；不要求在手机上配置 SSH、VPS、端口转发或长期密钥。

## 安全边界

- 只接受 `https://` 服务器地址；二维码必须携带当前叶证书 SHA-256 指纹。原生登录精确校验该指纹、证书有效期和 SAN，WebView 只对同源且指纹完全一致的“未受信任私有 CA”错误放行，不信任任意用户 CA。
- 配对二维码的 token 只提交给 `/mobile-api/login` 一次；不会写入偏好设置、数据库、
  剪贴板或 Android 备份。
- 会话 Cookie 与到期时间使用 Android Keystore 的 AES-GCM 密钥加密保存；App 进程
  被系统回收后会先向 Harness 验证再自动恢复。主动断开、Harness 重启或最长 7 天
  有效期结束后须重新扫码。
- Android 的 `FLAG_SECURE` 已启用，避免对话、命令输出出现在系统截图、录屏和不安全
  的外接显示中。
- 电脑端仍强制 SSH 主机指纹、主机别名和命令白名单；App 不拥有或保存 SSH 凭据。
- WebView 只允许当前 HTTPS 源的 `/mobile/` 与 `/mobile-api/`，禁用文件/内容访问、
  混合内容、外部跳转和 JavaScript Bridge；它不会加载高权限的 dsh 根页面 `/` 或 `/api`。

## 运行前的电脑端准备

1. 在仓库根目录运行 `scripts/install.ps1`，或手工运行 `scripts/setup-local-tls.ps1 -HostName <局域网 IP 或 DNS>` 生成本机 CA 与服务证书；全部私钥均由 Git 忽略。
2. 在 `plugin` 的 web profile 配置 `pairingServerUrl` 为手机将访问的
   HTTPS 根地址，例如 `https://192.168.1.10:3080`。
3. 用 `plugin/scripts/lan-proxy.mjs` 提供 TLS；证书 SAN 必须匹配该 IP 或 DNS 名称，动态端点文件必须包含证书 SHA-256 指纹。App 通过二维码绑定指纹，不需要安装全局 CA；不要改用 HTTP。
4. 启动或重启 `dsh web` 后，在电脑本机打开
   `http://127.0.0.1:3080/mobile-pair`。页面只在回环地址提供，并生成最长 5 分钟、
   单次有效的二维码。
5. App 中点“扫描电脑二维码”，并在系统弹窗中允许相机权限。识别在 App 本地完成，
   不依赖 Google Play services 或首次联网下载。

## 构建与安装

Android Studio 已创建此项目；也可在 PowerShell 中使用其内置 JBR：

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
.\gradlew.bat testDebugUnitTest assembleDebug
```

调试 APK 生成在：

```text
app\build\outputs\apk\debug\app-debug.apk
```

连接已开启 USB 调试的手机后，可在 Android Studio 点击 Run，或使用：

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb install -r app\build\outputs\apk\debug\app-debug.apk
& $adb shell am start -n com.zhish.dshmobile/.MainActivity
```

## 当前功能

- 二维码配对和手工 URI 调试入口；解析器拒绝 HTTP、非 DSH URI、短密钥及带路径/凭据
  的服务器地址。
- 配对成功后直接复用 `/mobile/` 的聊天、历史、SSE 状态同步、SSH 与设置界面；这和
  电脑端手机网页 UI 使用同一套渲染与事件逻辑。
