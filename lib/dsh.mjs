/**
 * Launching one dsh process per user, and reading its launch token.
 *
 * dsh mints a launch token per process and prints it exactly once, as:
 *
 *     dsh web: http://127.0.0.1:<port>/?token=<token>
 *
 * The token is accepted only on `GET /` and is never exposed over HTTP, so this
 * banner is the only way for a supervisor to obtain a browser session. Reading
 * it is what turns the gateway from something an operator has to hand-feed
 * (`--token`) into something that owns the whole stack.
 *
 * `--port 0` is deliberate: the OS picks a free port and the banner reports it,
 * so per-user instances need no port allocator and cannot collide with each
 * other or with anything else on the host.
 */

import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'

/** How much recent output to keep for diagnostics. */
const LOG_TAIL_BYTES = 8192

/**
 * Pull the listening port and launch token out of dsh's startup output.
 * @param text - combined stdout and stderr seen so far.
 * @returns `{ port, token, url }`, or undefined until the banner is complete.
 */
export function parseDshBanner(text) {
  const match = /dsh\s+web:\s*(https?:\/\/\S+)/.exec(text)
  if (match === null) return undefined
  try {
    const url = new URL(match[1])
    const port = Number(url.port)
    const token = url.searchParams.get('token')
    if (!Number.isInteger(port) || port <= 0 || token === null || token.length === 0) return undefined
    return { port, token, url: match[1] }
  } catch {
    return undefined
  }
}

/**
 * Every authority this machine answers on, for dsh's browser-trust fence.
 *
 * The gateway preserves the browser's `Host`, which is what makes dsh's
 * authority-bound cookie work — but it also means dsh must be told in advance
 * that the LAN address is acceptable. Enumerating the local addresses means LAN
 * access works without the operator hand-writing `--trusted-host`.
 * @returns a de-duplicated list of host literals.
 */
export function localAuthorities() {
  const out = new Set(['localhost', '127.0.0.1'])
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue
      // Strip any zone suffix (`fe80::1%eth0`): dsh's validator parses the entry
      // as a URL authority, and a raw `%` there is not a legal authority.
      const literal = address.address.toLowerCase().split('%')[0]
      if (address.family === 'IPv4') out.add(literal)
      // IPv6 must be bracketed. dsh rejects a bare IPv6 literal outright — and
      // it does so by FAILING the client-connection plugin, which stops dsh from
      // starting at all, so this is not a cosmetic detail.
      else if (address.family === 'IPv6') out.add(`[${literal}]`)
    }
  }
  return [...out]
}

/**
 * Whether an authority is exactly the shape dsh's trusted-host fence accepts.
 *
 * dsh validates entries strictly and fails the whole client-connection plugin on
 * the first bad one, which means dsh refuses to start: one unexpected literal
 * from a machine's interface list would take every user's dsh down. Entries are
 * therefore checked here and dropped rather than passed on.
 *
 * The accepted shape is a bare `host` or `host:port` in canonical lower case —
 * no scheme, path, credentials, or whitespace. Mirrors dsh's own
 * `canonicalAuthority(entry) === entry.toLowerCase()` test.
 *
 * @param entry - a candidate authority.
 * @returns true when dsh will accept it.
 */
export function isBareAuthority(entry) {
  if (typeof entry !== 'string' || entry.length === 0) return false
  if (entry !== entry.trim() || entry.toLowerCase() !== entry) return false
  try {
    const url = new URL(`http://${entry}`)
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return false
    if (url.username !== '' || url.password !== '') return false
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === entry
  } catch {
    return false
  }
}

/**
 * Start a dsh process and wait for its banner.
 *
 * @param options - how to launch, and where.
 * @param options.command - the executable, e.g. `node`.
 * @param options.prefix - arguments before the app flags, e.g. the dsh `bin.js`.
 * @param options.profile - profile to boot (`web` by default).
 * @param options.patches - extra patch-list overlays, applied after the profile
 *   layer. These MUST be placed before the app's own flags: dsh hands everything
 *   from the first app argument onward to the app, so `--patch` written later is
 *   rejected as an unknown app option.
 * @param options.home - `DSH_HOME` for this instance.
 * @param options.host - bind host; loopback by default, behind the gateway.
 * @param options.port - bind port; 0 lets the OS choose.
 * @param options.trustedHosts - authorities dsh's fence should accept.
 * @param options.env - extra environment.
 * @param options.log - logger for lifecycle lines.
 * @param options.timeoutMs - how long to wait for the banner.
 * @returns `{ child, port, token, url, home, startedAt }`.
 */
