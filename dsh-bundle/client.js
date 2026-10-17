/**
 * @local/gateway-panel — the gateway's account panel as a dsh Settings sections.
 *
 * Replaces the floating avatar the gateway used to inject into relayed shells.
 * Two Settings entries:
 *   - 「模型」 (order 79): the gateway-backed model configuration. dsh's own
 *     Models page cannot work in gateway mode, so when running behind the
 *     gateway we hide that native nav entry and take its place.
 *   - 「网关」 (order 80): account (sign out, admin console) and restart dsh.
 * The two entries are registered adjacently on purpose: the only reliable way
 * to tell our 模型 nav cell apart from the native one is that ours is the one
 * immediately followed by the 网关 cell.
 * Every request goes to the gateway origin itself, so no CORS and no second
 * sign-in are involved.
 */
(window.__ModuleLoader__).load({
  id: '@local/gateway-panel',
  factory(require) {
    const React = require('react')

    const CSS = `
.gw-panel{padding:20px 24px;max-width:640px;color:var(--dsw-alias-label-primary);font-size:13px;display:flex;flex-direction:column;gap:16px}
.gw-panel h3{margin:0 0 10px;font-size:14px}
.gw-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.gw-row{display:flex;align-items:center;gap:10px;margin:8px 0}
.gw-row label{width:90px;flex:none;color:var(--dsw-alias-label-secondary)}
.gw-row input,.gw-row select{flex:1;min-width:0;height:30px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:13px;outline:none}
.gw-row input:focus,.gw-row select:focus{border-color:var(--dsw-alias-brand-primary)}
.gw-btn{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;white-space:nowrap}
.gw-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.gw-btn.pri{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.gw-btn.dan{color:var(--dsw-alias-state-error)}
.gw-btn:disabled{opacity:.5;cursor:default}
.gw-msg{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary);min-height:16px}
.gw-msg.bad{color:var(--dsw-alias-state-error)}
.gw-msg.ok{color:var(--dsw-alias-success)}
.gw-models{width:100%;margin-top:8px;height:30px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.gw-who{font-size:13px}
.gw-badge{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
`

    function useGatewayJson(url, onFail) {
      // returns [value, setValue] loaded once; onFail receives the error message
      const [value, setValue] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then(ans => { if (alive) setValue(ans) })
          .catch(err => { if (alive && onFail) onFail(err.message) })
        return () => { alive = false }
      }, [])
      return [value, setValue]
    }

    // ---------------------------------------------------------------- 模型 --
    function ModelPage({ t }) {
      const [cfg, setCfg] = React.useState(null)
      const [apiKey, setApiKey] = React.useState('')
      const [model, setModel] = React.useState('')
      const [models, setModels] = React.useState(null)
      const [msg, setMsg] = React.useState(null) // {kind:'ok'|'bad'|'info', text}
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        fetch('/__gateway/api/model-config')
          .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then(ans => {
            if (!alive) return
            if (ans.ok) {
              setCfg(ans.config)
              setModel(ans.config.model ?? '')
            } else setMsg({ kind: 'bad', text: ans.error || 'load failed' })
          })
          .catch(err => { if (alive) setMsg({ kind: 'bad', text: fmt(t('loadFail', { err: err.message })) }) })
        return () => { alive = false }
      }, [])

      function fmt(text) { return String(text ?? '') }

      async function fetchModels() {
        if (!cfg?.provider) { setMsg({ kind: 'bad', text: fmt(t('fetchNone')) }); return }
        setBusy(true); setMsg({ kind: 'info', text: fmt(t('fetching')) })
        try {
          const ans = await (await fetch('/__gateway/models?provider=' + encodeURIComponent(cfg.provider), { headers: { accept: 'application/json' } })).json()
          if (!ans.ok || ans.models.length === 0) {
            setModels(null); setMsg({ kind: 'bad', text: ans.error || fmt(t('fetchNone')) }); return
          }
          setModels(ans.models)
          setMsg({ kind: 'info', text: fmt(t('pickModel', { n: ans.models.length })) })
        } catch (err) { setMsg({ kind: 'bad', text: err.message }) }
        finally { setBusy(false) }
      }

      async function save() {
        setBusy(true); setMsg(null)
        try {
          const ans = await (await fetch('/__gateway/api/model-config', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ provider: cfg?.provider ?? '', apiKey, model }),
          })).json()
          if (!ans.ok) { setMsg({ kind: 'bad', text: ans.error || 'save failed' }); return }
          setApiKey('')
          if (ans.config) setCfg(ans.config)
          setMsg({ kind: 'ok', text: fmt(t('saved', { changed: (ans.changed ?? []).join('、') })) })
        } catch (err) { setMsg({ kind: 'bad', text: err.message }) }
        finally { setBusy(false) }
      }

      const provider = cfg?.provider ?? ''
      const options = cfg?.options ?? []
      return React.createElement('div', { className: 'gw-panel' },
        React.createElement('style', null, CSS),
        msg && React.createElement('div', { className: 'gw-msg ' + msg.kind }, fmt(msg.text)),
        React.createElement('div', { className: 'gw-card' },
          React.createElement('h3', null, fmt(t('modelTitle'))),
          React.createElement('div', { className: 'gw-row' },
            React.createElement('label', null, fmt(t('provider'))),
            React.createElement('select', {
              value: provider,
              disabled: options.length === 0,
              onChange: e => { setCfg({ ...cfg, provider: e.target.value }); setModels(null) },
            }, options.length === 0
              ? React.createElement('option', { value: '' }, '—')
              : options.map(o => React.createElement('option', { key: o.provider, value: o.provider },
                (o.label ?? o.provider) + (o.active ? '' : ' (not registered)'))))),
          React.createElement('div', { className: 'gw-row' },
            React.createElement('label', null, fmt(t('apiKey'))),
            React.createElement('input', {
              type: 'password', autoComplete: 'new-password', value: apiKey,
              placeholder: cfg?.keyConfigured ? fmt(t('apiKeySet', { ref: cfg.keyRef ?? '' })) : fmt(t('apiKeyHint')),
              onChange: e => setApiKey(e.target.value),
            })),
          React.createElement('div', { className: 'gw-row' },
            React.createElement('label', null, fmt(t('model'))),
            React.createElement('input', {
              value: model, placeholder: 'deepseek-flash', spellCheck: false,
              onChange: e => setModel(e.target.value),
            }),
            React.createElement('button', { className: 'gw-btn', type: 'button', onClick: fetchModels, disabled: busy }, fmt(t('fetchModels')))),
          models && React.createElement('select', {
            className: 'gw-models', value: model,
            onChange: e => setModel(e.target.value),
          }, models.map(m => React.createElement('option', { key: m.id, value: m.id },
            m.label && m.label !== m.id ? m.id + ' — ' + m.label : m.id))),
          React.createElement('div', { className: 'gw-row' },
            React.createElement('button', { className: 'gw-btn pri', type: 'button', onClick: save, disabled: busy || !cfg }, fmt(t('save'))))),
      )
    }

    // ---------------------------------------------------------------- 网关 --
    function AccountPage({ t }) {
      const [me, setMe] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        fetch('/__gateway/api/me')
          .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then(ans => { if (alive) setMe(ans) })
          .catch(err => { if (alive) setMsg({ kind: 'bad', text: fmt(t('loadFail', { err: err.message })) }) })
        return () => { alive = false }
      }, [])

      function fmt(text) { return String(text ?? '') }

      async function restart() {
        if (!window.confirm(fmt(t('restartConfirm')))) return
        setBusy(true)
        try {
          const r = await fetch('/__gateway/restart', { method: 'POST' })
          if (!r.ok) throw new Error('HTTP ' + r.status)
          window.location.reload()
        } catch (err) {
          setMsg({ kind: 'bad', text: fmt(t('restartFail', { err: err.message })) })
          setBusy(false)
        }
      }

      async function signOut() {
        try { await fetch('/__gateway/logout', { method: 'POST', redirect: 'manual' }) } catch {}
        window.location.href = '/__gateway/login'
      }

      return React.createElement('div', { className: 'gw-panel' },
        React.createElement('style', null, CSS),
        msg && React.createElement('div', { className: 'gw-msg ' + msg.kind }, fmt(msg.text)),
        React.createElement('div', { className: 'gw-card' },
          React.createElement('h3', null, fmt(t('account'))),
          React.createElement('div', { className: 'gw-who' },
            me?.user ?? '…',
            me?.admin ? React.createElement('span', { className: 'gw-badge' }, 'admin') : null),
          React.createElement('div', { className: 'gw-row' },
            React.createElement('button', { className: 'gw-btn dan', onClick: signOut, disabled: busy }, fmt(t('signOut'))),
            me?.admin ? React.createElement('a', { href: '/__gateway/admin', target: '_blank', rel: 'noreferrer', style: { textDecoration: 'none' } },
              React.createElement('button', { className: 'gw-btn', type: 'button' }, fmt(t('openAdmin')))) : null)),
        React.createElement('div', { className: 'gw-card' },
          React.createElement('button', { className: 'gw-btn', type: 'button', onClick: restart, disabled: busy }, fmt(t('restart')))),
      )
    }

    const ZH = {
      section: '网关', modelsSection: '模型', account: '账户', modelTitle: '模型配置', provider: '服务商', apiKey: 'API Key',
      apiKeySet: '已配置（{ref}），留空保持不变', apiKeyHint: '粘贴服务商 API Key', model: '默认模型',
      fetchModels: '获取模型', save: '保存并注入', openAdmin: '打开管理控制台', restart: '重启 dsh',
      restartConfirm: '重启你自己的 dsh 进程？几秒钟后自动恢复，未保存的对话草稿可能丢失。',
      restartFail: '重启失败：{err}', signOut: '退出登录', saved: '已保存并注入：{changed}',
      fetching: '正在获取…', fetchNone: 'dsh 没有报出模型，请手工填写模型 id。',
      loadFail: '无法连接网关：{err}', pickModel: 'dsh 报出 {n} 个模型，选一个即可。',
    }
    const EN = {
      section: 'Gateway', modelsSection: 'Models', account: 'Account', modelTitle: 'Model configuration', provider: 'Provider', apiKey: 'API Key',
      apiKeySet: 'Configured ({ref}); leave blank to keep', apiKeyHint: 'Paste provider API key', model: 'Default model',
      fetchModels: 'Fetch models', save: 'Save and inject', openAdmin: 'Open admin console', restart: 'Restart dsh',
      restartConfirm: 'Restart your own dsh process? It recovers in seconds; unsaved drafts may be lost.',
      restartFail: 'Restart failed: {err}', signOut: 'Sign out', saved: 'Saved and injected: {changed}',
      fetching: 'Fetching…', fetchNone: 'dsh listed no models; type the model id manually.',
      loadFail: 'Cannot reach the gateway: {err}', pickModel: '{n} models listed; pick one.',
    }

    // Hide dsh's own 模型 settings nav entry when running behind the gateway:
    // it cannot work there. Our own 模型 entry is identified as the nav cell
    // immediately followed by the 网关 cell (they are registered adjacently).
    function startHideNativeModels() {
      const navCells = () => [...document.querySelectorAll('button')]
        .filter(b => b.textContent?.trim() && b.parentElement?.querySelectorAll('button').length >= 4)
      function sweep() {
        const cells = navCells()
        const modelsBtns = cells.filter(b => b.textContent.trim() === label('模型', 'Models'))
        if (modelsBtns.length === 0) return
        const isNav = modelsBtns.some(b => cells.some(c => c !== b && c.parentElement === b.parentElement))
        if (!isNav) return
        for (const b of modelsBtns) {
          const next = b.nextElementSibling
          const ours = next && next.tagName === 'BUTTON' &&
            (next.textContent.trim() === label('网关', 'Gateway'))
          if (!ours) b.style.display = 'none'
        }
      }
      sweep()
      new MutationObserver(sweep).observe(document.body, { childList: true, subtree: true })
    }
    function label(zh, en) {
      return String(document.documentElement.lang ?? 'zh').startsWith('zh') ? zh : en
    }

    function apply(ctx) {
      try { ctx.locale.register('gateway-panel', 'zh', ZH) } catch {}
      try { ctx.locale.register('gateway-panel', 'en', EN) } catch {}
      let t
      try {
        t = ctx.locale.bind('gateway-panel')
        t('section')
      } catch {
        t = (key, params) => {
          const dict = String(document.documentElement.lang ?? 'zh').startsWith('zh') ? ZH : EN
          let text = dict[key] ?? key
          if (params) for (const [k, v] of Object.entries(params)) text = text.split('{' + k + '}').join(String(v))
          return text
        }
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'gateway-models', order: 79, label: () => safeLabel(t, 'modelsSection', '模型') },
        props => React.createElement(ModelPage, { t: withParams(t, props) }),
      ))
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'gateway', order: 80, label: () => safeLabel(t, 'section', '网关') },
        props => React.createElement(AccountPage, { t: withParams(t, props) }),
      ))
      // Only behind the gateway do we replace the native Models entry.
      fetch('/__gateway/api/me').then(r => { if (r.ok) startHideNativeModels() }).catch(() => {})
    }

    function safeLabel(t, key, fallback) {
      try { return t(key) } catch { return fallback }
    }
    function withParams(t, _props) {
      return (key, params) => {
        let text
        try { text = t(key, params) } catch { text = key }
        if (params && typeof text === 'string') {
          for (const [k, v] of Object.entries(params)) text = text.replaceAll('{' + k + '}', String(v))
        }
        return text
      }
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
