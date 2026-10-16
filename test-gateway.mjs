/**
 * Deterministic harness for the gateway's session-durability claims.
 *
 * A real dsh cannot be told "your cookie is now stale", so the failure the
 * user hit �?a credential that silently expires and strands the phone on a
 * broken page �?is reproduced with a fake upstream that does exactly that:
 * it keys its cookie by Host (like dsh), and it can retire a generation on
 * command, turning every previously issued cookie into a 401.
 *
 * Run: node test-gateway.mjs
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

const GATEWAY = new URL('./gateway.mjs', import.meta.url).pathname.replace(/^\//, '')
const STATE = new URL('./test-state.json', import.meta.url).pathname.replace(/^\//, '')

const UPSTREAM_PORT = 3099
const CONTROL_PORT = 3098
const GATEWAY_PORT = 8081
const GATEWAY2_PORT = 8082
const LAUNCH = 'launch-token-for-test'
const HOST = `127.0.0.1:${String(GATEWAY_PORT)}`
const HOST2 = `127.0.0.1:${String(GATEWAY2_PORT)}`

/** Reset per-run state. */
let generation = 1
const authName = host => `dsh-auth-${createHash('sha256').update(host).digest('hex').slice(0, 8)}`

// --- Fake dsh -----------------------------------------------------------------
/** The RPC methods the configuration form is allowed to reach. */
const RPC_METHODS = new Set([
  'llm/listProviders',
  'llm/listConfigurableProviders',
  'llm/discoverModels',
  'settings/describe',
  'settings/mutate',
  'credentials/describe',
  'credentials/set',
])

/** Every RPC the configuration form exercised, in order. */
const rpcCalls = []
/** The credential and settings writes the fake dsh accepted. */
const saved = { credentials: {}, settings: [] }
/**
 * The sections the fake dsh holds, shaped the way the real one describes them.
 * `deepseek-official` is the interesting one: its whole section IS the route
 * profile (`settingsPath: []`), which is the layout an earlier build wrote to
 * the wrong namespace. `deepseek` is a pi-ai route, whose profile is a subtree.
 */
const sections = {
  'llm-deepseek': { revision: 3, value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-flash' }] } },
  'llm-pi-ai': { revision: 5, value: { providers: {} } },
  'agent-default-model': { revision: 4, value: { provider: 'deepseek-official', model: 'deepseek-flash' } },
}
/** Credentials the fake dsh has stored, keyed by reference. */
const credentials = {}

/** Write one value at a path, creating intermediate objects. */
function setAt(root, path, value) {
  let node = root
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key]
  }
  if (path.length > 0) node[path[path.length - 1]] = value
}

