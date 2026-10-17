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
 .sh{background:#3b2f12;color:#ffd479}
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
export const adminPage = () => {
  // Two dictionaries, one toggle. Chinese is the default because the operator
  // audience is Chinese-first; the choice persists in localStorage. Messages
  // that interpolate a value carry {u}/{id}/{home} placeholders the client
  // fills in, so the dictionaries stay pure JSON.
  const I18N = {
    zh: {
      title: 'dsh 网关 — 管理控制台', openDsh: '打开 dsh', signOut: '退出登录',
      users: '用户', addUser: '添加用户', uname: '用户名', pwd: '密码（至少 8 位）',
      adminFlag: '管理员', sharedHomeFlag: '共享 dsh home',
      sharedTitle: '让该用户的 dsh 跑在共享 dsh home 上，可看到其中保存的会话',
      create: '创建', instances: '运行中的 dsh 进程', plugins: '插件',
      running: '运行中', stopped: '已停止', enabled: '已启用', disabled: '已停用',
      adminPill: '管理员', ownHome: '独立 home', sharedPill: '共享 dsh home',
      resetPwd: '重置密码', grantShared: '授权共享 home', revokeShared: '撤销共享 home',
      disable: '停用', enable: '启用', stopDsh: '停止 dsh', del: '删除',
      noUsers: '还没有用户。', shared: '共享', own: '独立', up: '运行', idle: '空闲',
      reqUnit: '次请求', crashUnit: '次崩溃', noInst: '没有正在运行的 dsh 进程。',
      noPlugins: '尚未注册插件。', pluginState: '状态', grantsCol: '已授权用户',
      grantHolder: '用户名', grantBtn: '授权', revokeBtn: '收回',
      pluginOn: '已启用', pluginOff: '已停用',
      enablePlugin: '启用', disablePlugin: '停用', delPlugin: '删除',
      sharedNoteOn: '标记为"共享 dsh home"的账号将运行在 {home}，并能看到其中保存的会话',
      sharedNoteOff: '本网关没有配置共享 dsh home（用 --shared-home 启动，或设置 DSH_HOME）',
      msgCreated: '用户已创建。',
      confirmGrant: '把共享 dsh home 授权给 {u}？其 dsh 将看到运营者的会话。',
      confirmRevoke: '收回 {u} 的共享 dsh home 访问？',
      promptPwd: '{u} 的新密码（至少 8 位）',
      confirmDelete: '删除用户 {u}？（其 dsh home 会保留在磁盘上）',
      confirmDelPlugin: '删除插件 {id}？将同时收回所有用户的授权。',
      brandTitle: '系统外观', brandName: '系统名称', brandLogo: 'Logo 图片',
      brandLogoHint: 'PNG/SVG，≤300KB，将替换左上角 dsh 徽标', brandPick: '选择图片',
      brandSave: '保存外观', brandClear: '恢复默认', brandSaved: '已保存，用户端刷新后生效。',
      brandBadLogo: '图片无效或超过 300KB。', brandClearConfirm: '恢复 dsh 默认品牌？',
    },
    en: {
      title: 'dsh gateway — admin', openDsh: 'Open dsh', signOut: 'Sign out',
      users: 'Users', addUser: 'Add a user', uname: 'user name', pwd: 'password (min 8)',
      adminFlag: 'admin', sharedHomeFlag: 'shared dsh home',
      sharedTitle: "Run this user's dsh on the shared dsh home so it lists the sessions stored there",
      create: 'Create', instances: 'Running dsh processes', plugins: 'Plugins',
      running: 'running', stopped: 'stopped', enabled: 'enabled', disabled: 'disabled',
      adminPill: 'admin', ownHome: 'own home', sharedPill: 'shared dsh home',
      resetPwd: 'Reset password', grantShared: 'Grant shared home', revokeShared: 'Revoke shared home',
      disable: 'Disable', enable: 'Enable', stopDsh: 'Stop dsh', del: 'Delete',
      noUsers: 'No users yet.', shared: 'shared', own: 'own', up: 'up', idle: 'idle',
      reqUnit: 'req', crashUnit: 'crash', noInst: 'No dsh process is running.',
      noPlugins: 'No plugins registered.', pluginState: 'state', grantsCol: 'grants',
      grantHolder: 'user name', grantBtn: 'grant', revokeBtn: 'revoke',
      pluginOn: 'enabled', pluginOff: 'disabled',
      enablePlugin: 'Enable', disablePlugin: 'Disable', delPlugin: 'Delete',
      sharedNoteOn: 'accounts marked "shared dsh home" run dsh on {home} and list the sessions stored there',
      sharedNoteOff: 'this gateway has no shared dsh home (start it with --shared-home, or with DSH_HOME set)',
      msgCreated: 'User created.',
      confirmGrant: "Grant {u} the shared dsh home? Their dsh will list the operator's sessions.",
      confirmRevoke: 'Revoke shared dsh home access for {u}?',
      promptPwd: 'New password for {u} (min 8 characters)',
      confirmDelete: 'Delete {u}? Their dsh home is left on disk.',
      confirmDelPlugin: "Delete plugin {id}? Every user's grant is cleared too.",
      brandTitle: 'Branding', brandName: 'System name', brandLogo: 'Logo image',
      brandLogoHint: 'PNG/SVG, up to 300KB, replaces the top-left dsh logo', brandPick: 'Choose image',
      brandSave: 'Save branding', brandClear: 'Reset to default', brandSaved: 'Saved; users see it after refresh.',
      brandBadLogo: 'Invalid image or larger than 300KB.', brandClearConfirm: 'Restore the default dsh branding?',
    },
  }
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gateway admin</title>
<style>${ADMIN_STYLE}</style>
<header>
 <h1 id="tTitle"></h1>
 <div class="row">
  <span class="mono" id="who"></span>
  <button id="lang"></button>
  <a href="/"><button id="tOpen"></button></a>
  <button class="dan" id="logout"></button>
 </div>
</header>
<main>
 <section>
  <h2 id="tUsers"></h2>
  <table id="users"><tbody></tbody></table>
  <div class="msg" id="msg"></div>
 </section>
 <section>
  <h2 id="tAdd"></h2>
  <form class="add" id="addForm">
   <input type="text" name="name" required>
   <input type="password" name="password" required>
   <label class="row"><input type="checkbox" name="admin"><span id="tAdminFlag"></span></label>
   <label class="row" id="sharedNew"><input type="checkbox" name="sharedHome"><span id="tSharedFlag"></span></label>
   <button class="pri" type="submit" id="tCreate"></button>
  </form>
  <div class="mono" id="sharedNote" style="margin-top:8px"></div>
 </section>
 <section>
  <h2 id="tPlugins"></h2>
  <table id="plugins"><tbody></tbody></table>
 </section>
 <section>
  <h2 id="tBrand"></h2>
  <form id="brandForm">
   <label class="row"><span id="tBrandName"></span> <input type="text" name="name" maxlength="40" style="max-width:240px"></label>
   <div class="row"><span id="tBrandLogo"></span> <input type="file" id="brandFile" accept="image/png,image/jpeg,image/svg+xml,image/webp" style="max-width:240px">
     <img id="brandPreview" alt="" style="height:26px;display:none;vertical-align:middle">
     <button type="button" id="brandClearBtn" class="dan"></button></div>
   <div class="mono" id="brandHint" style="margin:6px 0"></div>
   <button class="pri" type="submit" id="tBrandSave"></button>
  </form>
 </section>
 <section>
  <h2 id="tInstances"></h2>
  <table id="instances"><tbody></tbody></table>
 </section>
</main>
<script>
const DICTS = ${JSON.stringify(I18N)}
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
const fmt = (str, vars) => String(str ?? '').replace(/\\{([a-z]+)\\}/g, (m, k) => vars[k] ?? m)

// Language choice: ?lang= wins, then localStorage, then Chinese.
let lang = localStorage.getItem('gateway.lang')
if (!lang) lang = (navigator.language || '').startsWith('zh') ? 'zh' : 'zh'
const L = () => DICTS[lang] ?? DICTS.zh

const mb = v => v === undefined || v === null ? '—' : v + 'MB'
const secs = v => v === undefined || v === null ? '—' : v + 's'
const dur = s => {
  const v = Math.max(0, Math.round(Number(s) || 0))
  if (v >= 3600) return Math.floor(v / 3600) + 'h ' + Math.floor((v % 3600) / 60) + 'm'
  if (v >= 60) return Math.floor(v / 60) + 'm ' + (v % 60) + 's'
  return v + 's'
}

let lastState = null

function applyStatic () {
  const t = L()
  document.title = t.title
  document.getElementById('tTitle').textContent = t.title
  document.getElementById('tOpen').textContent = t.openDsh
  document.getElementById('logout').textContent = t.signOut
  document.getElementById('lang').textContent = lang === 'zh' ? 'English' : '中文'
  document.getElementById('tUsers').textContent = t.users
  document.getElementById('tAdd').textContent = t.addUser
  document.getElementById('tAdminFlag').textContent = t.adminFlag
  document.getElementById('tSharedFlag').textContent = t.sharedHomeFlag
  document.getElementById('tCreate').textContent = t.create
  document.getElementById('tPlugins').textContent = t.plugins
  document.getElementById('tInstances').textContent = t.instances
  document.getElementById('tBrand').textContent = t.brandTitle
  document.getElementById('tBrandName').textContent = t.brandName
  document.getElementById('tBrandLogo').textContent = t.brandLogo
  document.getElementById('tBrandSave').textContent = t.brandSave
  document.getElementById('brandClearBtn').textContent = t.brandClear
  document.getElementById('brandHint').textContent = t.brandLogoHint
  const shared = document.getElementById('sharedNew')
  shared.title = t.sharedTitle
  document.getElementById('addForm').name.placeholder = t.uname
  document.getElementById('addForm').password.placeholder = t.pwd
}

async function render () {
  const state = await api('/__gateway/admin/api/state')
  lastState = state
  const t = L()
  document.getElementById('who').textContent = state.viewer
  if (!brandDirty) brandFromState(state)

  const sharedOk = state.sharedHome !== null
  document.getElementById('sharedNew').style.display = sharedOk ? '' : 'none'
  document.getElementById('sharedNote').textContent = sharedOk
    ? fmt(t.sharedNoteOn, { home: state.sharedHome })
    : t.sharedNoteOff

  const instances = new Map(state.instances.map(i => [i.user, i]))
  document.querySelector('#users tbody').innerHTML = state.users.map(u => {
    const inst = instances.get(u.name)
    const live = inst
      ? '<span class="pill on">' + esc(t.running) + '</span> <span class="mono">:' + inst.port + ' · ' + dur(inst.uptimeSec) + ' · ' + mb(inst.rssMb) + '</span>'
      : '<span class="mono">' + esc(t.stopped) + '</span>'
    return '<tr>' +
      '<td><strong>' + esc(u.name) + '</strong> ' + (u.admin ? '<span class="pill adm">' + esc(t.adminPill) + '</span>' : '') + '</td>' +
      '<td>' + (u.enabled ? '<span class="pill on">' + esc(t.enabled) + '</span>' : '<span class="pill off">' + esc(t.disabled) + '</span>') + '</td>' +
      '<td>' + (u.sharedHome ? '<span class="pill sh">' + esc(t.sharedPill) + '</span>' : '<span class="mono">' + esc(t.ownHome) + '</span>') + '</td>' +
      '<td>' + live + '</td>' +
      '<td class="mono">' + esc(u.profile) + '</td>' +
      '<td style="text-align:right">' +
        '<button data-act="password" data-user="' + esc(u.name) + '">' + esc(t.resetPwd) + '</button>' +
        (sharedOk ? '<button data-act="shared" data-user="' + esc(u.name) + '" data-on="' + (u.sharedHome === true) + '">' + esc(u.sharedHome === true ? t.revokeShared : t.grantShared) + '</button>' : '') +
        '<button data-act="toggle" data-user="' + esc(u.name) + '" data-on="' + u.enabled + '">' + esc(u.enabled ? t.disable : t.enable) + '</button>' +
        (inst ? '<button data-act="stop" data-user="' + esc(u.name) + '">' + esc(t.stopDsh) + '</button>' : '') +
        '<button class="dan" data-act="delete" data-user="' + esc(u.name) + '">' + esc(t.del) + '</button>' +
      '</td></tr>'
  }).join('') || '<tr><td class="empty" colspan="6">' + esc(t.noUsers) + '</td></tr>'

  document.querySelector('#plugins tbody').innerHTML = (state.plugins ?? []).map(p =>
    '<tr>' +
      '<td><strong>' + esc(p.id) + '</strong></td>' +
      '<td>' + esc(p.name) + '</td>' +
      '<td>' + (p.enabled ? '<span class="pill on">' + esc(t.pluginOn) + '</span>' : '<span class="pill off">' + esc(t.pluginOff) + '</span>') + '</td>' +
      '<td class="mono">' + esc((state.users ?? []).filter(u => (u.plugins ?? []).includes(p.id)).map(u => u.name).join(', ') || '—') + '</td>' +
      '<td style="text-align:right">' +
        '<button data-pact="toggle-plugin" data-plugin="' + esc(p.id) + '" data-on="' + p.enabled + '">' + esc(p.enabled ? t.disablePlugin : t.enablePlugin) + '</button>' +
        '<button class="dan" data-pact="delete-plugin" data-plugin="' + esc(p.id) + '">' + esc(t.delPlugin) + '</button>' +
      '</td></tr>'
  ).join('') || '<tr><td class="empty" colspan="5">' + esc(t.noPlugins) + '</td></tr>'

  document.querySelector('#instances tbody').innerHTML = state.instances.map(i =>
    '<tr>' +
      '<td><strong>' + esc(i.user) + '</strong></td>' +
      '<td>' + (i.shared ? '<span class="pill sh">' + esc(t.shared) + '</span>' : '<span class="mono">' + esc(t.own) + '</span>') + '</td>' +
      '<td class="mono nowrap">pid ' + i.pid + '</td>' +
      '<td class="mono nowrap">127.0.0.1:' + i.port + '</td>' +
      '<td class="mono nowrap">' + esc(t.up) + ' ' + dur(i.uptimeSec) + ' · ' + esc(t.idle) + ' ' + dur(i.idleSec) + '</td>' +
      '<td class="mono nowrap">' + mb(i.rssMb) + ' · ' + secs(i.cpuSec) + ' cpu</td>' +
      '<td class="mono nowrap">' + i.requests + ' ' + esc(t.reqUnit) + ' · ' + i.crashes + ' ' + esc(t.crashUnit) + '</td>' +
      '<td class="mono">' + esc(i.home) + '</td>' +
    '</tr>'
  ).join('') || '<tr><td class="empty" colspan="8">' + esc(t.noInst) + '</td></tr>'
}

document.getElementById('lang').addEventListener('click', () => {
  lang = lang === 'zh' ? 'en' : 'zh'
  localStorage.setItem('gateway.lang', lang)
  applyStatic()
  if (lastState !== null) render().catch(() => {})
})

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
        sharedHome: form.sharedHome.checked,
      }),
    })
    form.reset()
    say(L().msgCreated, true)
    await render()
  } catch (error) { say(error.message, false) }
})

