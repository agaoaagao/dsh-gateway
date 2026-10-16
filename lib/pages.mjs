/**
 * The pages the gateway serves from its own origin: sign-in, the per-user model
 * configuration, and the admin console.
 *
 * They are template strings rather than a build step on purpose. The gateway's
 * whole value is that it owns the entry point and depends on nothing, and a
 * bundler would add a toolchain to audit for a few screens of HTML.
 */

/** Escape a value for interpolation into HTML text or an attribute. */
export const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

const LOGIN_STYLE = `
 body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}
 form{background:#1c1c1e;padding:28px;border-radius:12px;width:min(340px,88vw)}
 h1{font-size:20px;margin:0 0 18px}
 label{display:block;font-size:13px;margin:12px 0 6px;color:#aaa}
 input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #333;background:#000;color:#eee;font-size:16px}
 button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:8px;background:#eee;color:#111;font-size:16px;font-weight:600}
 .err{color:#ff6b6b;font-size:13px;margin-top:12px;min-height:18px}
 .switch label{display:block;flex:1;text-align:center;padding:9px 6px;border-radius:999px;font-size:13px;cursor:pointer;color:#9a9aa5;margin:0;background:transparent}
 .switch label.on{background:#e8e8ea;color:#111;font-weight:600}
 .switch input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
`

/**
 * The two-mode switch shared by the sign-in page and the configuration page.
 *
 * It is a pair of radio buttons inside a form on the sign-in page (so the choice
 * can be part of the sign-in post) and a pair of links on the configuration
 * page, where it is pure navigation. Both spell the modes the same way, because
 * it is the same control from the user's point of view.
 */
const SWITCH_STYLE = `
 .switch{display:flex;gap:4px;background:#000;border:1px solid #2c2c34;border-radius:999px;padding:4px;margin:0}
 .switch a,.switch span{flex:1;text-align:center;padding:9px 6px;border-radius:999px;font-size:13px;text-decoration:none;color:#9a9aa5}
 .switch a:hover{color:#e8e8ea}
 .switch .on{background:#e8e8ea;color:#111;font-weight:600}
`

/**
 * The sign-in page.
 *
 * `next` is where to go after a successful sign-in. It exists because the admin
 * console requires a session: without it, an administrator who follows a link to
 * `/__gateway/admin` while signed out lands in the workspace after signing in,
 * with no sign that the page they asked for exists.
 *
 * The switch chooses between the two destinations directly: "DeepSeek Harness"
 * continues to `next` (the workspace), "configure" continues to the gateway's
 * own provider form. The script only keeps the hidden field in step so the
 * choice reads as one control; the post carries `mode` as well, so the choice is
 * honoured even with scripting off.
 *
 * @param error - message to show, or an empty string.
 * @param next - path to return to after signing in, or an empty string.
 * @param mode - which switch position to render as selected.
 * @returns HTML.
 */
export const loginPage = (error = '', next = '', mode = 'dsh') => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title>
<style>${LOGIN_STYLE}${SWITCH_STYLE}</style>
<form method="POST" action="/__gateway/login" id="loginForm">
 <h1>Sign in</h1>
 <div class="switch" id="modeSwitch">
  <label data-mode="dsh"><input type="radio" name="mode" value="dsh"${mode === 'setting' ? '' : ' checked'}>DeepSeek Harness</label>
  <label data-mode="setting"><input type="radio" name="mode" value="setting"${mode === 'setting' ? ' checked' : ''}>配置模型</label>
 </div>
 <label for="u">User name</label>
 <input id="u" name="name" autocomplete="username" required>
 <label for="p">Password</label>
 <input id="p" name="password" type="password" autocomplete="current-password" required>
 <input type="hidden" name="next" id="nextInput" value="${escapeHtml(next)}">
 <button type="submit">Continue</button>
 <div class="err">${escapeHtml(error)}</div>
</form>
<script>
 (() => {
  const fallback = ${JSON.stringify(next === '' ? '/' : next)}
  const sync = () => {
   const chosen = document.querySelector('input[name=mode]:checked')
   const mode = chosen === null ? 'dsh' : chosen.value
   document.getElementById('nextInput').value = mode === 'setting' ? '/__gateway/settings' : fallback
   for (const label of document.querySelectorAll('#modeSwitch label')) {
    label.classList.toggle('on', label.dataset.mode === mode)
   }
  }
  for (const radio of document.querySelectorAll('input[name=mode]')) radio.addEventListener('change', sync)
  sync()
 })()