/** Answer one of dsh's settings/credentials RPCs, in dsh's envelope. */
function rpc(method, args) {
  if (method === 'llm/listProviders') return [{ id: 'deepseek-official', name: 'DeepSeek' }]
  if (method === 'llm/listConfigurableProviders') {
    return [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'deepseek', displayName: 'deepseek', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'deepseek'] },
    ]
  }
  if (method === 'settings/describe') {
    return {
      writable: true,
      namespaces: Object.entries(sections).map(([ns, entry]) => ({
        ns,
        revision: entry.revision,
        value: structuredClone(entry.value),
      })),
    }
  }
  // Only the pi-ai adapter registers a model discovery; every other route
  // refuses it, which is what sends the gateway to the section's catalogue.
  if (method === 'llm/discoverModels') {
    if (args.settingsNs !== 'llm-pi-ai') {
      throw new Error(`no model discovery is registered for "${String(args.settingsNs)}"`)
    }
    return [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000 },
    ]
  }
  if (method === 'settings/mutate') {
    const section = sections[args.ns] ?? (sections[args.ns] = { revision: 0, value: {} })
    for (const op of args.ops ?? []) {
      if (op.op === 'set') setAt(section.value, op.path, op.value)
    }
    section.revision += 1
    saved.settings.push({ ns: args.ns, ops: args.ops })
    return { ns: args.ns, revision: section.revision, value: structuredClone(section.value) }
  }
  if (method === 'credentials/describe') {
    return Object.fromEntries((args.refs ?? [])
      .map(ref => [ref, { configured: credentials[ref] !== undefined, writable: true }]))
  }
  if (method === 'credentials/set') {
    credentials[args.ref] = args.value
    saved.credentials[args.ref] = args.value
    return null
  }
  return null
}

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://placeholder')
  const host = req.headers.host ?? ''
  if (url.pathname === '/' && url.searchParams.get('token') === LAUNCH) {
    const pair = `${authName(host)}=gen${String(generation)}`
    res.writeHead(303, { 'set-cookie': `${pair}; Path=/; HttpOnly`, location: '/' })
    res.end()
    return
  }
  const presented = String(req.headers.cookie ?? '').split('; ')
  // Served publicly, exactly like dsh's own manifest route.
  if (url.pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json' })
    res.end('{"name":"fake-dsh"}')
    return
  }
  const expected = `${authName(host)}=gen${String(generation)}`
  if (presented.includes(expected)) {
    // A tiny stand-in for dsh's HTML shell, so the gateway's injection can be
    // asserted without booting the real app.
    if (url.pathname === '/shell') {
      const body = '<!doctype html><html><body>dsh shell</body></html>'
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length) })
      res.end(body)
      return
    }
    // A response that dies mid-body: the stand-in for a dsh this gateway just
    // restarted underneath an in-flight response.
    if (url.pathname === '/reset') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
      res.socket.destroy()
      return
    }
    // dsh's settings/credentials RPC surface, enough for the configuration form.
    const method = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : ''
    if (RPC_METHODS.has(method)) {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        rpcCalls.push(method)
        let envelope = {}
        try {
          envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          envelope = {}
        }
        const value = (() => {
          try {
            return { ok: true, value: rpc(method, envelope.payload?.args ?? {}) }
          } catch (error) {
            return { ok: false, error: { message: error.message } }
          }
        })()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ result: value }))
      })
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`OK:gen${String(generation)}`)
    return
  }
  res.writeHead(401, { 'content-type': 'text/plain' })
  res.end(`STALE: expected ${expected}`)
})

/** Retire the current generation, invalidating every issued cookie at once. */
const control = createServer((req, res) => {
  if (req.url === '/stale') {
    generation += 1
    res.end(`gen${String(generation)}`)
    return
  }
  res.end('ok')
})

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})

// --- Test helpers -------------------------------------------------------------
let failures = 0
let checks = 0

/** Assert, recording rather than throwing so every claim is reported. */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` �?${detail}` : ''}`)
  }
}

/** Issue one request through the gateway. @returns status, headers, body. */
function call({ port, method = 'GET', path = '/', headers = {}, body, jar }) {
  const cookies = jar === undefined || Object.keys(jar).length === 0
    ? {}
    : { cookie: Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ') }
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: { host: `127.0.0.1:${String(port)}`, ...cookies, ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Fold a response's Set-Cookie headers into the jar, like a browser. */
function absorb(jar, res) {
  for (const single of res.headers['set-cookie'] ?? []) {
    const pair = single.split(';')[0]
    const eq = pair.indexOf('=')
    jar[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return jar
}

/** Serialise a cookie jar into a Cookie header. */
const jarHeader = jar => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')

/** Start the gateway and resolve once it reports it is listening. */
function startGateway(extraArgs, label) {
  const args = [GATEWAY, '--listen', String(GATEWAY_PORT), '--bind', '127.0.0.1',
    '--target', `http://127.0.0.1:${String(UPSTREAM_PORT)}`, '--state', STATE, ...extraArgs]
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.log = ''
  child.stdout.on('data', (d) => { child.log += d.toString() })
  child.stderr.on('data', (d) => { child.log += d.toString() })
  // Resolve only once the startup banner is complete, so assertions may read
  // the whole log rather than racing the stdout flush.
  child.ready = new Promise((resolve) => {
    const onData = () => { if (child.log.includes('gateway listening')) resolve() }
    child.stdout.on('data', onData)
  })
  console.log(`\n[${label}] started pid ${String(child.pid)}`)
  return child
}

/** Stop a gateway and wait for the port to be released. */
async function stop(child) {
  if (child.exitCode !== null) return
  const done = new Promise(resolve => child.once('exit', resolve))
  child.kill()
  await done
}