document.querySelector('main').addEventListener('click', async (event) => {
  const el = event.target.closest('button[data-act], button[data-pact]')
  if (el === null) return
  const t = L()
  try {
    if (el.dataset.act !== undefined) {
      const user = el.dataset.user
      if (el.dataset.act === 'toggle') {
        await api('/__gateway/admin/api/users/' + encodeURIComponent(user) + '/enabled', {
          method: 'POST', body: JSON.stringify({ enabled: el.dataset.on !== 'true' }),
        })
      } else if (el.dataset.act === 'shared') {
        const grant = el.dataset.on !== 'true'
        if (!confirm(fmt(grant ? t.confirmGrant : t.confirmRevoke, { u: user }))) return
        await api('/__gateway/admin/api/users/' + encodeURIComponent(user) + '/shared-home', {
          method: 'POST', body: JSON.stringify({ sharedHome: grant }),
        })
      } else if (el.dataset.act === 'password') {
        const password = prompt(fmt(t.promptPwd, { u: user }))
        if (password === null) return
        await api('/__gateway/admin/api/users/' + encodeURIComponent(user) + '/password', {
          method: 'POST', body: JSON.stringify({ password }),
        })
      } else if (el.dataset.act === 'delete') {
        if (!confirm(fmt(t.confirmDelete, { u: user }))) return
        await api('/__gateway/admin/api/users/' + encodeURIComponent(user), { method: 'DELETE' })
      } else if (el.dataset.act === 'stop') {
        await api('/__gateway/admin/api/instances/' + encodeURIComponent(user) + '/stop', { method: 'POST' })
      }
    } else {
      const id = el.dataset.plugin
      if (el.dataset.pact === 'toggle-plugin') {
        await api('/__gateway/admin/api/plugins/' + encodeURIComponent(id), {
          method: 'POST', body: JSON.stringify({ enabled: el.dataset.on !== 'true' }),
        })
      } else if (el.dataset.pact === 'delete-plugin') {
        if (!confirm(fmt(t.confirmDelPlugin, { id }))) return
        await api('/__gateway/admin/api/plugins/' + encodeURIComponent(id), { method: 'DELETE' })
      }
    }
    await render()
  } catch (error) { say(error.message, false) }
})

