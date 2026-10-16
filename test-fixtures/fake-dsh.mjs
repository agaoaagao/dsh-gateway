#!/usr/bin/env node
/**
 * A stand-in for `dsh web`, for the pool's automated tests.
 *
 * The pool's contract is about process lifecycle and identity binding, not about
 * anything dsh computes. A real dsh takes seconds to boot and drags in a whole
 * profile, which would make the spawn tests slow and flaky, so this fixture keeps
 * only the four behaviours the pool actually depends on:
 *
 *   1. It prints the same `dsh web: http://<host>:<port>/?token=<token>` banner,
 *      on an OS-assigned port, so the pool's banner parsing is exercised for real.
 *   2. Its session cookie is bound to the request authority, exactly as dsh's is
 *      (the cookie NAME is a hash of the Host), so a relayed request with the
 *      wrong authority is rejected rather than silently accepted.
 *   3. `/whoami` reports the `DSH_HOME` it was started with, which is how the
 *      tests observe that each account got its own process.
 *   4. It exits when its parent closes its stdio, so a reaped instance leaves
 *      nothing behind.
 *   5. Its browser-trust fence mirrors dsh's: an authority that is neither
 *      loopback nor declared with `--trusted-host` is refused with 403
 *      `forbidden`. This is what lets the tests cover the gateway granting a
 *      newly seen reverse-proxy hostname without an operator action.
 *
 * Other dsh CLI arguments are accepted and ignored.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const home = process.env.DSH_HOME ?? '(unset)'
const token = `tok-${randomBytes(8).toString('hex')}`
const startedAt = Date.now()

/** Mirrors dsh: `--trusted-host` is repeatable and a port-less entry matches any port. */
const trustedHosts = []
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--trusted-host' && process.argv[i + 1] !== undefined) {
    trustedHosts.push(process.argv[i + 1])
  }
}

/** Mirrors dsh: loopback is always accepted, and a port-less entry matches any port. */
function isTrusted(authority) {
  if (authority === undefined) return false
  let hostname
  try {
    hostname = new URL(`http://${authority}`).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' ||
      /^127\./.test(hostname)) return true
  return trustedHosts.includes(hostname) || trustedHosts.includes(authority)
}

/** Mirrors dsh: the cookie name is a hash of the authority it was issued for. */
const cookieNameFor = authority =>
  `dsh-auth-${createHash('sha256').update(authority ?? '').digest('hex').slice(0, 8)}`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://placeholder')
  const authority = req.headers.host
  const required = cookieNameFor(authority)
  const presented = String(req.headers.cookie ?? '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('dsh-auth-'))

  // The launch-token exchange. `ctx.connection` accepts the token only here.
  if (url.pathname === '/' && url.searchParams.get('token') === token) {
    res.writeHead(303, {
      'set-cookie': `${required}=gen1; Path=/; HttpOnly; SameSite=Strict`,
      location: '/',
    })
    res.end()
    return
  }

  // The browser-trust fence, before the cookie check: dsh answers 403 for an
  // authority it was not told to accept, and that happens before authentication.
  if (!isTrusted(authority)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden')
    return
  }

  if (presented === undefined || !presented.startsWith(`${required}=`)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"unauthorized"}')
    return
  }

  // The identity probe the pool tests read.
  if (url.pathname === '/whoami') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ home, pid: process.pid, port: server.address().port, startedAt }))
    return
  }

  if (url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, home }))
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  // The exact banner shape the pool parses.
  process.stdout.write(`dsh web: http://127.0.0.1:${String(port)}/?token=${token}\n`)
})

// A reaped instance must not linger.
process.on('SIGTERM', () => process.exit(0))
process.on('stdin', () => {})
process.stdin?.resume()
