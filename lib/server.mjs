/**
 * The gateway's HTTP server.
 *
 * It owns three things, in this order:
 *
 *   1. The entry point. It serves its own sign-in page and only forwards
 *      authenticated traffic, so dsh's bare 401 is never what a user sees.
 *   2. The launch-token exchange. dsh's token is redeemed server-side, so it
 *      never reaches the browser and never appears in an address bar.
 *   3. Host transparency. dsh binds its session cookie to the request
 *      authority — the cookie *name* is a hash of it — so the browser's `Host`
 *      is preserved on every relayed request. That is why this file uses
 *      `http.request`: undici forbids overriding `Host`, so a `fetch`-based
 *      gateway would silently mint cookies for the wrong authority.
 *
 * Two durability properties are deliberate, because the failure they prevent is
 * the one observed with QR-pairing: a credential that silently goes stale
 * strands the user on a broken page.
 *
 *   - Sign-in survives a gateway restart and a closed browser tab: sessions are
 *     persisted with an absolute expiry and the cookie carries `Max-Age`.
 *   - A cached dsh credential that dsh later rejects is re-minted once, inline,
 *     instead of relaying a 401 forever.
 *
 * The target is resolved per request. With a pool, that means "this user's own
 * dsh process"; without one, it is the single `--target` the prototype used.
 */

import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { adminPage, injectGatewayControls, loginPage, settingsPage } from './pages.mjs'
import { createConfigClient, listModelCandidates, readModelConfig, saveModelConfig } from './model-config.mjs'

/** Largest document the relay will buffer to inject the gateway's controls. */
const MAX_INJECT_BYTES = 512 * 1024

/** The gateway's own configuration surface. */
const SETTINGS_PATH = '/__gateway/settings'

/** The JSON endpoint the configuration page's fetch-models button calls. */
const MODELS_PATH = '/__gateway/models'

/** Resolve the default public-asset set. */
const DEFAULT_PUBLIC_ASSETS = [
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/apple-touch-icon.png',
]

/**
 * Build the gateway server.
 *
 * @param options - configuration and collaborators.
 * @param options.listenPort - port to bind.
 * @param options.listenHost - interface to bind.
 * @param options.target - single-target mode: the upstream dsh origin.
 * @param options.launchToken - single-target mode: that dsh's launch token.
 * @param options.pool - spawn mode: the per-user instance pool.
 * @param options.accounts - the account store.
 * @param options.throttle - the sign-in throttle.
 * @param options.stateFile - where gateway sessions are persisted.
 * @param options.sessionTtlMs - absolute sign-in lifetime.
 * @param options.maxReplayBytes - largest body the stale-retry can replay.
 * @param options.publicAssets - extra credential-less paths to relay.
 * @param options.admin - the admin API handler.
 * @param options.log - logger.
 * @returns `{ server, sessions, listen, close, revokeUser }`.
 */