// ---- branding -------------------------------------------------------------
let brandLogoData = null
let brandDirty = false
document.getElementById('brandForm').name.addEventListener('input', () => { brandDirty = true })
document.getElementById('brandFile').addEventListener('change', () => { brandDirty = true })
function brandFromState(st) {
  const b = st.branding || {}
  document.getElementById('brandForm').name.value = b.name || ''
  brandLogoData = b.logo && b.logo.startsWith('data:') ? b.logo : null
  const prev = document.getElementById('brandPreview')
  if (b.logo) { prev.src = b.logo; prev.style.display = 'inline-block' } else { prev.style.display = 'none' }
}
document.getElementById('brandFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  if (file.size > 300 * 1024) { say(L().brandBadLogo, false); e.target.value = ''; return }
  const reader = new FileReader()
  reader.onload = () => {
    brandLogoData = String(reader.result)
    const prev = document.getElementById('brandPreview')
    prev.src = brandLogoData; prev.style.display = 'inline-block'
  }
  reader.readAsDataURL(file)
})
document.getElementById('brandForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = document.getElementById('brandForm').name.value
  try {
    const body = { name }
    if (brandLogoData) body.logo = brandLogoData
    await api('/__gateway/admin/api/branding', { method: 'POST', body: JSON.stringify(body) })
    brandDirty = false
    say(L().brandSaved, true)
  } catch (error) { say(error.message, false) }
})
document.getElementById('brandClearBtn').addEventListener('click', async () => {
  if (!confirm(L().brandClearConfirm)) return
  try {
    await api('/__gateway/admin/api/branding', { method: 'POST', body: JSON.stringify({ name: '', logo: '' }) })
    document.getElementById('brandFile').value = ''
    brandLogoData = null
    document.getElementById('brandPreview').style.display = 'none'
    document.getElementById('brandForm').name.value = ''
    brandDirty = false
    say(L().brandSaved, true)
  } catch (error) { say(error.message, false) }
})

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/__gateway/logout', { method: 'POST' })
  location.href = '/'
})

