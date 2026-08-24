/** Browser settings page for the mobile-remote companion. */
window.__ModuleLoader__.load({
  id: 'dsh-mobile-remote',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const NS = 'mobile-remote'
    const STYLE_ID = 'dsh-mobile-remote-settings'

    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const style = document.createElement('style')
      style.dataset.pluginCss = STYLE_ID
      style.textContent = [
        '.dsh-mobile-settings{display:flex;flex-direction:column;gap:16px;max-width:680px;padding:8px 0 24px}',
        '.dsh-mobile-settings h2{margin:0;color:var(--dsw-alias-label-primary);font-size:20px;line-height:1.35}',
        '.dsh-mobile-settings p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.55}',
        '.dsh-mobile-settings label{display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}',
        '.dsh-mobile-settings input{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:8px 10px;font:inherit}',
        '.dsh-mobile-settings .dsh-mobile-settings-switch{flex-direction:row;align-items:center;font-size:14px;font-weight:400}',
        '.dsh-mobile-settings .dsh-mobile-settings-switch input{width:16px;height:16px}',
        '.dsh-mobile-settings button{align-self:flex-end;cursor:pointer;border:0;border-radius:8px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);padding:8px 14px;font:inherit}',
        '.dsh-mobile-settings button:disabled{cursor:default;opacity:.45}',
        '.dsh-mobile-settings .dsh-mobile-pairing{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}',
        '.dsh-mobile-settings .dsh-mobile-pairing-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
        '.dsh-mobile-settings .dsh-mobile-pairing-head h3{margin:0;color:var(--dsw-alias-label-primary);font-size:15px}',
        '.dsh-mobile-settings .dsh-mobile-pairing-head button{align-self:auto}',
        '.dsh-mobile-settings .dsh-mobile-pairing-qr{display:block;width:min(230px,100%);aspect-ratio:1;align-self:center;background:#fff;border-radius:8px;padding:8px}',
        '.dsh-mobile-settings .dsh-mobile-pairing code{display:block;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.dsh-mobile-settings .dsh-mobile-pairing-error{color:var(--dsw-alias-label-error)!important}',
        '.dsh-mobile-settings .dsh-mobile-status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
        '.dsh-mobile-settings .dsh-mobile-status-card{display:flex;flex-direction:column;gap:3px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
        '.dsh-mobile-settings .dsh-mobile-status-card span{color:var(--dsw-alias-label-tertiary);font-size:11px}',
        '.dsh-mobile-settings .dsh-mobile-status-card strong{color:var(--dsw-alias-label-primary);font-size:13px}',
        '.dsh-mobile-settings .dsh-mobile-device-list{display:flex;flex-direction:column;gap:7px}',
        '.dsh-mobile-settings .dsh-mobile-device{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
        '.dsh-mobile-settings .dsh-mobile-device div{display:flex;min-width:0;flex-direction:column;gap:2px}',
        '.dsh-mobile-settings .dsh-mobile-device strong{overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;text-overflow:ellipsis;white-space:nowrap}',
        '.dsh-mobile-settings .dsh-mobile-device button{flex:none;align-self:auto;background:transparent;color:var(--dsw-alias-label-error);padding:6px 8px}',
        '.dsh-mobile-settings .dsh-mobile-command{user-select:all}',
        '@media(max-width:520px){.dsh-mobile-settings .dsh-mobile-status-grid{grid-template-columns:1fr}}',
      ].join('')
      document.head.appendChild(style)
    }

    function copy(value) {
      return value === undefined ? undefined : { ...value }
    }

    function PairingSection() {
      const [pairing, setPairing] = React.useState({ status: 'loading' })
      const [admin, setAdmin] = React.useState({ status: 'loading', value: undefined })
      const loadStatus = async () => {
        try {
          const response = await fetch('/mobile-admin/status', { cache: 'no-store', credentials: 'same-origin' })
          const body = await response.json()
          if (!response.ok || body?.ok !== true) throw new Error('无法读取手机端运行状态。')
          setAdmin({ status: 'ready', value: body })
        } catch (error) {
          setAdmin({ status: 'failed', error: error instanceof Error ? error.message : '无法读取手机端运行状态。' })
        }
      }
      const loadPairing = async () => {
        try {
          const response = await fetch('/mobile-pair.json', { cache: 'no-store', credentials: 'same-origin' })
          const body = await response.json()
          if (!response.ok || body?.ok !== true || typeof body.qrDataUrl !== 'string' || typeof body.serverUrl !== 'string') {
            throw new Error(typeof body?.hint === 'string' ? body.hint : '暂时无法生成二维码。')
          }
          setPairing({ status: 'ready', value: body })
        } catch (error) {
          setPairing({ status: 'failed', error: error instanceof Error ? error.message : '暂时无法生成二维码。' })
        }
      }
      const refresh = async () => {
        setPairing((previous) => ({ ...previous, status: 'loading', error: undefined }))
        setAdmin((previous) => ({ ...previous, status: 'loading', error: undefined }))
        await Promise.all([loadStatus(), loadPairing()])
      }
      const revoke = async (deviceId) => {
        const response = await fetch('/mobile-admin/revoke', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-mobile-admin': '1' },
          body: JSON.stringify({ deviceId }),
        })
        const body = await response.json()
        if (!response.ok || body?.ok !== true) throw new Error(body?.error || '撤销设备失败。')
        setAdmin((previous) => ({ ...previous, status: 'ready', value: { ...previous.value, devices: body.devices } }))
      }
      React.useEffect(() => { void refresh() }, [])
      const refreshing = pairing.status === 'loading'
      const status = admin.value
      const devices = Array.isArray(status?.devices) ? status.devices : []
      return h('section', { className: 'dsh-mobile-pairing' },
        h('div', { className: 'dsh-mobile-pairing-head' },
          h('h3', null, '扫码配对'),
          h('button', { type: 'button', disabled: refreshing, onClick: () => { void refresh() } }, refreshing ? '生成中…' : '刷新二维码'),
        ),
        status ? h('div', { className: 'dsh-mobile-status-grid' },
          h('div', { className: 'dsh-mobile-status-card' }, h('span', null, '局域网代理'), h('strong', null, status.tlsProxy?.ready ? '● 已就绪' : '○ 未启动')),
          h('div', { className: 'dsh-mobile-status-card' }, h('span', null, '已配对设备'), h('strong', null, `${devices.length} 台`)),
        ) : null,
        h('p', null, '打开 DSH Mobile，选择“扫描电脑二维码”。二维码是一次性的短时配对码，不包含长期密钥。'),
        pairing.status === 'ready' ? h('img', {
          className: 'dsh-mobile-pairing-qr', src: pairing.value.qrDataUrl, alt: 'DSH Mobile 配对二维码',
        }) : null,
        pairing.status === 'ready' ? h('code', null, pairing.value.serverUrl) : null,
        pairing.status === 'ready' ? h('code', null, `证书 ${pairing.value.certificateSha256.slice(0, 16)}…`) : null,
        pairing.status === 'ready' ? h('p', null, `本二维码约 ${pairing.value.expiresMinutes} 分钟后失效；需要新的二维码时点击刷新。`) : null,
        pairing.status === 'failed' ? h('p', { className: 'dsh-mobile-pairing-error' }, pairing.error) : null,
        pairing.status === 'failed' ? h('code', { className: 'dsh-mobile-command' }, '.\\scripts\\start-mobile-lan.ps1') : null,
        devices.length > 0 ? h('div', { className: 'dsh-mobile-device-list' },
          h('p', null, '已配对设备'),
          ...devices.map((device) => h('div', { className: 'dsh-mobile-device', key: device.id },
            h('div', null,
              h('strong', null, device.name || '已配对设备'),
              h('span', null, `最后活动：${new Date(device.lastSeenAt).toLocaleString()}`),
            ),
            h('button', { type: 'button', onClick: () => { void revoke(device.id).catch((error) => setAdmin({ status: 'failed', error: error.message })) } }, '撤销'),
          )),
        ) : null,
        admin.status === 'failed' ? h('p', { className: 'dsh-mobile-pairing-error' }, admin.error) : null,
      )
    }

    function MobileSettingsSection(props) {
      const state = props.useMobileRemoteSettings((snapshot) => snapshot)
      const [draft, setDraft] = React.useState(() => copy(state.value))
      const [saving, setSaving] = React.useState(false)
      React.useEffect(() => { setDraft(copy(state.value)) }, [state.revision, state.value])
      if (state.status === 'unavailable') {
        return h('p', null, '手机端设置暂不可用：请确认 mobile-remote 插件和本机设置服务均已启用。')
      }
      if (state.status !== 'ready' || draft === undefined) return null
      const disabled = saving || !state.writable
      const set = (field, value) => { setDraft((previous) => ({ ...previous, [field]: value })) }
      const save = async () => {
        setSaving(true)
        try { await props.save(draft) } finally { setSaving(false) }
      }
      return h('section', { className: 'dsh-mobile-settings' },
        h('h2', null, '手机端'),
        h('p', null, '这些偏好会立即影响手机控制页；配对密钥、HTTPS 地址、工作区与 SSH 范围继续只在配置文件中管理。'),
        h(PairingSection),
        h('label', null, '手机端标题', h('input', {
          value: draft.title, disabled, maxLength: 80,
          onChange: (event) => { set('title', event.target.value) },
        })),
        h('label', null, '保留历史消息数', h('input', {
          type: 'number', min: 1, max: 500, value: draft.maxHistoryMessages, disabled,
          onChange: (event) => { set('maxHistoryMessages', Math.max(1, Math.min(500, Number(event.target.value) || 1))) },
        })),
        h('label', null, '手机会话有效期（小时）', h('input', {
          type: 'number', min: 1, max: 168, value: Math.round(draft.sessionTtlMs / 3600000), disabled,
          onChange: (event) => { set('sessionTtlMs', Math.max(1, Math.min(168, Number(event.target.value) || 1)) * 3600000) },
        })),
        h('label', { className: 'dsh-mobile-settings-switch' },
          h('input', {
            type: 'checkbox', checked: draft.allowWorkspaceSelection, disabled,
            onChange: (event) => { set('allowWorkspaceSelection', event.target.checked) },
          }),
          '允许在已配置的工作区范围内选择工作区',
        ),
        !state.writable ? h('p', null, '当前设置为只读。') : null,
        h('button', { type: 'button', disabled, onClick: () => { void save() } }, saving ? '保存中…' : '保存手机端设置'),
      )
    }

    const inject = ['slots', 'settingsScope']

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS })
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'mobile-remote',
        order: 13,
        label: '手机端',
        inject: () => ({
          hooks: { mobileRemoteSettings: scope },
          save: async (value) => {
            await scope.set('title', value.title)
            await scope.set('maxHistoryMessages', value.maxHistoryMessages)
            await scope.set('sessionTtlMs', value.sessionTtlMs)
            await scope.set('allowWorkspaceSelection', value.allowWorkspaceSelection)
          },
        }),
      }, MobileSettingsSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