export function createGateway({
  listenPort,
  listenHost,
  target,
  launchToken,
  pool,
  accounts,
  throttle,
  stateFile,
  sessionTtlMs = 30 * 24 * 60 * 60 * 1000,
  maxReplayBytes = 4 * 1024 * 1024,
  publicAssets = [],
  admin,
  log = console,
}) {
  const GATEWAY_COOKIE = 'dsh-gateway-session'
  const SESSION_TTL_SEC = Math.floor(sessionTtlMs / 1000)

  /**
   * The name of this deployment's sign-in cookie, namespaced by the authority the
   * browser used to reach it.
   *
   * Two gateways can share one hostname on different ports — a router's and a
   * workstation's, reached as `home.example.com:2020` and `home.example.com:2021`.
   * Cookies ignore the port, so a single shared name makes each sign-in silently
   * sign the browser out of the other instance: the second gateway reads a session
   * id that belongs to a different table and answers `{"error":"unauthenticated"}`.
   * Naming the cookie after the authority keeps the two apart, and the same
   * gateway reached by a second name simply asks for a second sign-in.
   */
  const sessionCookieName = authority =>
    `${GATEWAY_COOKIE}-${createHash('sha256').update(String(authority ?? '')).digest('hex').slice(0, 8)}`

  /**
   * Paths the browser fetches WITHOUT credentials.
   *
   * The Web App Manifest is fetched with credentials mode `omit` by spec, and
   * the favicon probe sends no cookies either. Gating those on the gateway
   * session makes them answer 401 even for a signed-in user, which silently
   * breaks "add to home screen" — the exact feature this gateway exists to
   * enable. dsh serves these paths publicly, so the gateway relays them
   * uncredentialed and lets dsh decide.
   */
  const PUBLIC_ASSETS = new Set([...DEFAULT_PUBLIC_ASSETS, ...publicAssets])

  /** Gateway sessions: gatewayCookie -> { name, expiresAt }. */
  const sessions = new Map()

  const digest = value => createHash('sha256').update(value).digest()

  /** Compare two secrets without leaking length or content through timing. */
  function secretEquals(a, b) {
    return timingSafeEqual(digest(a), digest(b))
  }

  /** Parse the request's cookies into name -> value. */
  function parseCookies(header) {
    const out = {}
    for (const part of String(header ?? '').split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
    }
    return out
  }

  /**
   * Load persisted sign-ins, dropping entries whose expiry has passed.
   *
   * An unreadable or malformed state file is reported and ignored: it costs the
   * user one sign-in, which must never be worse than refusing to start.
   */
  function loadState() {
    if (!existsSync(stateFile)) return
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
      const now = Date.now()
      let dropped = 0
      for (const [sid, record] of Object.entries(raw?.sessions ?? {})) {
        const name = record?.name
        const expiresAt = record?.expiresAt
        if (typeof name === 'string' && Number.isFinite(expiresAt) && expiresAt > now) {
          sessions.set(sid, { name, expiresAt })
        } else {
          dropped += 1
        }
      }
      log.log(`sessions restored: ${String(sessions.size)}${dropped > 0 ? ` (${String(dropped)} expired)` : ''}`)
    } catch (error) {
      log.error(`gateway: ignoring unreadable session state (${error.message})`)
    }
  }

  /**
   * Persist the sign-in table atomically, so a crash mid-write can never leave a
   * half-written file that logs everyone out.
   */
  function saveState() {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const payload = { version: 1, sessions: Object.fromEntries(sessions) }
      const temp = `${stateFile}.tmp-${String(process.pid)}`
      writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 })
      renameSync(temp, stateFile)
    } catch (error) {
      log.error(`gateway: failed to persist session state (${error.message})`)
    }
  }

  /** Resolve a live sign-in, evicting it when its absolute expiry has passed. */
  function liveSessionOf(sid) {
    if (sid === undefined) return undefined
    const record = sessions.get(sid)
    if (record === undefined) return undefined
    if (record.expiresAt <= Date.now()) {
      sessions.delete(sid)
      saveState()
      return undefined
    }
    return record.name
  }

  /** Drop every session belonging to a user, used when they are disabled. */
  function revokeUser(name) {
    let dropped = 0
    for (const [sid, record] of sessions) {
      if (record.name === name) {
        sessions.delete(sid)
        dropped += 1
      }
    }
    if (dropped > 0) saveState()
    return dropped
  }

  /** The gateway's sign-in cookie, durable for the configured lifetime. */
  const sessionCookie = (authority, sid) =>
    `${sessionCookieName(authority)}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(SESSION_TTL_SEC)}`

  /** Clear the sign-in cookie. */
  const clearSessionCookie = authority =>
    `${sessionCookieName(authority)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

  /**
   * The browser's opaque handle to its dsh session.
   *
   * dsh's own cookie is authority-bound, so the gateway keeps it server-side
   * material and hands the browser only this encoded copy. Same lifetime as the
   * sign-in: a browser that still knows its account keeps its dsh session too.
   */
  const relayCookie = value =>
    `__dsh_relay=${Buffer.from(value, 'utf8').toString('base64url')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(SESSION_TTL_SEC)}`

  /**
   * Resolve the upstream dsh for one user.
   *
   * In spawn mode this starts the user's own process if it is not running, which
   * is the whole point: the process — and therefore the session store and the
   * `DSH_HOME` — belongs to that account alone.
   */
  async function targetFor(user) {
    if (pool !== undefined) {
      const instance = await pool.acquire(user)
      return {
        hostname: instance.origin.hostname,
        port: instance.origin.port,
        token: instance.token,
      }
    }
    return { hostname: target.hostname, port: target.port, token: launchToken }
  }

  /**
   * Issue one upstream GET with an explicit `Host`.
   *
   * `fetch()` is unusable here: undici forbids overriding `Host`, so a gateway
   * built on it would mint cookies for the wrong authority. `http.request`
   * honours it, and Host transparency is the whole mechanism.
   */
  function upstreamGet(upstream, path, host) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: upstream.hostname,
        port: upstream.port,
        path,
        method: 'GET',
        headers: { host, accept: 'text/html' },
      }, (res) => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
          setCookie: res.headers['set-cookie'] ?? [],
        }))
        // The body can reset after the headers arrived; without this the
        // socket error surfaces as an unhandled 'error' event.
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  }

  /**
   * Exchange dsh's launch token for a browser session cookie, server-side.
   *
   * The exchange is `GET /?token=<launch token>` under the SAME Host the browser
   * will later use: dsh binds the issued cookie to the request authority, and the
   * cookie *name* is a hash of it, so a mismatched Host is a lookup miss (401)
   * rather than a permission error.
   *
   * @param upstream - resolved target for this user.
   * @param publicAuthority - the `host:port` the browser used.
   * @returns the cookie pair dsh expects later, or undefined.
   */
  async function mintDshCookie(upstream, publicAuthority) {
    if (upstream.token === undefined) return undefined
    const hop = await upstreamGet(upstream, `/?token=${encodeURIComponent(upstream.token)}`, publicAuthority)
    const pairs = hop.setCookie.map(c => c.split(';')[0]).filter(p => p.length > 0)
    return pairs.length > 0 ? pairs.join('; ') : undefined
  }

  /** Read a request body as text. */
  async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }

  /** Read a request body into memory so it can be replayed on a retry. */
  async function readBodyBuffer(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  /**
   * Whether this request's body can be buffered and therefore replayed.
   *
   * A GET or HEAD has no body. Anything else is replayable only when its declared
   * length is present and within the cap: a chunked or oversized body streams
   * straight through and keeps the single-attempt behaviour.
   */
  function canReplay(request) {
    if (request.method === 'GET' || request.method === 'HEAD') return true
    const length = Number(request.headers['content-length'])
    return Number.isFinite(length) && length <= maxReplayBytes
  }

  /**
   * Start one upstream request and resolve once its response headers arrive.
   * The body is either a buffered payload or the still-open client stream.
   */
  function openUpstream(upstream, { method, url, headers, body, request }) {
    return new Promise((resolve, reject) => {
      const outbound = httpRequest({
        host: upstream.hostname,
        port: upstream.port,
        path: url,
        method,
        headers,
      }, resolve)
      outbound.on('error', reject)
      if (body !== undefined) outbound.end(body)
      else request.pipe(outbound)
    })
  }

  /**
   * Copy one upstream response to the browser, keeping the launch token out of
   * the address bar and re-issuing the relay handle whenever dsh rotates it.
   */
  function pipeUpstream(up, res, fallbackRelay, inject = false, admin = false) {
    const out = { ...up.headers }
    delete out['transfer-encoding']
    if (out.location !== undefined && out.location.includes('token=')) out.location = '/'
    const raw = up.headers['set-cookie']
    if (raw !== undefined) {
      const passthrough = []
      let relayed
      for (const single of raw) {
        const pair = single.split(';')[0]
        const name = pair.slice(0, pair.indexOf('='))
        // The dsh session cookie is opaque to the browser through the gateway:
        // keep it in the relay handle so no rule can drop or shadow it.
        if (name.startsWith('dsh-auth-')) {
          relayed = pair
          passthrough.push(relayCookie(pair))
          continue
        }
        passthrough.push(single)
      }
      if (relayed !== undefined) passthrough.push(relayCookie(relayed))
      else if (fallbackRelay !== undefined) passthrough.push(relayCookie(fallbackRelay))
      out['set-cookie'] = passthrough
    }
    // dsh's own shell has no chrome of its own — no navigation back to the
    // gateway and, more importantly, no way to sign out. Inject those two
    // controls into the shell. Only uncompressed `text/html` is touched, and
    // anything larger than the cap is relayed byte-for-byte instead.
    const injectable = inject &&
      (up.headers['content-type'] ?? '').includes('text/html') &&
      up.headers['content-encoding'] === undefined
    if (!injectable) {
      res.writeHead(up.statusCode ?? 502, out)
      // The upstream resets mid-body whenever this gateway restarts that
      // account's dsh (grant, credential re-mint, idle reap) while a response is
      // still streaming. An unhandled 'error' on an IncomingMessage is fatal, so
      // the truncated relay has to end here instead of ending the process.
      up.on('error', () => {
        res.destroy()
      })
      up.pipe(res)
      return
    }
    const chunks = []
    let size = 0
    let overflowed = false
    up.on('data', (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (size > MAX_INJECT_BYTES) overflowed = true
    })
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end()
    })
    up.on('end', () => {
      const original = Buffer.concat(chunks)
      const body = overflowed ? original : Buffer.from(injectGatewayControls(original.toString('utf8'), { admin }), 'utf8')
      out['content-length'] = String(body.length)
      res.writeHead(up.statusCode ?? 502, out)
      res.end(body)
    })
  }

  /**
   * Whether a request authority is loopback.
   *
   * dsh's browser-trust fence always accepts loopback and only accepts other
   * authorities when they were declared with `--trusted-host` (or derived from a
   * `0.0.0.0` bind). Knowing which side of that line an authority falls on is
   * what lets the gateway turn a bare 403 into an actionable message.
   */
  function isLoopbackAuthority(authority) {
    try {
      const { hostname } = new URL(`http://${authority}`)
      return hostname === 'localhost' || hostname === '::1' ||
        hostname === '[::1]' || /^127\./.test(hostname)
    } catch {
      return false
    }
  }

  /** Authorities already reported as untrusted, so the advice prints once each. */
  const warnedUntrustedAuthorities = new Set()

  /**
   * The bare hostname of a request authority, for dsh's `--trusted-host`.
   *
   * dsh matches a port-less entry against any port, so the port is deliberately
   * dropped here: the same page can be reached on several gateway ports or
   * through a proxy that rewrites the port.
   */
  function hostnameOf(authority) {
    try {
      return new URL(`http://${authority}`).hostname
    } catch {
      return undefined
    }
  }

  /**
   * Accept only a same-origin absolute path as a post-sign-in destination.
   *
   * `next` arrives in a form body, so it is attacker-controlled. Anything that
   * could leave the origin — a scheme, a protocol-relative `//host`, a backslash
   * that some browsers normalize to a slash — is discarded rather than sanitized.
   */
  function safeNext(raw) {
    if (typeof raw !== 'string' || raw === '') return '/'
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
    return raw
  }

  /** Reply with the gateway's own sign-in page. */
  function sendLogin(res, status, error, next = '', mode = 'dsh') {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(loginPage(error, next, mode))
  }

  /**
   * The running instance behind an account, when the gateway spawns them.
   *
   * Single-target mode has one process for everybody, so there is nothing to hang
   * a cached loopback credential on and each read mints one.
   */
  function instanceOf(user) {
    return pool === undefined ? undefined : pool.instances.get(user)
  }

  /**
   * A loopback-bound dsh session for the gateway's own calls into one instance.
   *
   * The credential the browser holds is bound to the browser's authority and
   * cannot be reused from here. This mints a second one against loopback — which
   * dsh always trusts, whatever `--trusted-host` says — and caches it on the
   * instance, because minting one costs a session in that user's dsh.
   */
  async function loopbackCredential(user) {
    const instance = instanceOf(user)
    if (instance?.gatewayCredential !== undefined) return instance.gatewayCredential
    const upstream = await targetFor(user)
    const minted = await mintDshCookie(upstream, `127.0.0.1:${String(upstream.port)}`)
    if (instance !== undefined) instance.gatewayCredential = minted
    return minted
  }

  /** Open a configuration channel to this user's own dsh. */
  async function configClientFor(user) {
    const upstream = await targetFor(user)
    const cookie = await loopbackCredential(user)
    if (cookie === undefined) throw new Error('dsh did not hand the gateway a loopback session')
    return createConfigClient({ port: upstream.port, cookie })
  }

  /** Render the configuration page, reading live state unless one is supplied. */
  async function renderSettings(res, user, { status = 200, state, error = '', notice = '' } = {}) {
    let config = state
    let message = error
    if (config === undefined) {
      try {
        config = await readModelConfig(await configClientFor(user))
      } catch (failure) {
        message = message === '' ? failure.message : `${message}（${failure.message}）`
      }
    }
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(settingsPage({
      user,
      config: config ?? { options: [], provider: '', model: '', keyRef: '', keyConfigured: false, writable: false },
      error: message,
      notice,
    }))
  }

  /**
   * Relay a credential-less static asset.
   *
   * Without a session there is no user, and therefore no instance to ask; any
   * running instance serves byte-identical static files, so one is borrowed.
   */
  async function relayPublicAsset(req, res, cookies) {
    const name = liveSessionOf(cookies[sessionCookieName(req.headers.host)])
    let upstream
    try {
      if (name !== undefined) upstream = await targetFor(name)
      else if (pool !== undefined) {
        const running = pool.status()
        if (running.length === 0) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('gateway: no dsh instance is running yet\n')
          return
        }
        const first = pool.instances.get(running[0].user)
        upstream = { hostname: '127.0.0.1', port: first.port, token: first.token }
      } else {
        upstream = { hostname: target.hostname, port: target.port, token: launchToken }
      }
      const assetHeaders = { ...req.headers }
      delete assetHeaders.cookie
      delete assetHeaders['accept-encoding']
      const asset = await openUpstream(upstream, {
        method: req.method,
        url: req.url,
        headers: assetHeaders,
        body: Buffer.alloc(0),
      })
      pipeUpstream(asset, res)
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`gateway: upstream error: ${error.message}\n`)
    }
  }

  const server = createServer(async (req, res) => {
    // A browser that navigates away, or a reverse proxy that closes an idle
    // connection, resets the socket underneath both of these. That is routine
    // traffic here, and neither object is worth ending the process over: an
    // unhandled 'error' on a socket is fatal in Node on Windows.
    req.on('error', () => { /* the client is gone */ })
    res.on('error', () => { /* the client is gone */ })
    const cookies = parseCookies(req.headers.cookie)
    const url = new URL(req.url ?? '/', 'http://placeholder')

    // --- Health, for container orchestration ------------------------------------
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        ok: true,
        sessions: sessions.size,
        instances: pool === undefined ? 0 : pool.instances.size,
      }))
      return
    }

    // --- Gateway-owned entry point ----------------------------------------------
    if (url.pathname === '/__gateway/login' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req))
      const name = params.get('name') ?? ''
      const password = params.get('password') ?? ''
      // The switch on the sign-in page chooses the destination directly, so the
      // choice travels as its own field: with scripting off the radio button is
      // all the browser sends, and the hidden `next` still holds the old value.
      const mode = params.get('mode') === 'setting' ? 'setting' : 'dsh'
      const next = mode === 'setting' ? SETTINGS_PATH : safeNext(params.get('next'))
      const address = req.socket.remoteAddress ?? 'unknown'
      const keys = [`addr:${address}`]
      const locked = keys.map(key => throttle.retryAfter(key)).find(seconds => seconds > 0)
      if (locked !== undefined) {
        res.writeHead(429, { 'retry-after': String(locked), 'content-type': 'text/html; charset=utf-8' })
        res.end(loginPage(`Too many attempts. Try again in ${String(locked)} seconds.`, next, mode))
        return
      }
      keys.push(`name:${name}`)
      const lockedName = keys.map(key => throttle.retryAfter(key)).find(seconds => seconds > 0)
      if (lockedName !== undefined) {
        res.writeHead(429, { 'retry-after': String(lockedName), 'content-type': 'text/html; charset=utf-8' })
        res.end(loginPage(`Too many attempts. Try again in ${String(lockedName)} seconds.`, next, mode))
        return
      }
      if (!accounts.authenticate(name, password)) {
        for (const key of keys) throttle.fail(key)
        sendLogin(res, 401, 'Incorrect user name or password.', next, mode)
        return
      }
      for (const key of keys) throttle.succeed(key)

      const sid = randomBytes(32).toString('base64url')
      sessions.set(sid, { name, expiresAt: Date.now() + sessionTtlMs })
      saveState()

      // Mint the dsh session now, while we still know the authority the browser
      // is using, and hand the browser an opaque handle to it. Doing this here
      // means every later request is a plain relay with no re-minting.
      let dshCookie
      try {
        dshCookie = await mintDshCookie(await targetFor(name), req.headers.host)
      } catch (error) {
        sessions.delete(sid)
        saveState()
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`gateway: could not start dsh for ${name}: ${error.message}\n`)
        return
      }
      const cookiesOut = [sessionCookie(req.headers.host, sid)]
      if (dshCookie !== undefined) cookiesOut.push(relayCookie(dshCookie))
      res.writeHead(303, { 'set-cookie': cookiesOut, location: next, 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (url.pathname === '/__gateway/logout' && req.method === 'POST') {
      const sid = cookies[sessionCookieName(req.headers.host)]
      const signedOut = sid === undefined ? undefined : sessions.get(sid)?.name
      if (sid !== undefined) {
        sessions.delete(sid)
        saveState()
      }
      // Signing out is the user-visible "restart my dsh": the account's instance is
      // stopped here, so an account nobody is looking at never keeps a process (and
      // a loopback port) open. Everything durable lives in DSH_HOME, so the next
      // sign-in loses nothing, and another tab that is still signed in re-mints its
      // relay handle on its next request.
      if (signedOut !== undefined && pool !== undefined) {
        pool.stop(signedOut, 'signed out')
      }
      // Drop the relayed dsh handle as well. It is opaque and HttpOnly, but
      // keeping it would mean "sign out" left live access sitting in the browser.
      // Land on the login page itself, not on `/`: the app shell there may be a
      // cached document, and a signed-out browser must not be shown one.
      res.writeHead(303, {
        'set-cookie': [
          clearSessionCookie(req.headers.host),
          '__dsh_relay=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        ],
        location: '/__gateway/login',
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    // --- The user's own model configuration ---------------------------------------
    if (url.pathname === SETTINGS_PATH) {
      const viewer = liveSessionOf(cookies[sessionCookieName(req.headers.host)])
      if (viewer === undefined) {
        if ((req.headers.accept ?? '').includes('text/html')) {
          sendLogin(res, 200, 'Sign in to configure your models.', SETTINGS_PATH, 'setting')
          return
        }
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":"unauthenticated"}')
        return
      }
      if (req.method !== 'POST') {
        await renderSettings(res, viewer)
        return
      }
      const params = new URLSearchParams(await readBody(req))
      const provider = (params.get('provider') ?? '').trim()
      const apiKey = (params.get('apiKey') ?? '').trim()
      const model = (params.get('model') ?? '').trim()
      if (provider === '') {
        await renderSettings(res, viewer, { status: 400, error: '选择一个服务商。' })
        return
      }
      if (apiKey === '' && model === '') {
        await renderSettings(res, viewer, { status: 400, error: 'API Key 和默认模型都是空的，没有可保存的内容。' })
        return
      }
      try {
        const { ref, changed } = await saveModelConfig(await configClientFor(viewer), { provider, apiKey, model })
        log.log(`gateway: ${viewer} saved ${changed.join(' + ')} for provider ${provider} (${ref})`)
        await renderSettings(res, viewer, { notice: `已保存并注入：${changed.join('、')}。` })
      } catch (error) {
        await renderSettings(res, viewer, { status: 400, error: error.message })
      }
      return
    }

    // --- The model list behind the configuration page's fetch button --------------
    // The page asks the route's own adapter through the user's dsh, so a model id
    // need not be typed from memory. The answer is JSON: the button updates the
    // form in place, and a route with no discovery still answers from the
    // catalogue dsh already holds for it.
    if (url.pathname === MODELS_PATH) {
      const viewer = liveSessionOf(cookies[sessionCookieName(req.headers.host)])
      const jsonHead = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      }
      if (viewer === undefined) {
        res.writeHead(401, jsonHead)
        res.end('{"ok":false,"models":[],"error":"unauthenticated"}')
        return
      }
      const provider = (url.searchParams.get('provider') ?? '').trim()
      if (provider === '') {
        res.writeHead(200, jsonHead)
        res.end('{"ok":false,"models":[],"error":"先选择一个服务商。"}')
        return
      }
      try {
        const found = await listModelCandidates(await configClientFor(viewer), provider)
        log.log(`gateway: ${viewer} listed ${String(found.models.length)} models for ${provider} (${found.source || 'none'})`)
        res.writeHead(200, jsonHead)
        res.end(JSON.stringify({
          ok: found.models.length > 0,
          models: found.models,
          source: found.source,
          error: found.models.length > 0
            ? ''
            : `dsh 报不出 ${provider} 的模型，请手工填写模型 id（${found.note}）`,
        }))
      } catch (error) {
        res.writeHead(200, jsonHead)
        res.end(JSON.stringify({ ok: false, models: [], error: error.message }))
      }
      return
    }

    // --- Admin console ------------------------------------------------------------
    if (url.pathname === '/__gateway/admin' || url.pathname.startsWith('/__gateway/admin/')) {
      const name = liveSessionOf(cookies[sessionCookieName(req.headers.host)])
      const account = name === undefined ? undefined : accounts.get(name)
      if (account === undefined || !account.admin) {
        if (url.pathname === '/__gateway/admin' && (req.headers.accept ?? '').includes('text/html')) {
          sendLogin(res, 403, 'Sign in with an administrator account to manage users.', '/__gateway/admin')
          return
        }
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end('{"error":"administrator only"}')
        return
      }
      if (url.pathname.startsWith('/__gateway/admin/api')) {
        await admin(req, res, url, account.name)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(adminPage())
      return
    }

    // Unauthenticated at the gateway: serve the gateway's own page for anything
    // that a browser navigates to, so `/` never shows dsh's bare 401.
    const sessionUser = liveSessionOf(cookies[sessionCookieName(req.headers.host)])
    if (sessionUser === undefined) {
      if (PUBLIC_ASSETS.has(url.pathname)) {
        await relayPublicAsset(req, res, cookies)
        return
      }
      const wantsHtml = (req.headers.accept ?? '').includes('text/html')
      if (wantsHtml) {
        sendLogin(res, 200, '')
        return
      }
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthenticated"}')
      return
    }

    // --- Authenticated: relay to this user's dsh ----------------------------------
    const publicAuthority = req.headers.host
    const presentedRelay = cookies['__dsh_relay']

    // Buffer a replayable body once, so a stale-credential retry can resend it.
    const replayable = canReplay(req)
    const bufferedBody = replayable ? await readBodyBuffer(req) : undefined

    let upstream
    try {
      upstream = await targetFor(sessionUser)
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`gateway: could not start dsh for ${sessionUser}: ${error.message}\n`)
      return
    }

    let dshCookie = presentedRelay !== undefined
      ? Buffer.from(presentedRelay, 'base64url').toString('utf8')
      : undefined

    // No dsh session for this browser: mint one and bounce through the same URL
    // once, so the relay never recomputes on a request it cannot authenticate.
    if (dshCookie === undefined) {
      const minted = await mintDshCookie(upstream, publicAuthority)
      if (minted === undefined) {
        const reason = upstream.token === undefined
          ? 'no launch token configured'
          : 'dsh refused the token exchange'
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end([
          `gateway: cannot obtain a dsh session (${reason}).`,
          '',
          'In single-target mode the gateway needs the token dsh prints at startup:',
          '  dsh web: http://127.0.0.1:3081/?token=<token>',
          '',
          'Pass it to the gateway with --token <token> (or DSH_LAUNCH_TOKEN).',
          'In spawn mode (--spawn) the gateway reads the banner itself.',
          '',
        ].join('\n'))
        return
      }
      res.writeHead(303, {
        'set-cookie': relayCookie(minted),
        location: req.url ?? '/',
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    // Forward with the browser's own Host preserved: dsh keys its cookie on it.
    const headers = { ...req.headers }
    delete headers['accept-encoding'] // keep the relay simple
    // Send BOTH the relayed dsh session and the browser's own cookies. A second
    // gate on dsh's side needs its own cookie; replacing rather than merging
    // either one breaks the other layer.
    const appCookies = Object.entries(cookies)
      .filter(([name]) => name !== '__dsh_relay')
      .map(([name, value]) => `${name}=${value}`)
    headers.cookie = [dshCookie, ...appCookies].join('; ')
    if (process.env.GATEWAY_DEBUG === '1') {
      log.log(`[relay] ${req.method} ${req.url} host=${publicAuthority} cookies=[${[dshCookie, ...appCookies].map(c => c.split('=')[0]).join(',')}]`)
    }

    let regranted = false
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response
      try {
        response = await openUpstream(upstream, {
          method: req.method,
          url: req.url,
          headers,
          body: bufferedBody,
          request: req,
        })
      } catch (error) {
        if (res.headersSent) { res.destroy(); return }
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`gateway: upstream error: ${error.message}\n`)
        return
      }

      // A cached dsh credential can go stale (dsh rotated its secret, or the
      // cookie outlived its Max-Age). Without this branch the gateway would relay
      // that 401 forever and the user would be stranded on a broken page even
      // though their sign-in is still valid. Re-mint once and replay the request.
      if (response.statusCode === 401 && attempt === 1 && bufferedBody !== undefined) {
        const fresh = await mintDshCookie(upstream, publicAuthority)
        if (fresh !== undefined && fresh !== dshCookie) {
          response.resume() // discard the stale refusal; it is not the user's answer
          dshCookie = fresh
          headers.cookie = [fresh, ...appCookies].join('; ')
          log.log('gateway: cached dsh credential was rejected; re-minted and retried')
          continue
        }
      }

      // dsh's browser-trust fence answers 403 `forbidden` when the request
      // authority is neither loopback nor a declared `--trusted-host`. dsh fixes
      // that list when it starts, and an operator cannot pre-enumerate every name
      // a reverse proxy or a phone will use, so the first refusal is turned into
      // a grant: restart this account's dsh with the host added and replay once.
      // The symptom being fixed is nasty — the page loads while every API call
      // silently fails — so the cause is named either way.
      if (response.statusCode === 403 && !isLoopbackAuthority(publicAuthority)) {
        const host = hostnameOf(publicAuthority)
        if (pool !== undefined && host !== undefined && !regranted &&
            !pool.grantedHosts(sessionUser).has(host)) {
          regranted = true
          response.resume() // discard the refusal; it is not the user's answer
          if (pool.grantHost(sessionUser, host)) {
            log.log(`gateway: ${sessionUser}'s dsh did not trust ${host}; restarting it once with that grant`)
            try {
              upstream = await targetFor(sessionUser)
            } catch (error) {
              if (res.headersSent) { res.destroy(); return }
              res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
              res.end(`gateway: could not restart dsh for ${sessionUser}: ${error.message}\n`)
              return
            }
            const fresh = await mintDshCookie(upstream, publicAuthority)
            if (fresh !== undefined) {
              dshCookie = fresh
              headers.cookie = [fresh, ...appCookies].join('; ')
            }
            continue
          }
        }
        if (!warnedUntrustedAuthorities.has(publicAuthority)) {
          warnedUntrustedAuthorities.add(publicAuthority)
          log.error([
            `gateway: dsh refused ${publicAuthority} with 403 (browser-trust fence).`,
            '         Start dsh with a port-less trust grant for this host:',
            `           --trusted-host ${String(host)}`,
            '         The port-less form covers any gateway port; a "host:port" entry',
            '         covers only that exact port. In spawn mode the gateway does this',
            '         itself on the first refusal, so seeing this line twice is a bug.',
          ].join('\n'))
        }
      }

      // Only the initial document navigation gets the injected controls: a
      // `text/html` fragment fetched by the app (or a POST that answers with
      // HTML) must come back exactly as dsh wrote it.
      const inject = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
      pipeUpstream(response, res, dshCookie, inject, accounts.get(sessionUser)?.admin === true)
      return
    }
  })

  /**
   * Carry the transport upgrade to dsh.
   *
   * The Web GUI opens a WebSocket for its live stream, so a gateway that proxies
   * only ordinary HTTP leaves the page permanently "reconnecting" even though
   * every REST call succeeds. The upgrade must be forwarded raw, with the Host
   * preserved for the same reason ordinary requests need it.
   */
  function relayUpgrade(req, clientSocket, head) {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    void url
    const cookies = parseCookies(req.headers.cookie)
    const name = liveSessionOf(cookies[sessionCookieName(req.headers.host)])
    if (name === undefined) {
      clientSocket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    const dshCookie = cookies['__dsh_relay']
      ? Buffer.from(cookies['__dsh_relay'], 'base64url').toString('utf8')
      : undefined
    if (dshCookie === undefined) {
      clientSocket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }

    // Preserve the browser's Host and feed dsh the relayed session, exactly as
    // the HTTP relay does.
    const headers = { ...req.headers }
    const appCookies = Object.entries(cookies)
      .filter(([cookieName]) => cookieName !== '__dsh_relay')
      .map(([cookieName, value]) => `${cookieName}=${value}`)
    headers.cookie = [dshCookie, ...appCookies].join('; ')

    void (async () => {
      let upstream
      try {
        upstream = await targetFor(name)
      } catch {
        clientSocket.destroy()
        return
      }
      const outbound = httpRequest({
        host: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers,
      })

      outbound.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? 'Switching Protocols'}`]
        for (const [headerName, value] of Object.entries(upRes.headers)) {
          if (Array.isArray(value)) for (const one of value) lines.push(`${headerName}: ${one}`)
          else if (value !== undefined) lines.push(`${headerName}: ${value}`)
        }
        clientSocket.write(lines.join('\r\n') + '\r\n\r\n')
        if (upHead.length > 0) clientSocket.write(upHead)
        upSocket.pipe(clientSocket)
        clientSocket.pipe(upSocket)
        const close = () => { upSocket.destroy(); clientSocket.destroy() }
        upSocket.on('error', close)
        clientSocket.on('error', close)
      })

      outbound.on('response', (upRes) => {
        // dsh refused the upgrade: pass the refusal through so the client can react.
        const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? 'Error'}`]
        for (const [headerName, value] of Object.entries(upRes.headers)) {
          if (Array.isArray(value)) for (const one of value) lines.push(`${headerName}: ${one}`)
          else if (value !== undefined) lines.push(`${headerName}: ${value}`)
        }
        clientSocket.write(lines.join('\r\n') + '\r\n\r\n')
        upRes.pipe(clientSocket)
      })

      outbound.on('error', () => clientSocket.destroy())
      if (head.length > 0) outbound.write(head)
      outbound.end()
    })()
  }

  server.on('upgrade', relayUpgrade)

  // A malformed request or a client that vanished mid-parse is answered by
  // destroying the socket. Node's default does the same thing, but it writes to
  // stderr and a long-lived service should treat this as routine, not as noise.
  server.on('clientError', (_error, socket) => {
    socket.destroy()
  })

  /** Start listening, loading persisted sessions as the banner is printed. */
  function listen() {
    return new Promise((resolve) => {
      server.listen(listenPort, listenHost, () => {
        loadState()
        log.log(`gateway listening on http://${listenHost}:${String(listenPort)}`)
        if (pool === undefined) {
          log.log(`target: ${target.origin}`)
          log.log(`launch token: ${launchToken === undefined ? 'MISSING — start the gateway with --token <token>' : 'configured'}`)
        } else {
          log.log(`mode: spawning one dsh per user (cap ${String(pool.maxInstances)}, idle reap ${String(Math.round(pool.idleMs / 60000))} min)`)
        }
        log.log(`session state: ${stateFile}`)
        resolve(server)
      })
    })
  }

  /** Stop listening. The caller is responsible for the pool. */
  function close() {
    return new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return { server, sessions, listen, close, revokeUser }
}