applyStatic()
render().catch(error => say(error.message, false))
setInterval(() => render().catch(() => {}), 10000)
</script>`
}

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
 * page over a LAN, so the gateway injects an account menu into the document it
 * relays: a bottom-left avatar that opens the same few actions dsh desktop keeps
 * behind its own avatar. The sign-out is a POST form, which needs no JavaScript;
 * the restart action is a small script, and dsh sends no CSP, so nothing here
 * has to be allowed for.
 *
 * Only a document response is passed here; the caller checks the content type.
 *
 * The user console is only offered to administrators, because that is the only
 * audience the route serves: a non-administrator following the link would be
 * bounced straight back to the sign-in page.
 *
 * @param html - dsh's document body.
 * @param options - set `admin` to add the user-management item; `user` names the
 *   signed-in account, shown on the avatar (its initial) and in the menu.
 * @returns the same document with the account menu before `</body>`.
 */
export const injectGatewayControls = (html, { admin = false, user = '', branding = { name: '', logo: '' } } = {}) => {
  const escape = (text) => text.replace(/[&<>"']/gu, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const name = escape(user)
  const initial = escape((user.trim()[0] ?? '?').toUpperCase())
  const adminItem = admin ? '\n   <a href="/__gateway/admin">用户管理</a>' : ''
  const controls = `<style>
 #dsh-gateway-root{position:fixed;left:12px;bottom:12px;z-index:2147483000}
 #dsh-gw-avatar{width:34px;height:34px;border-radius:50%;border:1px solid #3a3a44;background:linear-gradient(135deg,#4a5ae8,#8a4ae8);color:#fff;font:600 15px/32px system-ui;text-align:center;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);padding:0}
 #dsh-gw-avatar:hover{filter:brightness(1.15)}
 #dsh-gw-menu{display:none;position:absolute;left:0;bottom:42px;min-width:150px;border-radius:10px;border:1px solid #3a3a44;background:rgba(20,20,24,.94);box-shadow:0 4px 18px rgba(0,0,0,.4);overflow:hidden}
 #dsh-gw-menu.open{display:block}
 #dsh-gw-menu .dsh-gw-who{font:12px system-ui;color:#8f8f9a;padding:9px 13px 7px;border-bottom:1px solid #2c2c34;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}
 #dsh-gw-menu a,#dsh-gw-menu button{display:block;width:100%;box-sizing:border-box;font:13px system-ui;padding:9px 13px;border:0;background:none;color:#cfcfd6;text-decoration:none;cursor:pointer;text-align:left}
 #dsh-gw-menu a:hover,#dsh-gw-menu button:hover{background:#2a2a33;color:#fff}
 </style>
 <div id="dsh-gateway-root">
  <button id="dsh-gw-avatar" type="button" title="${name}">${initial}</button>
  <div id="dsh-gw-menu" role="menu">
   <div class="dsh-gw-who">${name}</div>
   <a href="/__gateway/settings">配置模型</a>${adminItem}
   <button id="dsh-gw-restart" type="button">重启 dsh</button>
   <form method="POST" action="/__gateway/logout"><button type="submit">退出登录</button></form>
  </div>
 </div>
 <script>
 (function () {
  var avatar = document.getElementById('dsh-gw-avatar')
  var menu = document.getElementById('dsh-gw-menu')
  if (avatar && menu) {
   avatar.addEventListener('click', function (e) {
    e.stopPropagation()
    menu.classList.toggle('open')
   })
   document.addEventListener('click', function (e) {
    if (!menu.contains(e.target)) menu.classList.remove('open')
   })
  }
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
  const brandScript = brandingScript(branding)
  return index === -1 ? html + controls + brandScript : html.slice(0, index) + controls + brandScript + html.slice(index)
}

/**
 * Build the branding override injected into every relayed dsh shell. The dsh
 * sidebar exposes stable hooks: `[data-slot="sidebar.brand.mark"]` (the logo
 * SVG) and `[data-slot="sidebar.brand.name"]` (the product name). React can
 * re-render the sidebar at any time, so a MutationObserver re-applies the
 * override whenever the hooks come back untouched.
 * @param branding - `{name, logo}`; empty fields leave dsh's own branding up.
 * @returns a `<script>` element, or '' when nothing is configured.
 */
const brandingScript = (branding) => {
  const name = typeof branding?.name === 'string' ? branding.name : ''
  const logo = typeof branding?.logo === 'string' ? branding.logo : ''
  if (name === '' && logo === '') return ''
  const payload = JSON.stringify({ name, logo }).replace(/</g, '\\u003c')
  return `
 <script data-gateway-branding>
 (function () {
  var cfg = ${payload}
  var MARK = '[data-slot="sidebar.brand.mark"]'
  var NAME = '[data-slot="sidebar.brand.name"]'
  function apply(root) {
   if (cfg.logo) {
    var marks = (root || document).querySelectorAll(MARK)
    for (var i = 0; i < marks.length; i++) {
     var mark = marks[i]
     if (mark.firstElementChild && mark.firstElementChild.tagName === 'IMG') continue
     mark.textContent = ''
     var img = document.createElement('img')
     img.src = cfg.logo
     img.alt = cfg.name || 'logo'
     img.style.cssText = 'height:26px;max-width:180px;object-fit:contain;display:block'
     mark.appendChild(img)
    }
   }
   if (cfg.name) {
    var names = (root || document).querySelectorAll(NAME)
    for (var j = 0; j < names.length; j++) {
     if (names[j].textContent !== cfg.name) names[j].textContent = cfg.name
    }
    if (document.title !== cfg.name) document.title = cfg.name
   }
  }
  apply()
  new MutationObserver(function (muts) {
   for (var k = 0; k < muts.length; k++) {
    var m = muts[k]
    if (m.type === 'childList') {
     for (var n = 0; n < m.addedNodes.length; n++) {
      var node = m.addedNodes[n]
      if (node.nodeType === 1) apply(node.matches && (node.matches(MARK) || node.matches(NAME)) ? node.parentElement : node)
     }
    } else if (m.target && m.target.closest && (m.target.closest(MARK) || m.target.closest(NAME))) {
     apply()
    }
   }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true })
 })()
 </script>`
}