</script>`

const ADMIN_STYLE = `
 :root{color-scheme:dark}
 body{font:14px system-ui;margin:0;background:#0e0e10;color:#e8e8ea}
 header{padding:14px 20px;border-bottom:1px solid #26262b;display:flex;justify-content:space-between;align-items:center}
 h1{font-size:16px;margin:0}
 main{padding:20px;max-width:1050px;margin:0 auto}
 section{margin-bottom:28px}
 h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8b8b95;margin:0 0 10px}
 table{width:100%;border-collapse:collapse;background:#16161a;border-radius:10px;overflow:hidden}
 th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #22222a;font-size:13px;vertical-align:middle}
 th{color:#8b8b95;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
 tr:last-child td{border-bottom:0}
 .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
 .on{background:#14351f;color:#5ddc8a}.off{background:#3a1a1a;color:#ff8b8b}.adm{background:#1d2b47;color:#8ab6ff}
 button{background:#26262e;color:#e8e8ea;border:0;border-radius:7px;padding:6px 11px;font-size:12px;cursor:pointer;margin-right:6px}
 button:hover{background:#33333d}
 button.pri{background:#e8e8ea;color:#111;font-weight:600}
 button.dan{background:#3a1a1a;color:#ff8b8b}
 form.add{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#16161a;padding:12px;border-radius:10px}
 input[type=text],input[type=password]{background:#000;border:1px solid #2c2c34;color:#eee;border-radius:7px;padding:7px 9px;font-size:13px}
 .msg{min-height:18px;font-size:13px;margin-top:8px}
 .ok{color:#5ddc8a}.bad{color:#ff8b8b}
 .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#9a9aa5}
 .nowrap{white-space:nowrap}
 .empty{color:#6b6b75;padding:14px}
 .row{display:flex;gap:8px;align-items:center}
`

/**
 * The admin console.
 *
 * Deliberately a tiny fetch-and-rerender SPA: it has to work from a phone on the
 * same LAN, and every byte shipped here is a byte the gateway must keep
 * depending on nothing to serve.
 * @returns HTML.
 */
export const adminPage = () => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gateway admin</title>
<style>${ADMIN_STYLE}</style>
<header>
 <h1>dsh gateway — admin</h1>
 <div class="row">
  <span class="mono" id="who"></span>
  <a href="/"><button>Open dsh</button></a>
  <button class="dan" id="logout">Sign out</button>
 </div>
</header>
<main>
 <section>
  <h2>Users</h2>
  <table id="users"><tbody></tbody></table>
  <div class="msg" id="msg"></div>
 </section>
 <section>
  <h2>Add a user</h2>
  <form class="add" id="addForm">
   <input type="text" name="name" placeholder="user name" required>
   <input type="password" name="password" placeholder="password (min 8)" required>
   <label class="row"><input type="checkbox" name="admin"> admin</label>
   <button class="pri" type="submit">Create</button>
  </form>
 </section>
 <section>
  <h2>Running dsh processes</h2>
  <table id="instances"><tbody></tbody></table>
 </section>
</main>
<script>
const api = async (path, options) => {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || res.statusText)
  return body
}
const say = (text, ok) => {
  const el = document.getElementById('msg')
  el.textContent = text
  el.className = 'msg ' + (ok ? 'ok' : 'bad')
  if (ok) setTimeout(() => { el.textContent = '' }, 4000)
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))

// Process statistics come from /proc, so they are simply absent on a platform
// without one (macOS, Windows during development). Render that as an em dash
// rather than letting a bare "?MB" read like a fault.
const mb = v => v === undefined || v === null ? '—' : \`\${v}MB\`
const secs = v => v === undefined || v === null ? '—' : \`\${v}s\`
const dur = s => {
  const v = Math.max(0, Math.round(Number(s) || 0))
  if (v >= 3600) return \`\${Math.floor(v / 3600)}h \${Math.floor((v % 3600) / 60)}m\`
  if (v >= 60) return \`\${Math.floor(v / 60)}m \${v % 60}s\`
  return \`\${v}s\`
}

async function render () {
  const state = await api('/__gateway/admin/api/state')
  document.getElementById('who').textContent = state.viewer

  const instances = new Map(state.instances.map(i => [i.user, i]))
  document.querySelector('#users tbody').innerHTML = state.users.map(u => {
    const inst = instances.get(u.name)
    const live = inst
      ? \`<span class="pill on">running</span> <span class="mono">:\${inst.port} · \${dur(inst.uptimeSec)} · \${mb(inst.rssMb)}</span>\`
      : '<span class="mono">stopped</span>'
    return \`<tr>
      <td><strong>\${esc(u.name)}</strong> \${u.admin ? '<span class="pill adm">admin</span>' : ''}</td>
      <td>\${u.enabled ? '<span class="pill on">enabled</span>' : '<span class="pill off">disabled</span>'}</td>
      <td>\${live}</td>
      <td class="mono">\${esc(u.profile)}</td>
      <td style="text-align:right">
        <button data-act="password" data-user="\${esc(u.name)}">Reset password</button>
        <button data-act="toggle" data-user="\${esc(u.name)}" data-on="\${u.enabled}">\${u.enabled ? 'Disable' : 'Enable'}</button>
        \${inst ? \`<button data-act="stop" data-user="\${esc(u.name)}">Stop dsh</button>\` : ''}
        <button class="dan" data-act="delete" data-user="\${esc(u.name)}">Delete</button>
      </td>
    </tr>\`
  }).join('') || '<tr><td class="empty" colspan="5">No users yet.</td></tr>'

  document.querySelector('#instances tbody').innerHTML = state.instances.map(i => \`<tr>
    <td><strong>\${esc(i.user)}</strong></td>
    <td class="mono nowrap">pid \${i.pid}</td>
    <td class="mono nowrap">127.0.0.1:\${i.port}</td>
    <td class="mono nowrap">up \${dur(i.uptimeSec)} · idle \${dur(i.idleSec)}</td>
    <td class="mono nowrap">\${mb(i.rssMb)} · \${secs(i.cpuSec)} cpu</td>
    <td class="mono nowrap">\${i.requests} req · \${i.crashes} crash</td>
    <td class="mono">\${esc(i.home)}</td>
  </tr>\`).join('') || '<tr><td class="empty" colspan="7">No dsh process is running.</td></tr>'
}

document.getElementById('addForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.target
  try {
    await api('/__gateway/admin/api/users', {
      method: 'POST',
      body: JSON.stringify({
        name: form.name.value.trim(),
        password: form.password.value,
        admin: form.admin.checked,
      }),
    })
    form.reset()
    say('User created.', true)
    await render()
  } catch (error) { say(error.message, false) }
})

document.querySelector('main').addEventListener('click', async (event) => {
  const el = event.target.closest('button[data-act]')
  if (el === null) return
  const user = el.dataset.user
  try {
    if (el.dataset.act === 'toggle') {
      await api(\`/__gateway/admin/api/users/\${encodeURIComponent(user)}/enabled\`, {
        method: 'POST', body: JSON.stringify({ enabled: el.dataset.on !== 'true' }),
      })
    } else if (el.dataset.act === 'password') {
      const password = prompt(\`New password for \${user} (min 8 characters)\`)
      if (password === null) return
      await api(\`/__gateway/admin/api/users/\${encodeURIComponent(user)}/password\`, {
        method: 'POST', body: JSON.stringify({ password }),
      })
    } else if (el.dataset.act === 'delete') {
      if (!confirm(\`Delete \${user}? Their dsh home is left on disk.\`)) return
      await api(\`/__gateway/admin/api/users/\${encodeURIComponent(user)}\`, { method: 'DELETE' })
    } else if (el.dataset.act === 'stop') {
      await api(\`/__gateway/admin/api/instances/\${encodeURIComponent(user)}/stop\`, { method: 'POST' })
    }
    await render()
  } catch (error) { say(error.message, false) }
})

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/__gateway/logout', { method: 'POST' })
  location.href = '/'
})

render().catch(error => say(error.message, false))
setInterval(() => render().catch(() => {}), 10000)
</script>`

const SETTINGS_STYLE = `
 :root{color-scheme:dark}
 body{font:14px system-ui;margin:0;background:#0e0e10;color:#e8e8ea}
 header{padding:14px 20px;border-bottom:1px solid #26262b;display:flex;justify-content:space-between;align-items:center;gap:10px}
 h1{font-size:16px;margin:0}
 main{padding:20px;max-width:620px;margin:0 auto}
 .row{display:flex;gap:8px;align-items:center}
 form.cfg{background:#16161a;padding:18px;border-radius:10px}
 label{display:block;font-size:12px;color:#8b8b95;margin:14px 0 6px}
 select,input{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #2c2c34;background:#000;color:#eee;font-size:14px}
 select{margin:0}
 button{background:#26262e;color:#e8e8ea;border:0;border-radius:7px;padding:9px 14px;font-size:13px;cursor:pointer}
 button.pri{width:100%;margin-top:18px;background:#e8e8ea;color:#111;font-weight:600;padding:12px}
 button.dan{background:#3a1a1a;color:#ff8b8b}
 .msg{min-height:18px;font-size:13px;margin-top:12px}
 .ok{color:#5ddc8a}.bad{color:#ff8b8b}
 .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#9a9aa5}
 .note{color:#6b6b75;font-size:12px;line-height:1.6;margin-top:18px}
 .cur{background:#e8e8ea;color:#111;font-weight:600}
 .pick{display:flex;gap:8px;align-items:stretch}
 .pick input{flex:1;min-width:0}
 .pick button{white-space:nowrap}
 #modelList{margin-top:8px}
`

/**
 * The per-user model configuration page.
 *
 * This exists because dsh's own Models settings page cannot work over a LAN: it
 * runs in process-local mode unless the page itself is loopback and then refuses
 * to load at all. The gateway serves the same two writes — a provider credential
 * and the default model — from its own origin, where the request reaches dsh
 * through a trusted authority.
 *
 * @param user - the signed-in account this configuration belongs to.
 * @param config - the state `readModelConfig` returned.
 * @param error - a failure to show above the form, or an empty string.
 * @param notice - a success message to show above the form, or an empty string.
 * @returns HTML.
 */
export const settingsPage = ({ user, config, error = '', notice = '' }) => {
  const options = config.options.map(option => {
    const marks = [option.active ? 'registered' : 'not registered']
    return `<option value="${escapeHtml(option.provider)}"${option.provider === config.provider ? ' selected' : ''}>` +
      `${escapeHtml(option.label)} — ${escapeHtml(marks.join(', '))}</option>`
  }).join('')
  const custom = config.options.some(option => option.provider === config.provider)
  const placeholder = config.keyConfigured
    ? `已配置（${escapeHtml(config.keyRef)}），留空保持不变`
    : '粘贴服务商 API Key'
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>模型配置</title>
<style>${SETTINGS_STYLE}${SWITCH_STYLE}</style>
<header>
 <h1>模型配置</h1>
 <div class="row">
  <span class="mono">${escapeHtml(user)}</span>
  <form method="POST" action="/__gateway/logout"><button class="dan" type="submit">退出登录</button></form>
 </div>
</header>
<main>
 <div class="switch">
  <a href="/">DeepSeek Harness</a><span class="on">配置模型</span>
 </div>
 <form class="cfg" method="POST" action="/__gateway/settings">
  <label for="provider">服务商</label>
  <select id="provider" name="provider"${config.options.length === 0 ? ' disabled' : ''}>
   ${options || '<option value="">没有可选的服务商</option>'}
  </select>
  <label for="apiKey">API Key</label>
  <input id="apiKey" name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${placeholder}">
  <label for="model">默认模型</label>
  <div class="pick">
   <input id="model" name="model" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(config.model)}" placeholder="deepseek-flash">
   <button class="sec" type="button" id="fetchModels">获取模型</button>
  </div>
  <select id="modelList" hidden aria-label="该服务商报出的模型"></select>
  <button class="pri" type="submit"${config.options.length === 0 ? ' disabled' : ''}>保存并注入</button>
  <div class="msg ${notice === '' ? '' : 'ok'}">${escapeHtml(notice)}</div>
  <div class="msg bad">${escapeHtml(error)}</div>
  <div class="msg" id="modelMsg"></div>
  ${custom ? '' : '<div class="msg bad">当前默认服务商不在 dsh 的目录里，选择一个新的服务商再保存。</div>'}
  <div class="note">
   保存会直接写进你自己的 dsh 实例：API Key 存为
   <span class="mono">${escapeHtml(config.keyRef)}</span>，
   并把服务商与默认模型写入该实例的设置。dsh 会校验这两份文档，被拒绝时会在这里给出它自己的原因。<br>
   留空 API Key 只更新默认模型；留空模型只更新 API Key。<br>
   不知道模型 id 就点“获取模型”：网关会让你自己的 dsh 去问该服务商，报出来的模型直接选一个即可。
  </div>
 </form>
</main>
<script>
(function () {
  const button = document.getElementById('fetchModels')
  const provider = document.getElementById('provider')
  const model = document.getElementById('model')
  const list = document.getElementById('modelList')
  const msg = document.getElementById('modelMsg')
  if (button === null || provider === null) return
  button.addEventListener('click', async () => {
    button.disabled = true
    msg.className = 'msg'
    msg.textContent = '正在获取…'
    list.hidden = true
    try {
      const url = '/__gateway/models?provider=' + encodeURIComponent(provider.value)
      const answer = await (await fetch(url, { headers: { accept: 'application/json' } })).json()
      if (!answer.ok || answer.models.length === 0) {
        msg.className = 'msg bad'
        msg.textContent = answer.error || 'dsh 没有报出模型，请手工填写模型 id。'
        return
      }
      list.innerHTML = ''
      for (const entry of answer.models) {
        const option = document.createElement('option')
        option.value = entry.id
        option.textContent = entry.label === entry.id ? entry.id : entry.id + ' — ' + entry.label
        list.append(option)
      }
      list.hidden = false
      list.value = model.value
      msg.textContent = 'dsh 报出 ' + String(answer.models.length) + ' 个模型，选一个即可。'
    } catch (error) {
      msg.className = 'msg bad'
      msg.textContent = '获取失败：' + error.message
    } finally {
      button.disabled = false
    }
  })
  list.addEventListener('change', () => { model.value = list.value })
})()
</script>`
}

/**
 * Add the gateway's own controls to a dsh page.
 *
 * dsh's interface has no way out of the gateway session and no reachable settings
 * page over a LAN, so the gateway injects both into the document it relays. The
 * sign-out is a POST form, which needs no JavaScript; the restart control is a
 * small script, and dsh sends no CSP, so nothing here has to be allowed for.
 *
 * Only a document response is passed here; the caller checks the content type.
 *
 * The user console is only offered to administrators, because that is the only
 * audience the route serves: a non-administrator following the link would be
 * bounced straight back to the sign-in page.
 *
 * @param html - dsh's document body.
 * @param options - set `admin` to add the user-management link.
 * @returns the same document with the gateway controls before `</body>`.
 */
export const injectGatewayControls = (html, { admin = false } = {}) => {
  const adminLink = admin ? '\n  <a href="/__gateway/admin">用户管理</a>' : ''
  const controls = `<style>
 #dsh-gateway-controls{position:fixed;right:12px;bottom:12px;z-index:2147483000;display:flex;gap:6px;align-items:center}
 #dsh-gateway-controls a,#dsh-gateway-controls button{font:12px system-ui;padding:6px 11px;border-radius:999px;border:1px solid #3a3a44;background:rgba(20,20,24,.86);color:#cfcfd6;text-decoration:none;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35)}
 #dsh-gateway-controls a:hover,#dsh-gateway-controls button:hover{color:#fff;border-color:#5a5a68}
 </style>
 <div id="dsh-gateway-controls">
  <a href="/__gateway/settings">配置模型</a>${adminLink}
  <button id="dsh-gw-restart" type="button">重启 dsh</button>
  <form method="POST" action="/__gateway/logout"><button type="submit">退出登录</button></form>
 </div>
 <script>
 (function () {
  var b = document.getElementById('dsh-gw-restart')
  if (!b) return
  b.addEventListener('click', function () {
   if (!confirm('重启你自己的 dsh 进程？几秒钟后自动恢复，未保存的对话草稿可能丢失。')) return
   b.disabled = true
   fetch('/__gateway/restart', { method: 'POST' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); location.reload() })
    .catch(function (e) { b.disabled = false; alert('重启失败：' + e.message) })
  })
 })()
 </script>`
  const index = html.lastIndexOf('</body>')
  return index === -1 ? html + controls : html.slice(0, index) + controls + html.slice(index)
}