export function launchDsh({
  command,
  prefix = [],
  profile = 'web',
  patches = [],
  home,
  host = '127.0.0.1',
  port = 0,
  trustedHosts = [],
  env = {},
  log = console,
  timeoutMs = 120_000,
}) {
  const args = [
    ...prefix,
    '--profile', profile,
    // Overlays sit between the profile name and the app's own flags. dsh gives
    // everything after the first app argument to the app, so a `--patch` written
    // after `--host` is rejected as an unknown app option.
    ...patches.flatMap(path => ['--patch', path]),
    '--host', host,
    '--port', String(port),
    '--no-open',
  ]
  // Drop anything dsh would reject: a single malformed entry makes dsh fail the
  // client-connection plugin and refuse to start, so this guard is what keeps a
  // surprising network interface from taking the gateway down.
  const accepted = trustedHosts.filter(isBareAuthority)
  for (const rejected of trustedHosts.filter(entry => !isBareAuthority(entry))) {
    log.error(`dsh: ignoring trusted-host entry ${JSON.stringify(rejected)} (not a bare host[:port])`)
  }
  for (const authority of accepted) args.push('--trusted-host', authority)

  return new Promise((resolve, reject) => {
    let settled = false
    let tail = ''

    const child = spawn(command, args, {
      env: { ...process.env, DSH_HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A new process group lets the pool kill dsh and everything it spawned,
      // rather than orphaning child processes when a user is reaped.
      detached: process.platform !== 'win32',
    })

    /** Keep only the most recent output; the banner is printed once. */
    const absorb = (chunk) => {
      tail = (tail + chunk.toString()).slice(-LOG_TAIL_BYTES)
      if (settled) return
      const banner = parseDshBanner(tail)
      if (banner === undefined) return
      settled = true
      clearTimeout(timer)
      resolve({
        child,
        port: banner.port,
        token: banner.token,
        url: banner.url,
        home,
        startedAt: Date.now(),
      })
    }

    const fail = (message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already gone */ }
      reject(new Error(`${message}\n--- dsh output ---\n${tail.trim()}`))
    }

    const timer = setTimeout(() => {
      fail(`dsh did not print its startup banner within ${String(timeoutMs)}ms`)
    }, timeoutMs)

    child.stdout.on('data', absorb)
    child.stderr.on('data', absorb)
    child.on('error', (error) => fail(`could not start dsh: ${error.message}`))
    // A child's stdio pipe is a Socket, and when the other end goes away abruptly
    // — `stopDsh` kills the tree with taskkill, a user is reaped, an account is
    // deleted — the read end can reset. An unhandled 'error' there is fatal in
    // Node and took the whole gateway down silently (observed as
    // `Error: read ECONNRESET` right after a restart); the `exit` hook below is
    // what reports a real failure, so a broken pipe only needs to be ignored.
    const ignorePipeError = () => { /* reported by the exit hook if it matters */ }
    child.stdout.on('error', ignorePipeError)
    child.stderr.on('error', ignorePipeError)
    child.on('exit', (code, signal) => {
      fail(`dsh exited before it was ready (code ${String(code)}, signal ${String(signal)})`)
    })

    log.log(`dsh: starting ${command} ${args.join(' ')} (DSH_HOME=${home})`)
  })
}

/**
 * Stop a dsh instance and everything in its process group.
 * @param child - the child process returned by {@link launchDsh}.
 */
export function stopDsh(child) {
  if (child === undefined || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      // dsh spawns helpers; killing the tree avoids leaving them behind.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, 'SIGTERM')
    }
  } catch {
    try { child.kill() } catch { /* already gone */ }
  }
}
