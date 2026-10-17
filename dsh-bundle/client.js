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

.gw-prov{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.gw-prow{display:flex;align-items:center;gap:8px;width:100%;padding:12px 14px;background:transparent;border:0;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;text-align:left}
.gw-prow:hover{background:var(--dsw-alias-bg-layer-2)}
.gw-prow.add .gw-pname{color:var(--dsw-alias-label-secondary)}
.gw-chev{flex:none;width:14px;color:var(--dsw-alias-label-secondary)}
.gw-pname{font-weight:600}
.gw-psub{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.gw-tag{flex:none;margin-left:auto;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.gw-tag+.gw-tag{margin-left:6px}
.gw-tag.warn{color:var(--dsw-alias-warn-primary,#d97706);border-color:currentColor}
.gw-editor{border-top:1px solid var(--dsw-alias-border-l1);padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.gw-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin:4px 0}
.gw-tabs{display:flex;gap:6px;margin-bottom:6px}
.gw-tab{flex:none;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px}
.gw-tab.on{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-label-primary);font-weight:600}
.gw-models-box{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;margin:4px 0}
.gw-mlabel{font-size:12px;color:var(--dsw-alias-label-secondary)}
.gw-mrow{display:flex;gap:6px}
.gw-mrow input{flex:1;min-width:0;height:28px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 8px;font-size:12px}
.gw-mrow input.gw-num{flex:none;width:80px}
.gw-x{flex:none;width:26px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px}
.gw-x:hover{color:var(--dsw-alias-state-error)}
.gw-cand{display:flex;align-items:center;gap:8px;font-size:12px;padding:2px 0}
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
    // Shaped like dsh's own Models page: one row per provider, click to expand
    // the editor card (one at a time), an add-provider card at the bottom with
    // the two native modes — pick a catalogue provider, or declare a custom
    // API (id + endpoint + protocol + discovered models).
    function ModelPage({ t }) {
      const [data, setData] = React.useState(null)
      const [expanded, setExpanded] = React.useState(null) // provider id | 'add'
      const [draft, setDraft] = React.useState({})         // per-provider edits
      const [addTab, setAddTab] = React.useState('catalog')
      const [addForm, setAddForm] = React.useState({ id: '', displayName: '', baseURL: '', protocol: 'openai-completions', apiKey: '', candidates: null, picked: {}, models: [{ id: '', name: '', contextWindow: '' }] })
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      function fmt(text) { return String(text ?? '') }
      function load() {
        return fetch('/__gateway/api/model-providers')
          .then(r => r.json())
          .then(ans => {
            if (!ans.ok) throw new Error(ans.error || 'HTTP error')
            setData({ providers: ans.providers ?? [], defaultModel: ans.defaultModel ?? {} })
          })
      }
      React.useEffect(() => {
        let alive = true
        load().catch(err => { if (alive) setMsg({ kind: 'bad', text: fmt(t('loadFail', { err: err.message })) }) })
        return () => { alive = false }
      }, [])

      async function post(body) {
        setBusy(true); setMsg(null)
        try {
          const ans = await (await fetch('/__gateway/api/model-config', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })).json()
          if (!ans.ok) { setMsg({ kind: 'bad', text: ans.error || 'HTTP error' }); return false }
          setData({ providers: ans.providers ?? [], defaultModel: ans.defaultModel ?? {} })
          setMsg({ kind: 'ok', text: fmt(t('saved', { changed: (ans.changed ?? []).join('、') })) })
          return true
        } catch (err) { setMsg({ kind: 'bad', text: err.message }); return false }
        finally { setBusy(false) }
      }

      function draftOf(id) {
        return draft[id] ?? { apiKey: '', baseURL: '', displayName: '', models: null }
      }
      function setDraftOf(id, patch) {
        setDraft(d => ({ ...d, [id]: { ...draftOf(id), ...patch } }))
      }

      async function saveProvider(p) {
        const d = draftOf(p.provider)
        const ok = await post({
          provider: p.provider,
          apiKey: d.apiKey,
          baseURL: p.custom || p.profile ? d.baseURL : undefined,
          displayName: p.custom ? d.displayName : undefined,
          models: p.custom && d.models ? d.models.filter(m => m.id.trim() !== '') : undefined,
        })
        if (ok) setDraftOf(p.provider, { apiKey: '' })
      }
      async function removeProvider(p) {
        if (!window.confirm(fmt(t('removeConfirm', { name: p.label })))) return
        const ok = await post({ provider: p.provider, remove: true })
        if (ok) { setExpanded(null); setDraft(d => { const n = { ...d }; delete n[p.provider]; return n }) }
      }

      async function discoverDraft() {
        setBusy(true); setMsg(null)
        try {
          const ans = await (await fetch('/__gateway/api/models/discover', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              provider: addForm.id.trim() || 'draft',
              baseURL: addForm.baseURL, api: addForm.protocol, apiKey: addForm.apiKey,
            }),
          })).json()
          if (!ans.ok) { setMsg({ kind: 'bad', text: ans.error || 'HTTP error' }); return }
          if (ans.models.length === 0) { setMsg({ kind: 'bad', text: fmt(t('fetchNone')) }); return }
          setAddForm(f => ({ ...f, candidates: ans.models, picked: Object.fromEntries(ans.models.map(m => [m.id, true])) }))
          setMsg({ kind: 'info', text: fmt(t('pickModel', { n: ans.models.length })) })
        } catch (err) { setMsg({ kind: 'bad', text: err.message }) }
        finally { setBusy(false) }
      }
      async function createCustom() {
        const picked = addForm.candidates ? addForm.candidates.filter(m => addForm.picked[m.id]) : []
        const manual = (addForm.models ?? []).map(m => ({ ...m })).filter(m => m.id.trim() !== '')
        const models = picked.length > 0 ? picked : manual
        const ok = await post({
          provider: addForm.id.trim(),
          displayName: addForm.displayName,
          baseURL: addForm.baseURL,
          protocol: addForm.protocol,
          apiKey: addForm.apiKey,
          models,
        })
        if (ok) {
          setAddForm({ id: '', displayName: '', baseURL: '', protocol: addForm.protocol, apiKey: '', candidates: null, picked: {}, models: [{ id: '', name: '', contextWindow: '' }] })
          setExpanded(null)
        }
      }

      if (!data) return React.createElement('div', { className: 'gw-panel' }, React.createElement('style', null, CSS), fmt(t('loading')))
      const isDefault = p => data.defaultModel.provider === p.provider
      // Only rows with something configured stay on the page: the account
      // route, keyed routes and custom profiles. Everything else is offered by
      // the add-provider card instead of cluttering the list.
      const visible = data.providers.filter(p => !p.configurable || p.keyConfigured || p.profile !== null)
      const catalogOptions = data.providers.filter(p => p.configurable && p.profile === null && !p.keyConfigured)

      function editorModels(p) {
        const d = draftOf(p.provider)
        const rows = d.models ?? (p.profile?.models ?? []).map(m => ({ id: m.id, name: m.label !== m.id ? m.label : '', contextWindow: m.contextWindow ?? '' }))
        const setRows = models => setDraftOf(p.provider, { models })
        return React.createElement('div', { className: 'gw-models-box' },
          React.createElement('div', { className: 'gw-mlabel' }, fmt(t('catalog'))),
          rows.map((m, i) => React.createElement('div', { className: 'gw-mrow', key: i },
            React.createElement('input', { value: m.id, placeholder: 'model-id', spellCheck: false, disabled: !p.custom,
              onChange: e => { const n = rows.slice(); n[i] = { ...m, id: e.target.value }; setRows(n) } }),
            React.createElement('input', { value: m.name ?? '', placeholder: fmt(t('modelName')), spellCheck: false, disabled: !p.custom,
              onChange: e => { const n = rows.slice(); n[i] = { ...m, name: e.target.value }; setRows(n) } }),
            React.createElement('input', { className: 'gw-num', value: m.contextWindow ?? '', placeholder: 'context', disabled: !p.custom,
              onChange: e => { const n = rows.slice(); n[i] = { ...m, contextWindow: e.target.value }; setRows(n) } }),
            p.custom ? React.createElement('button', { className: 'gw-x', type: 'button', title: fmt(t('removeModel')),
              onClick: () => setRows(rows.filter((_, j) => j !== i)) }, '✕') : null)),
          p.custom ? React.createElement('button', { className: 'gw-btn', type: 'button',
            onClick: () => setRows([...rows, { id: '', name: '', contextWindow: '' }]) }, '+ ' + fmt(t('addModel'))) : null,
        )
      }

      function editorCard(p) {
        const d = draftOf(p.provider)
        const custom = p.custom
        return React.createElement('div', { className: 'gw-editor' },
          custom ? React.createElement('div', { className: 'gw-row' },
            React.createElement('label', null, fmt(t('displayName'))),
            React.createElement('input', { value: d.displayName || p.profile?.displayName || '', spellCheck: false,
              onChange: e => setDraftOf(p.provider, { displayName: e.target.value }) })) : null,
          custom ? React.createElement('div', { className: 'gw-row' },
            React.createElement('label', null, 'Base URL'),
            React.createElement('input', { value: d.baseURL || p.profile?.baseURL || '', placeholder: 'https://…/v1', spellCheck: false,
              onChange: e => setDraftOf(p.provider, { baseURL: e.target.value }) })) : null,
          p.profile === null && !custom ? React.createElement('div', { className: 'gw-note' }, fmt(t('accountNote'))) : null,
          React.createElement('div', { className: 'gw-row' },
            React.createElement('label', null, fmt(t('apiKey'))),
            React.createElement('input', { type: 'password', autoComplete: 'new-password', value: d.apiKey,
              placeholder: p.keyConfigured ? fmt(t('apiKeySet', { ref: p.keyRef ?? '' })) : fmt(t('apiKeyHint')),
              onChange: e => setDraftOf(p.provider, { apiKey: e.target.value }) })),
          p.profile && p.profile.models.length > 0 || custom ? editorModels(p) : null,
          React.createElement('div', { className: 'gw-row' },
            React.createElement('button', { className: 'gw-btn pri', type: 'button', disabled: busy, onClick: () => saveProvider(p) }, fmt(t('save'))),
            custom ? React.createElement('button', { className: 'gw-btn dan', type: 'button', disabled: busy, onClick: () => removeProvider(p) }, fmt(t('remove'))) : null),
        )
      }

      function addCard() {
        return React.createElement('div', { className: 'gw-editor' },
          React.createElement('div', { className: 'gw-tabs' },
            React.createElement('button', { className: 'gw-tab' + (addTab === 'catalog' ? ' on' : ''), type: 'button',
              onClick: () => setAddTab('catalog') }, fmt(t('addCatalog'))),
            React.createElement('button', { className: 'gw-tab' + (addTab === 'custom' ? ' on' : ''), type: 'button',
              onClick: () => setAddTab('custom') }, fmt(t('addCustom')))),
          addTab === 'catalog' ? React.createElement('div', null,
            catalogOptions.length === 0
              ? React.createElement('div', { className: 'gw-note' }, fmt(t('catalogEmpty')))
              : React.createElement('div', { className: 'gw-row' },
                React.createElement('label', null, fmt(t('provider'))),
                React.createElement('select', { value: '', onChange: e => e.target.value !== '' && setExpanded(e.target.value) },
                  React.createElement('option', { value: '' }, fmt(t('catalogPick'))),
                  catalogOptions.map(p => React.createElement('option', { key: p.provider, value: p.provider }, p.label)))),
          ) : React.createElement('div', null,
            React.createElement('div', { className: 'gw-row' },
              React.createElement('label', null, 'Provider ID'),
              React.createElement('input', { value: addForm.id, placeholder: 'my-provider', spellCheck: false,
                onChange: e => setAddForm(f => ({ ...f, id: e.target.value })) })),
            React.createElement('div', { className: 'gw-row' },
              React.createElement('label', null, fmt(t('displayName'))),
              React.createElement('input', { value: addForm.displayName, spellCheck: false,
                onChange: e => setAddForm(f => ({ ...f, displayName: e.target.value })) })),
            React.createElement('div', { className: 'gw-row' },
              React.createElement('label', null, 'Base URL'),
              React.createElement('input', { value: addForm.baseURL, placeholder: 'https://…/v1', spellCheck: false,
                onChange: e => setAddForm(f => ({ ...f, baseURL: e.target.value })) })),
            React.createElement('div', { className: 'gw-row' },
              React.createElement('label', null, fmt(t('protocol'))),
              React.createElement('select', { value: addForm.protocol,
                onChange: e => setAddForm(f => ({ ...f, protocol: e.target.value })) },
                ['openai-completions', 'openai-responses', 'anthropic-messages'].map(v => React.createElement('option', { key: v, value: v }, v)))),
            React.createElement('div', { className: 'gw-row' },
              React.createElement('label', null, fmt(t('apiKey'))),
              React.createElement('input', { type: 'password', autoComplete: 'new-password', value: addForm.apiKey,
                placeholder: fmt(t('apiKeyHint')),
                onChange: e => setAddForm(f => ({ ...f, apiKey: e.target.value })) }),
              React.createElement('button', { className: 'gw-btn', type: 'button', disabled: busy, onClick: discoverDraft }, fmt(t('fetchModels')))),
            !addForm.candidates ? React.createElement('div', { className: 'gw-models-box' },
              React.createElement('div', { className: 'gw-mlabel' }, fmt(t('catalog'))),
              (addForm.models ?? []).map((m, i) => React.createElement('div', { className: 'gw-mrow', key: i },
                React.createElement('input', { value: m.id, placeholder: 'model-id', spellCheck: false,
                  onChange: e => setAddForm(f => { const n = (f.models ?? []).slice(); n[i] = { ...m, id: e.target.value }; return { ...f, models: n } }) }),
                React.createElement('input', { value: m.name ?? '', placeholder: fmt(t('modelName')), spellCheck: false,
                  onChange: e => setAddForm(f => { const n = (f.models ?? []).slice(); n[i] = { ...m, name: e.target.value }; return { ...f, models: n } }) }),
                React.createElement('input', { className: 'gw-num', value: m.contextWindow ?? '', placeholder: 'context',
                  onChange: e => setAddForm(f => { const n = (f.models ?? []).slice(); n[i] = { ...m, contextWindow: e.target.value }; return { ...f, models: n } }) }),
                React.createElement('button', { className: 'gw-x', type: 'button', title: fmt(t('removeModel')),
                  onClick: () => setAddForm(f => ({ ...f, models: (f.models ?? []).filter((_, j) => j !== i) })) }, '✕'))),
              React.createElement('button', { className: 'gw-btn', type: 'button',
                onClick: () => setAddForm(f => ({ ...f, models: [...(f.models ?? []), { id: '', name: '', contextWindow: '' }] })) },
                '+ ' + fmt(t('addModel')))) : null,
            addForm.candidates ? React.createElement('div', { className: 'gw-models-box' },
              addForm.candidates.map(m => React.createElement('label', { className: 'gw-cand', key: m.id },
                React.createElement('input', { type: 'checkbox', checked: addForm.picked[m.id] === true,
                  onChange: e => setAddForm(f => ({ ...f, picked: { ...f.picked, [m.id]: e.target.checked } })) }),
                React.createElement('span', null, m.id + (m.label !== m.id ? ' — ' + m.label : '')))))
              : null,
            React.createElement('div', { className: 'gw-row' },
              React.createElement('button', { className: 'gw-btn pri', type: 'button', disabled: busy || addForm.id.trim() === '' || addForm.baseURL.trim() === '',
                onClick: createCustom }, fmt(t('create'))))),
        )
      }

      return React.createElement('div', { className: 'gw-panel' },
        React.createElement('style', null, CSS),
        msg && React.createElement('div', { className: 'gw-msg ' + msg.kind }, fmt(msg.text)),
        visible.map(p => React.createElement('div', { className: 'gw-prov', key: p.provider },
          React.createElement('button', { className: 'gw-prow', type: 'button',
            onClick: () => setExpanded(expanded === p.provider ? null : p.provider) },
            React.createElement('span', { className: 'gw-chev' }, expanded === p.provider ? '▾' : '▸'),
            React.createElement('span', { className: 'gw-pname' }, p.label),
            p.profile?.baseURL ? React.createElement('span', { className: 'gw-psub' }, p.profile.baseURL) : null,
            isDefault(p) ? React.createElement('span', { className: 'gw-tag' }, fmt(t('defaultTag'))) : null,
            !p.keyConfigured && p.configurable ? React.createElement('span', { className: 'gw-tag warn' }, fmt(t('noKeyTag'))) : null,
            p.custom ? React.createElement('span', { className: 'gw-tag' }, fmt(t('customTag'))) : null),
          expanded === p.provider ? editorCard(p) : null)),
        React.createElement('div', { className: 'gw-prov' },
          React.createElement('button', { className: 'gw-prow add', type: 'button',
            onClick: () => setExpanded(expanded === 'add' ? null : 'add') },
            React.createElement('span', { className: 'gw-chev' }, expanded === 'add' ? '▾' : '▸'),
            React.createElement('span', { className: 'gw-pname' }, fmt(t('addProvider')))),
          expanded === 'add' ? addCard() : null),
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
      fetching: '正在获取…', fetchNone: '没有发现模型，请检查端点与密钥，或手工填写模型 id。',
      loading: '加载中…', displayName: '显示名称', catalog: '模型目录', modelName: '显示名', addModel: '添加模型', removeModel: '移除',
      save: '保存', remove: '删除提供商', removeConfirm: '删除提供商「{name}」？其配置将从 dsh 中移除。',
      accountNote: '此提供商使用 dsh 账号登录，无需 API Key。', defaultTag: '默认', noKeyTag: '未配置密钥', customTag: '自定义',
      addProvider: '添加模型提供商', addCatalog: '第三方模型提供商', addCustom: '自定义模型 API',
      catalogPick: '选择提供商…', catalogEmpty: '目录中的第三方提供商都已配置。', protocol: '协议', create: '创建提供商',
      loadFail: '无法连接网关：{err}', pickModel: 'dsh 报出 {n} 个模型，选一个即可。',
    }
    const EN = {
      section: 'Gateway', modelsSection: 'Models', account: 'Account', modelTitle: 'Model configuration', provider: 'Provider', apiKey: 'API Key',
      apiKeySet: 'Configured ({ref}); leave blank to keep', apiKeyHint: 'Paste provider API key', model: 'Default model',
      fetchModels: 'Fetch models', save: 'Save and inject', openAdmin: 'Open admin console', restart: 'Restart dsh',
      restartConfirm: 'Restart your own dsh process? It recovers in seconds; unsaved drafts may be lost.',
      restartFail: 'Restart failed: {err}', signOut: 'Sign out', saved: 'Saved and injected: {changed}',
      fetching: 'Fetching…', fetchNone: 'No models discovered; check the endpoint and key, or type model ids manually.',
      loading: 'Loading…', displayName: 'Display name', catalog: 'Model catalogue', modelName: 'Label', addModel: 'Add model', removeModel: 'Remove',
      save: 'Save', remove: 'Remove provider', removeConfirm: 'Remove provider "{name}"? Its configuration is deleted from dsh.',
      accountNote: 'This provider signs in with your dsh account; no API key needed.', defaultTag: 'Default', noKeyTag: 'No key', customTag: 'Custom',
      addProvider: 'Add model provider', addCatalog: 'Catalogue provider', addCustom: 'Custom model API',
      catalogPick: 'Pick a provider…', catalogEmpty: 'Every catalogue provider is configured.', protocol: 'Protocol', create: 'Create provider',
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