// --- The test -----------------------------------------------------------------
async function main() {
  rmSync(STATE, { force: true })
  await listen(upstream, UPSTREAM_PORT)
  await listen(control, CONTROL_PORT)
  console.log('fake dsh on 3099, control on 3098')

  console.log('\n== 1. sign-in mints a durable session ==')
  let gateway = startGateway(['--token', LAUNCH], 'gateway-1')
  await gateway.ready
  const jar = {}
  const login = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=admin&password=admin12345',
  })
  absorb(jar, login)
  check('login redirects', login.status === 303, `got ${String(login.status)}`)
  const sessionSetCookie = (login.headers['set-cookie'] ?? []).find(c => c.startsWith('dsh-gateway-session'))
  check('session cookie is durable (Max-Age present)',
    typeof sessionSetCookie === 'string' && sessionSetCookie.includes('Max-Age='),
    sessionSetCookie)
  check('session cookie is HttpOnly', typeof sessionSetCookie === 'string' && sessionSetCookie.includes('HttpOnly'))
  check('dsh credential relayed as an opaque handle', typeof jar.__dsh_relay === 'string')
  check('browser never receives a dsh-auth cookie',
    (login.headers['set-cookie'] ?? []).every(c => !c.startsWith('dsh-auth-')))

  const authed = await call({ port: GATEWAY_PORT, path: '/api/thing', headers: { cookie: jarHeader(jar) } })
  check('authenticated relay succeeds', authed.status === 200 && authed.body === 'OK:gen1',
    `${String(authed.status)} ${authed.body}`)

  console.log('\n== 2. sign-in survives a gateway restart ==')
  await stop(gateway)
  gateway = startGateway(['--token', LAUNCH], 'gateway-1-restarted')
  await gateway.ready
  check('state file written on login', gateway.log.includes('sessions restored: 1'),
    gateway.log.trim().split('\n')[0])
  const afterRestart = await call({ port: GATEWAY_PORT, path: '/api/thing', headers: { cookie: jarHeader(jar) } })
  check('same browser cookie still works after restart, no re-login',
    afterRestart.status === 200, `${String(afterRestart.status)} ${afterRestart.body}`)

  console.log('\n== 3. a stale dsh credential is re-minted, not relayed as 401 ==')
  const bumped = await call({ port: CONTROL_PORT, path: '/stale' })
  console.log(`  (control: ${bumped.body})`)
  const staleGet = await call({ port: GATEWAY_PORT, path: '/api/thing', headers: { cookie: jarHeader(jar) } })
  check('stale credential recovers instead of 401',
    staleGet.status === 200 && staleGet.body === 'OK:gen2', `${String(staleGet.status)} ${staleGet.body}`)
  check('recovery is logged as a re-mint',
    gateway.log.includes('re-minted and retried'), gateway.log.trim().split('\n').slice(-2).join(' | '))

  console.log('\n== 4. the recovery also covers a POST body (replayed, not lost) ==')
  const bumped2 = await call({ port: CONTROL_PORT, path: '/stale' })
  console.log(`  (control: ${bumped2.body})`)
  const stalePost = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/api/thing',
    headers: { cookie: jarHeader(jar), 'content-type': 'application/json' },
    body: '{"hello":"world"}',
  })
  check('stale credential on a POST also recovers', stalePost.status === 200, `${String(stalePost.status)} ${stalePost.body}`)

  console.log('\n== 5. throttling the retry: a repeated 401 must not loop ==')
  const bumped3 = await call({ port: CONTROL_PORT, path: '/stale' })
  console.log(`  (control: ${bumped3.body})`)
  const first = await call({ port: GATEWAY_PORT, path: '/api/thing', headers: { cookie: jarHeader(jar) } })
  check('one re-mint is enough for the new generation', first.status === 200, `${String(first.status)} ${first.body}`)

  // 6. The gateway chrome injected into dsh's own shell. This runs before the
  //    no-token gateway below, because relaying the shell needs a real session.
  console.log('\n== 6. the dsh shell gains a way back and a way out ==')
  const shellJar = {}
  absorb(shellJar, await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=admin&password=admin12345',
  }))
  const shell = await call({
    port: GATEWAY_PORT,
    path: '/shell',
    jar: shellJar,
    headers: { accept: 'text/html,application/xhtml+xml' },
  })
  check('the shell keeps dsh\'s own markup',
    shell.status === 200 && shell.body.includes('dsh shell'),
    `status ${String(shell.status)}`)
  check('the shell gains a sign-out control that works without JavaScript',
    shell.body.includes('action="/__gateway/logout"') && shell.body.includes('method="POST"'), shell.body)
  check('the shell gains a link to the configuration page',
    shell.body.includes('href="/__gateway/settings"'), shell.body)
  check('an administrator\'s shell also links to the user console',
    shell.body.includes('href="/__gateway/admin"'), shell.body)
  await call({
    port: GATEWAY_PORT,
    method: 'DELETE',
    path: '/__gateway/admin/api/users/viewer',
    jar: shellJar,
  })
  const createdViewer = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/admin/api/users',
    jar: shellJar,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'viewer', password: 'viewer12345' }),
  })
  check('an administrator can create a plain user',
    createdViewer.status === 201, `${String(createdViewer.status)} ${createdViewer.body}`)
  const viewerJar = {}
  absorb(viewerJar, await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=viewer&password=viewer12345',
  }))
  const viewerShell = await call({
    port: GATEWAY_PORT,
    path: '/shell',
    jar: viewerJar,
    headers: { accept: 'text/html,application/xhtml+xml' },
  })
  check('a plain user\'s shell is not offered the user console',
    viewerShell.status === 200 && viewerShell.body.includes('href="/__gateway/settings"') &&
      !viewerShell.body.includes('href="/__gateway/admin"'),
    `status ${String(viewerShell.status)} ${viewerShell.body}`)
  const removedViewer = await call({
    port: GATEWAY_PORT,
    method: 'DELETE',
    path: '/__gateway/admin/api/users/viewer',
    jar: shellJar,
  })
  check('the console check leaves no test account behind',
    removedViewer.status === 200, `${String(removedViewer.status)} ${removedViewer.body}`)
  check('injection rewrites content-length rather than lying about it',
    Buffer.byteLength(shell.body, 'utf8') === Number(shell.headers['content-length']),
    `${String(Buffer.byteLength(shell.body, 'utf8'))} vs ${String(shell.headers['content-length'])}`)
  const api = await call({ port: GATEWAY_PORT, path: '/', jar: shellJar })
  check('a non-document request is relayed untouched',
    api.status === 200 && !api.body.includes('__gateway/logout') && /^OK:gen\d+$/.test(api.body),
    `status ${String(api.status)} ${api.body}`)
  const noAccept = await call({ port: GATEWAY_PORT, path: '/shell', jar: shellJar })
  check('a document fetched without a document Accept header is left alone',
    noAccept.status === 200 && !noAccept.body.includes('__gateway/logout'),
    `status ${String(noAccept.status)} ${noAccept.body}`)
  const wrongType = await call({
    port: GATEWAY_PORT, path: '/', jar: shellJar, headers: { accept: 'text/html' },
  })
  check('a text/plain response is never treated as a document',
    wrongType.status === 200 && /^OK:gen\d+$/.test(wrongType.body) && !wrongType.body.includes('__gateway/logout'),
    `status ${String(wrongType.status)} ${wrongType.body}`)

  console.log('\n== 7. without a launch token the gateway fails loudly, never silently ==')
  await stop(gateway)
  const noToken = startGateway([], 'gateway-no-token')
  await noToken.ready
  const freshJar = {}
  const login2 = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=admin&password=admin12345',
  })
  absorb(freshJar, login2)
  check('login still succeeds without a launch token', login2.status === 303, `got ${String(login2.status)}`)
  check('no dsh handle is invented', freshJar.__dsh_relay === undefined)
  const blocked = await call({ port: GATEWAY_PORT, path: '/api/thing', headers: { cookie: jarHeader(freshJar) } })
  check('request explains the missing token instead of hanging or 401-looping',
    blocked.status === 502 && blocked.body.includes('no launch token configured'),
    `${String(blocked.status)} ${blocked.body.split('\n')[0]}`)

  console.log('\n== 8. correct credentials still required ==')
  const bad = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=admin&password=wrong',
  })
  check('wrong password rejected', bad.status === 401, `got ${String(bad.status)}`)
  const anon = await call({ port: GATEWAY_PORT, path: '/api/thing' })
  check('anonymous API call rejected', anon.status === 401 && anon.body.includes('unauthenticated'), `${String(anon.status)} ${anon.body}`)

  check('gateway never crashed', noToken.exitCode === null, `exit ${String(noToken.exitCode)}`)

  console.log('\n== 9. credential-less static assets are not gated ==')
  // A browser fetches the manifest and favicon with credentials OMITTED, so a
  // session-gated relay would 401 them even for a signed-in user.
  const manifest = await call({
    port: GATEWAY_PORT,
    path: '/manifest.webmanifest',
    headers: { 'sec-fetch-dest': 'manifest', 'sec-fetch-mode': 'cors' },
  })
  check('manifest relays with no cookies at all',
    manifest.status === 200 && manifest.body.includes('fake-dsh'),
    `${String(manifest.status)} ${manifest.body}`)
  const apiAnon = await call({ port: GATEWAY_PORT, path: '/api/session/list' })
  check('the API is still gated without a session',
    apiAnon.status === 401 && apiAnon.body.includes('unauthenticated'),
    `${String(apiAnon.status)} ${apiAnon.body}`)

  console.log('\n== 10. sign-in returns you to the page you asked for ==')
  // An administrator who follows a link to the console while signed out must land
  // back on the console, not in the workspace.
  const wanted = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=admin&password=admin12345&next=%2F__gateway%2Fadmin',
  })
  check('a successful sign-in honours a same-origin next',
    wanted.status === 303 && wanted.headers.location === '/__gateway/admin',
    `${String(wanted.status)} -> ${String(wanted.headers.location)}`)

  // `next` is attacker-controlled, so anything that could leave the origin must be
  // dropped rather than sanitized into something plausible.
  for (const hostile of ['%2F%2Fevil.com', 'https%3A%2F%2Fevil.com', '%5C%5Cevil.com']) {
    const escaping = await call({
      port: GATEWAY_PORT,
      method: 'POST',
      path: '/__gateway/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=admin&password=admin12345&next=${hostile}`,
    })
    check(`an off-origin next is discarded (${decodeURIComponent(hostile)})`,
      escaping.status === 303 && escaping.headers.location === '/',
      `${String(escaping.status)} -> ${String(escaping.headers.location)}`)
  }

  const consoleAnon = await call({
    port: GATEWAY_PORT,
    path: '/__gateway/admin',
    headers: { accept: 'text/html' },
  })
  check('the console asks a signed-out visitor to sign in, remembering the console',
    consoleAnon.status === 403 && consoleAnon.body.includes('value="/__gateway/admin"'),
    `status ${String(consoleAnon.status)}`)

  // 11. The sign-in switch and the sign-out it needs to be useful.
  console.log('\n== 11. the sign-in switch leads to model configuration ==')
  const viaSwitch = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=admin&password=admin12345&mode=setting&next=%2F',
  })
  check('choosing the settings switch lands on the configuration page',
    viaSwitch.status === 303 && viaSwitch.headers.location === '/__gateway/settings',
    `${String(viaSwitch.status)} -> ${String(viaSwitch.headers.location)}`)

  const switchJar = {}
  absorb(switchJar, viaSwitch)
  const settingsPage = await call({ port: GATEWAY_PORT, path: '/__gateway/settings', jar: switchJar })
  check('the configuration page renders for its own user',
    settingsPage.status === 200 && settingsPage.body.includes('name="apiKey"'),
    `status ${String(settingsPage.status)}`)

  const settingsAnon = await call({
    port: GATEWAY_PORT,
    path: '/__gateway/settings',
    headers: { accept: 'text/html' },
  })
  check('a signed-out visitor gets the sign-in page with the switch, not a bare 401',
    settingsAnon.status === 200 && settingsAnon.body.includes('name="mode"'),
    `status ${String(settingsAnon.status)}`)

  const plain = await call({
    port: GATEWAY_PORT,
    path: '/__gateway/login',
    headers: { accept: 'text/html' },
  })
  check('the default switch position is DeepSeek Harness',
    plain.status === 200 && plain.body.includes('value="dsh"') &&
      plain.body.includes('配置模型') && plain.body.includes('DeepSeek Harness'),
    `status ${String(plain.status)}`)

  const out = await call({ port: GATEWAY_PORT, method: 'POST', path: '/__gateway/logout', jar: switchJar })
  check('sign-out lands on the login page, not on the app shell',
    out.status === 303 && out.headers.location === '/__gateway/login',
    `${String(out.status)} -> ${String(out.headers.location)}`)
  const loginAgain = await call({
    port: GATEWAY_PORT,
    path: out.headers.location,
    headers: { accept: 'text/html' },
  })
  check('that address really renders the sign-in form',
    loginAgain.status === 200 && loginAgain.body.includes('name="password"') &&
      !loginAgain.body.includes('__gateway/logout'),
    `status ${String(loginAgain.status)}`)
  const cleared = [out.headers['set-cookie']].flat().join('\n')
  check('sign-out drops the gateway session',
    cleared.includes('dsh-gateway-session') && cleared.includes('Max-Age=0'), cleared)
  check('sign-out drops the relayed dsh handle too',
    cleared.includes('__dsh_relay=') && cleared.includes('Max-Age=0'), cleared)
  const afterOut = await call({ port: GATEWAY_PORT, path: '/__gateway/settings', jar: switchJar })
  check('the retired session cannot read the configuration page',
    afterOut.status === 401 || afterOut.body.includes('name="mode"'),
    `status ${String(afterOut.status)}`)

  // 12. The configuration form writes through dsh's own RPCs. This needs a real
  //     launch token, so it runs after the no-token gateway above.
  console.log('\n== 12. the configuration form writes through dsh\'s own RPCs ==')
  await stop(noToken)
  const configGateway = startGateway(['--token', LAUNCH], 'gateway-config')
  await configGateway.ready

  const formJar = {}
  absorb(formJar, await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=admin&password=admin12345&mode=setting',
  }))
  const form = await call({ port: GATEWAY_PORT, path: '/__gateway/settings', jar: formJar })
  check('the form lists the providers dsh reports',
    form.status === 200 && form.body.includes('value="deepseek-official"') &&
      form.body.includes('value="deepseek"'),
    `status ${String(form.status)}`)
  check('the form shows the model dsh currently defaults to',
    form.body.includes('value="deepseek-flash"'), 'current model missing')
  check('the form says the key is not stored yet',
    form.body.includes('粘贴服务�?API Key'), 'initial key state missing')

  const saved1 = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/settings',
    jar: formJar,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'provider=deepseek-official&apiKey=sk-test-123&model=deepseek-flash',
  })
  check('saving is confirmed on the page',
    saved1.status === 200 && saved1.body.includes('已保存并注入'),
    `status ${String(saved1.status)}`)
  check('the key is written through dsh\'s credentials RPC',
    saved.credentials.DEEPSEEK_OFFICIAL_API_KEY === 'sk-test-123',
    JSON.stringify(saved.credentials))
  // The regression: `deepseek-official` keeps its profile at the ROOT of
  // `llm-deepseek` (`settingsPath: []`). Naming the reference under
  // `llm-pi-ai.providers.<route>` �?which an earlier build did for every route �?  // leaves the route resolving `DEEPSEEK_API_KEY`, and the user sees
  // `no API key for provider route "deepseek-official"` with the key stored.
  check('the key reference is written to the namespace dsh names for that route',
    saved.settings.some(entry => entry.ns === 'llm-deepseek' &&
      entry.ops?.some(op => op.op === 'set' && op.path.join('.') === 'apiKeyEnv' &&
        op.value === 'DEEPSEEK_OFFICIAL_API_KEY')),
    JSON.stringify(saved.settings))
  check('the reference is never filed under another route\'s namespace',
    !saved.settings.some(entry => entry.ns === 'llm-pi-ai' &&
      JSON.stringify(entry.ops).includes('DEEPSEEK_OFFICIAL_API_KEY')),
    JSON.stringify(saved.settings))
  check('the default model is written through dsh\'s settings RPC',
    saved.settings.some(entry => entry.ns === 'agent-default-model' &&
      entry.ops?.some(op => op.path.join('.') === 'model' && op.value === 'deepseek-flash') &&
      entry.ops?.some(op => op.path.join('.') === 'provider' && op.value === 'deepseek-official')),
    JSON.stringify(saved.settings))
  check('the key itself is never echoed back into the page',
    !saved1.body.includes('sk-test-123'), 'the secret came back in a response body')
  check('the form now reports the key as stored',
    saved1.body.includes('已配置（DEEPSEEK_OFFICIAL_API_KEY�?),
    'stored state not reflected after saving')

  // A pi-ai route keeps its profile in a subtree, so its reference belongs
  // inside that subtree instead of the section root.
  const saved2 = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/settings',
    jar: formJar,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'provider=deepseek&apiKey=sk-test-456&model=deepseek-flash',
  })
  check('a nested route profile gets the reference inside its own subtree',
    saved2.status === 200 && saved.settings.some(entry => entry.ns === 'llm-pi-ai' &&
      entry.ops?.some(op => op.op === 'set' &&
        op.path.join('.') === 'providers.deepseek.apiKeyEnv' && op.value === 'DEEPSEEK_API_KEY')),
    JSON.stringify(saved.settings))

  const refused = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/settings',
    jar: formJar,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'provider=&apiKey=sk-test-123',
  })
  check('an empty provider is refused with a reason, not a 500',
    refused.status === 400 && refused.body.includes('选择一个服务商'),
    `status ${String(refused.status)}`)

  // The state a build that wrote every route's profile under `llm-pi-ai` left
  // behind: the user's key IS stored, under the reference this page derives, but
  // the route still names dsh's own default. Saving nothing but the reference
  // must adopt the key the user already entered.
  console.log('\n== 13. a key stored before the reference was named starts working ==')
  sections['llm-deepseek'].value = { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-flash' }] }
  sections['llm-deepseek'].revision += 1
  sections['agent-default-model'].value = { provider: 'deepseek-official', model: 'deepseek-flash' }
  delete credentials.DEEPSEEK_API_KEY
  credentials.DEEPSEEK_OFFICIAL_API_KEY = 'sk-saved-by-the-earlier-build'
  saved.settings.length = 0
  delete saved.credentials.DEEPSEEK_OFFICIAL_API_KEY

  const orphaned = await call({ port: GATEWAY_PORT, path: '/__gateway/settings', jar: formJar })
  check('the page reports the stored key even while the route ignores it',
    orphaned.body.includes('已配置（DEEPSEEK_OFFICIAL_API_KEY�?),
    'orphaned key not reported')

  const adopted = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/settings',
    jar: formJar,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'provider=deepseek-official&apiKey=&model=deepseek-flash',
  })
  check('a blank key adopts the stored credential instead of requiring a re-entry',
    adopted.status === 200 &&
      sections['llm-deepseek'].value.apiKeyEnv === 'DEEPSEEK_OFFICIAL_API_KEY',
    `status ${String(adopted.status)} apiKeyEnv=${String(sections['llm-deepseek'].value.apiKeyEnv)}`)
  check('adopting is reported, not silently folded into the model write',
    adopted.body.includes('已保存并注入：API Key 引用、默认模型�?),
    'the notice did not name the reference change')
  check('adopting an existing key stores nothing new',
    saved.credentials.DEEPSEEK_OFFICIAL_API_KEY === undefined,
    JSON.stringify(saved.credentials))
  check('the fields around the reference survive the write',
    sections['llm-deepseek'].value.models?.[0]?.id === 'deepseek-flash',
    JSON.stringify(sections['llm-deepseek'].value))

  // --- The fetch-models button --------------------------------------------------
  // The route's own adapter answers when it has a discovery; a route that has
  // none still answers from the catalogue dsh holds for it, which is what keeps
  // the button useful for `deepseek-official` (its adapter registers no
  // discovery at all) instead of leaving the user to know the model id.
  console.log('\n== 14. the model list behind the fetch-models button ==')
  const listed = await call({ port: GATEWAY_PORT, path: '/__gateway/models?provider=deepseek', jar: formJar })
  const listedBody = JSON.parse(listed.body)
  check('the button gets the models the route adapter reports',
    listed.status === 200 && listedBody.ok === true && listedBody.source === 'discovery' &&
      listedBody.models.some(entry => entry.id === 'deepseek-v4-pro' && entry.label === 'DeepSeek V4 Pro'),
    listed.body)

  const catalogued = await call({ port: GATEWAY_PORT, path: '/__gateway/models?provider=deepseek-official', jar: formJar })
  const cataloguedBody = JSON.parse(catalogued.body)
  check('a route with no discovery falls back to the catalogue dsh already holds',
    catalogued.status === 200 && cataloguedBody.ok === true && cataloguedBody.source === 'catalogue' &&
      cataloguedBody.models.some(entry => entry.id === 'deepseek-flash'),
    catalogued.body)

  const anonymousList = await call({ port: GATEWAY_PORT, path: '/__gateway/models?provider=deepseek' })
  check('the model list is not served to a stranger',
    anonymousList.status === 401, `status ${String(anonymousList.status)}`)

  const formForButton = await call({ port: GATEWAY_PORT, path: '/__gateway/settings', jar: formJar })
  check('the configuration page offers the fetch-models button',
    formForButton.body.includes('id="fetchModels"') && formForButton.body.includes('获取模型'),
    'the button is missing from the form')

  // --- An upstream that dies mid-body must not take the gateway with it --------
  // Restarting an account's dsh �?a host grant, a credential re-mint, the idle
  // reaper �?resets every response still streaming out of the old process. An
  // unhandled 'error' on that IncomingMessage ended the whole gateway, which is
  // how the local service kept vanishing with nothing in its log.
  await call({ port: GATEWAY_PORT, path: '/reset', jar: shellJar }).catch(() => undefined)
  check('a mid-body upstream reset leaves the gateway process running',
    configGateway.exitCode === null, `exit code ${String(configGateway.exitCode)}`)
  const afterReset = await call({ port: GATEWAY_PORT, path: '/shell', jar: shellJar })
  check('the gateway still relays after an upstream reset',
    afterReset.status === 200 && afterReset.body.includes('dsh shell'),
    `status ${String(afterReset.status)}`)

  // --- One hostname, two gateways ------------------------------------------------
  // A router's gateway and a workstation's can share one name on different ports
  // (`home.example.com:2020` and `home.example.com:2021`). Cookies ignore the port,
  // so a single shared cookie name makes each sign-in silently sign the browser out
  // of the other instance: the second gateway reads a session id from a different
  // table and answers `{"error":"unauthenticated"}` on every request even though the
  // browser just signed in. The name is namespaced by the authority instead.
  console.log('\n== 15. two authorities on one hostname keep separate sign-ins ==')
  const elsewhere = `home.example.test:${String(GATEWAY_PORT)}`
  const secondJar = {}
  const secondLogin = await call({
    port: GATEWAY_PORT,
    method: 'POST',
    path: '/__gateway/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', host: elsewhere },
    body: 'name=admin&password=admin12345',
  })
  absorb(secondJar, secondLogin)
  check('signing in on a second authority succeeds and names its own cookie',
    secondLogin.status === 303 &&
      Object.keys(secondJar).some(name => name.startsWith('dsh-gateway-session-')),
    `status ${String(secondLogin.status)} jar ${JSON.stringify(secondJar)}`)

  const crossAuthority = await call({
    port: GATEWAY_PORT,
    path: '/__gateway/models?provider=deepseek',
    headers: { cookie: jarHeader(secondJar) },
  })
  check('a sign-in made on another authority is not accepted here',
    crossAuthority.status === 401, `status ${String(crossAuthority.status)}`)

  const onItsAuthority = await call({
    port: GATEWAY_PORT,
    path: '/__gateway/models?provider=deepseek',
    headers: { cookie: jarHeader(secondJar), host: elsewhere },
  })
  check('the same cookie works on the authority it was issued for',
    onItsAuthority.status === 200, `status ${String(onItsAuthority.status)}`)

  await stop(configGateway)

  await new Promise(resolve => upstream.close(resolve))
  await new Promise(resolve => control.close(resolve))

  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
  if (failures > 0) process.exitCode = 1
}

await main()
