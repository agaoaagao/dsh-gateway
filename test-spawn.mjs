#!/usr/bin/env node
/**
 * End-to-end tests for spawn mode: one dsh process per account.
 *
 * `test-gateway.mjs` covers the relay contract in single-target mode. This covers
 * what that mode cannot express: that two accounts can never reach each other's
 * data, because they are not the same process.
 *
 * Asserted, in order:
 *   - each account gets its own dsh process, on its own port, with its own DSH_HOME
 *   - one account's dsh never reports another account's home
 *   - signing in again reuses the running process instead of starting a second
 *   - the instance cap evicts rather than refusing service
 *   - disabling an account stops its dsh and revokes its sessions
 *   - deleting an account does the same
 *   - the last administrator cannot be deleted
 *   - an idle instance is reaped, and `--idle-minutes 0` never reaps
 *   - each instance's default workspace is pinned inside that account's home
 *
 * Run: node test-spawn.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureUserHome } from './lib/homes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATEWAY = join(HERE, 'gateway.mjs')
const FAKE_DSH = join(HERE, 'test-fixtures', 'fake-dsh.mjs')

const PORT = 8091
const ADMIN = { name: 'admin', password: 'admin12345' }
const IDLE_MINUTES = 0.08 // ~4.8 s, so the reaper can be observed

let passed = 0
let failed = 0

/** Record one assertion. */
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    process.stdout.write(`  PASS  ${label}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  }
}

/** A tiny cookie jar, so each identity is genuinely separate. */
class Jar {
  constructor() {
    this.cookies = new Map()
  }

  absorb(response) {
    const raw = response.headers['set-cookie'] ?? []
    for (const single of raw) {
      const pair = single.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

/** One HTTP request that never follows redirects. */
function request({ method = 'GET', path, jar, body, headers = {}, host, port = PORT }) {
  return new Promise((resolve, reject) => {
    const jarHeader = jar === undefined ? '' : jar.header()
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(host === undefined ? {} : { host }),
        ...(jarHeader === '' ? {} : { cookie: jarHeader }),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const response = {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        jar?.absorb(response)
        resolve(response)
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

/** Sign in, returning the jar. */
async function login(name, password) {
  const jar = new Jar()
  const response = await request({
    method: 'POST',
    path: '/__gateway/login',
    jar,
    body: new URLSearchParams({ name, password }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  return { jar, status: response.status }
}

/**
 * Sign in as a browser reaching the gateway through a given authority.
 *
 * The sign-in cookie is namespaced by the authority the browser used, so a
 * session minted for `127.0.0.1` is not what a request carrying
 * `Host: proxy.example.test` presents. Tests that drive a proxied authority have
 * to sign in on it, exactly as a real browser behind that proxy does.
 */
async function loginVia(name, password, host, port = PORT) {
  const jar = new Jar()
  const response = await request({
    method: 'POST',
    path: '/__gateway/login',
    jar,
    port,
    host,
    body: new URLSearchParams({ name, password }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  return { jar, status: response.status }
}

/** The admin API, always read as JSON. */
function admin(jar, method, path, body) {
  return request({
    method,
    path: `/__gateway/admin/api${path}`,
    jar,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  })
}

/** Start the gateway and resolve once it is listening. */
function startGateway(stateFile, homeRoot, template, extraArgs = [], overrides = {}) {
  const args = [
    GATEWAY,
    '--spawn',
    '--listen', String(overrides.listen ?? PORT),
    '--bind', '127.0.0.1',
    '--state', stateFile,
    '--home-root', homeRoot,
    '--template', template,
    '--dsh-bin', process.execPath,
    '--dsh-arg', FAKE_DSH,
    '--max-instances', '3',
    '--idle-minutes', String(overrides.idleMinutes ?? IDLE_MINUTES),
    ...extraArgs,
  ]
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway did not start:\n${output}`)), 15000)
    const absorb = (chunk) => {
      output += chunk.toString()
      if (output.includes('gateway listening')) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout.on('data', absorb)
    child.stderr.on('data', absorb)
    child.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`gateway exited (${String(code)}):\n${output}`))
    })
  })
  return { child, ready, output: () => output }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dshgw-spawn-test-'))
  const homeRoot = join(root, 'users')
  const stateFile = join(root, 'state.json')
  const template = join(root, 'template')
  // `profiles/<name>` must exist: it is copied per user, because dsh saves
  // settings into it.
  mkdirSync(join(template, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(template, 'profiles', 'web', 'cordis.patch.yml'), 'template-only: true\n')
  // A profile's `node_modules` is a pnpm-style layout: nearly every entry is a
  // junction into the installation. The seed must reproduce the link — copying the
  // bytes would drag the whole installation into every user's home and, on
  // Windows, dereferencing a junction fails outright with EPERM.
  const installation = join(root, 'installation', 'zod')
  mkdirSync(installation, { recursive: true })
  writeFileSync(join(installation, 'index.js'), 'module.exports = 1\n')
  mkdirSync(join(template, 'profiles', 'web', 'node_modules'), { recursive: true })
  symlinkSync(installation, join(template, 'profiles', 'web', 'node_modules', 'zod'), 'junction')

  const gateway = startGateway(stateFile, homeRoot, template)
  await gateway.ready

  process.stdout.write('\n== 1. each account gets its own dsh process ==\n')
  const adminLogin = await login(ADMIN.name, ADMIN.password)
  check('administrator signs in', adminLogin.status === 303, `status ${String(adminLogin.status)}`)

  for (const name of ['alice', 'carol', 'dave']) {
    const created = await admin(adminLogin.jar, 'POST', '/users', { name, password: `${name}-password` })
    check(`account ${name} created`, created.status === 201, `${String(created.status)} ${created.body}`)
  }

  const alice = await login('alice', 'alice-password')
  const carol = await login('carol', 'carol-password')
  check('alice signs in', alice.status === 303, `status ${String(alice.status)}`)
  check('carol signs in', carol.status === 303, `status ${String(carol.status)}`)

  const aliceWho = JSON.parse((await request({ path: '/whoami', jar: alice.jar })).body)
  const carolWho = JSON.parse((await request({ path: '/whoami', jar: carol.jar })).body)
  check('alice reaches her own dsh', aliceWho.home.includes('alice'), aliceWho.home)
  check('carol reaches her own dsh', carolWho.home.includes('carol'), carolWho.home)
  check('the two accounts are different processes', aliceWho.pid !== carolWho.pid,
    `both ${String(aliceWho.pid)}`)
  check('the two processes listen on different ports', aliceWho.port !== carolWho.port,
    `both ${String(aliceWho.port)}`)
  check('neither account can see the other home',
    !aliceWho.home.includes('carol') && !carolWho.home.includes('alice'))

  process.stdout.write('\n== 2. signing in again reuses the process ==\n')
  const aliceAgain = await login('alice', 'alice-password')
  const aliceAgainWho = JSON.parse((await request({ path: '/whoami', jar: aliceAgain.jar })).body)
  check('a second sign-in reuses the running dsh', aliceAgainWho.pid === aliceWho.pid,
    `${String(aliceWho.pid)} -> ${String(aliceAgainWho.pid)}`)

  process.stdout.write('\n== 3. the instance cap evicts instead of failing ==\n')
  const dave = await login('dave', 'dave-password')
  check('a fourth account still signs in at the cap', dave.status === 303, `status ${String(dave.status)}`)
  const daveWho = await request({ path: '/whoami', jar: dave.jar })
  check('the evicting account is served', daveWho.status === 200, `status ${String(daveWho.status)}`)
  const stateAfterDave = JSON.parse((await admin(adminLogin.jar, 'GET', '/state')).body)
  check('the cap is respected', stateAfterDave.instances.length <= 3,
    `${String(stateAfterDave.instances.length)} instances`)

  process.stdout.write('\n== 4. disabling an account stops its dsh and revokes its sessions ==\n')
  const disabled = await admin(adminLogin.jar, 'POST', '/users/carol/enabled', { enabled: false })
  check('the administrator can disable an account', disabled.status === 200, disabled.body)
  await sleep(100)
  const carolAfterDisable = await request({ path: '/whoami', jar: carol.jar })
  check('a disabled account is signed out at once', carolAfterDisable.status === 401,
    `status ${String(carolAfterDisable.status)}`)
  const carolRelogin = await login('carol', 'carol-password')
  check('a disabled account cannot sign in', carolRelogin.status === 401,
    `status ${String(carolRelogin.status)}`)
  const stateAfterDisable = JSON.parse((await admin(adminLogin.jar, 'GET', '/state')).body)
  check('the disabled account has no running dsh',
    !stateAfterDisable.instances.some(i => i.user === 'carol'))

  const reenabled = await admin(adminLogin.jar, 'POST', '/users/carol/enabled', { enabled: true })
  check('the administrator can re-enable the account', reenabled.status === 200, reenabled.body)
  const carolBack = await login('carol', 'carol-password')
  check('the re-enabled account signs in again', carolBack.status === 303,
    `status ${String(carolBack.status)}`)

  process.stdout.write('\n== 5. deleting an account ==\n')
  const wrongPassword = await login('dave', 'not-the-password')
  check('a wrong password is refused', wrongPassword.status === 401, `status ${String(wrongPassword.status)}`)
  const deleted = await admin(adminLogin.jar, 'DELETE', '/users/dave')
  check('the administrator can delete an account', deleted.status === 200, deleted.body)
  const daveGone = await login('dave', 'dave-password')
  check('a deleted account cannot sign in', daveGone.status === 401, `status ${String(daveGone.status)}`)
  const lastAdmin = await admin(adminLogin.jar, 'DELETE', '/users/admin')
  check('the last administrator cannot be deleted', lastAdmin.status === 400, lastAdmin.body)

  process.stdout.write('\n== 6. credentials and health ==\n')
  const anonymousState = await admin(new Jar(), 'GET', '/state')
  check('the admin API is refused without an administrator session',
    anonymousState.status === 403, `status ${String(anonymousState.status)}`)
  const health = await request({ path: '/healthz' })
  check('health is available without a session', health.status === 200, `status ${String(health.status)}`)
  check('health reports the live instance count',
    JSON.parse(health.body).instances >= 0)

  process.stdout.write('\n== 7. an idle dsh is reaped ==\n')
  await sleep(Math.ceil(IDLE_MINUTES * 60000 * 2) + 6000)
  const stateAfterIdle = JSON.parse((await admin(adminLogin.jar, 'GET', '/state')).body)
  check('idle instances are stopped', stateAfterIdle.instances.length === 0,
    `${String(stateAfterIdle.instances.length)} still running`)

  process.stdout.write('\n== 8. the default workspace is private to each account ==\n')
  const aliceOverlay = join(homeRoot, 'alice', 'gateway-instance.yml')
  check('the per-instance overlay is written', existsSync(aliceOverlay), aliceOverlay)
  const aliceText = readFileSync(aliceOverlay, 'utf8')
  const aliceDocuments = /documentsDirectory: '(.+)'/u.exec(aliceText)?.[1]
  check('the overlay pins the default workspace inside the account home',
    aliceDocuments === join(homeRoot, 'alice', 'workspace'), String(aliceDocuments))
  check('the workspace is not the machine-wide Documents folder',
    aliceDocuments !== undefined && !aliceDocuments.includes('Documents'),
    String(aliceDocuments))
  check('the overlay still pins this instance to loopback port 0',
    /host: '127\.0\.0\.1'/u.test(aliceText) && /port: 0/u.test(aliceText))
  const carolText = readFileSync(join(homeRoot, 'carol', 'gateway-instance.yml'), 'utf8')
  check('a second account gets a different workspace path',
    /documentsDirectory: '(.+carol.+workspace)'/u.test(carolText)
      && !carolText.includes(`'${join(homeRoot, 'alice', 'workspace')}'`))

  // dsh saves model/provider settings into `profiles/<name>/cordis.patch.yml`
  // *inside DSH_HOME*, so this directory is user data. If it were shared, one
  // account's saved settings would show up for every other account — measured
  // with two real accounts before this was made a private copy.
  process.stdout.write('\n== 8b. saved settings cannot leak between accounts ==\n')
  const alicePatch = join(homeRoot, 'alice', 'profiles', 'web', 'cordis.patch.yml')
  const carolPatch = join(homeRoot, 'carol', 'profiles', 'web', 'cordis.patch.yml')
  check('each account has its own profile tree',
    existsSync(alicePatch) && existsSync(carolPatch),
    `${alicePatch} / ${carolPatch}`)
  check('the profile tree is a real directory, not a link to the template',
    !lstatSync(join(homeRoot, 'alice', 'profiles')).isSymbolicLink(),
    'alice/profiles is still a symlink')
  check('the two accounts do not share one profile document',
    alicePatch !== carolPatch && !lstatSync(alicePatch).isSymbolicLink(),
    'the same file is reachable from both homes')
  writeFileSync(alicePatch, 'alice-only-setting: true\n')
  check('a setting written for one account does not appear for the other',
    !readFileSync(carolPatch, 'utf8').includes('alice-only-setting'),
    'the write leaked into carol')
  check('the template itself is never written to',
    !readFileSync(join(template, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').includes('alice-only-setting'),
    'the template was modified')
  // Reproducing a link is what keeps a ~175 MB pnpm-style `node_modules` out of
  // every user's home — and on Windows it is the difference between a copy and
  // `EPERM: operation not permitted, copyfile`.
  const aliceLinked = join(homeRoot, 'alice', 'profiles', 'web', 'node_modules', 'zod')
  check('a linked package is reproduced as a link, not dereferenced',
    lstatSync(aliceLinked).isSymbolicLink(), `${aliceLinked} is a real directory`)
  check('the reproduced link still resolves into the installation',
    readFileSync(join(aliceLinked, 'index.js'), 'utf8').includes('module.exports'),
    'the reproduced link does not resolve')

  // dsh fixes its list of trusted authorities when it starts, so a name that was
  // not known at spawn time (a reverse proxy, a phone's bookmark) gets a 403 on
  // every API call while the page itself loads. The gateway grants it and
  // restarts that one account's dsh instead of making the operator enumerate
  // every hostname up front.
  process.stdout.write('\n== 8c. a newly seen proxy host is granted automatically ==\n')
  const aliceProxy = await loginVia('alice', 'alice-password', 'proxy.example.test:2020')
  check('a browser behind the proxy can sign in on that authority',
    aliceProxy.status === 303 && aliceProxy.jar.header() !== '',
    `status ${String(aliceProxy.status)} jar ${aliceProxy.jar.header()}`)
  const proxiedBefore = await request({ method: 'GET', path: '/whoami', jar: aliceProxy.jar, host: 'proxy.example.test:2020' })
  check('a request through an unknown hostname is not left refused',
    proxiedBefore.status === 200, `status ${String(proxiedBefore.status)} ${proxiedBefore.body.slice(0, 80)}`)
  const proxyBody = (() => { try { return JSON.parse(proxiedBefore.body) } catch { return {} } })()
  check('the reply comes from the account own dsh home',
    proxyBody.home === join(homeRoot, 'alice'), String(proxyBody.home))
  check('the gateway says it granted the host',
    /did not trust proxy\.example\.test; restarting it once/.test(gateway.output()),
    'no grant line in the gateway log')
  check('the second host on the same account is served without another refusal',
    (await request({ method: 'GET', path: '/whoami', jar: aliceProxy.jar, host: 'proxy.example.test:2020' })).status === 200)
  // `carol.jar` is dead by now on purpose: disabling an account revokes its
  // sessions, so the live one is a fresh sign-in on the authority it uses.
  const carolProxy = await loginVia('carol', 'carol-password', 'carol.example.test:2020')
  const proxiedOther = await request({ method: 'GET', path: '/whoami', jar: carolProxy.jar, host: 'carol.example.test:2020' })
  check('another account is granted its own host independently',
    proxiedOther.status === 200, `status ${String(proxiedOther.status)}`)
  check('no other account is affected by the grant',
    existsSync(join(homeRoot, 'carol')) && !readFileSync(join(homeRoot, 'carol', 'gateway-instance.yml'), 'utf8').includes('proxy.example.test'))

  // With no --template the home is left empty on purpose: dsh materialises the
  // profile it ships on first start, inside that account's own home. This is the
  // shipping default, and it is what keeps a brand-new account from inheriting
  // the operator's plugins, credentials and saved settings.
  process.stdout.write('\n== 8d. no template means dsh supplies the profile ==\n')
  const newcomer = join(homeRoot, 'newcomer')
  ensureUserHome({ root: homeRoot, user: 'newcomer', template: undefined, log: { log() {}, error() {} } })
  check('a home with no template is still created', existsSync(newcomer), newcomer)
  check('nothing is seeded into it, so dsh bootstraps it',
    readdirSync(newcomer).length === 0, readdirSync(newcomer).join(', '))

  // Signing out ends the browser session only: the account's dsh keeps
  // running, because a scheduled task or automation inside it must survive a
  // sign-out. Stopping is the administrator's move, or the user's own restart
  // control. Alice signs in again afterwards and must land on the same process.
  process.stdout.write('\n== 8e. signing out keeps that account\'s dsh running ==\n')
  const aliceBefore = JSON.parse((await request({ path: '/whoami', jar: alice.jar })).body)
  const aliceOut = await request({ method: 'POST', path: '/__gateway/logout', jar: alice.jar })
  check('sign-out redirects to the sign-in page',
    aliceOut.status === 303 && aliceOut.headers.location === '/__gateway/login',
    `${String(aliceOut.status)} -> ${String(aliceOut.headers.location)}`)
  const stateAfterSignOut = JSON.parse((await admin(adminLogin.jar, 'GET', '/state')).body)
  check('the signed-out account\'s dsh is still running',
    stateAfterSignOut.instances.some(i => i.user === 'alice'),
    JSON.stringify(stateAfterSignOut.instances))
  check('the retired session cannot reach that dsh any more',
    (await request({ path: '/whoami', jar: alice.jar })).status === 401)
  const aliceFresh = await login('alice', 'alice-password')
  const aliceFreshWho = JSON.parse((await request({ path: '/whoami', jar: aliceFresh.jar })).body)
  check('signing in again reuses the still-running dsh process',
    aliceFresh.status === 303 && aliceFreshWho.pid === aliceBefore.pid,
    `${String(aliceBefore.pid)} -> ${String(aliceFreshWho.pid)}`)

  // The restart control is the user-visible "recycle my own instance": stop it,
  // and the next request starts a fresh process against the same DSH_HOME.
  process.stdout.write('\n== 8f. the restart control recycles the caller\'s instance ==\n')
  const restarted = await request({ method: 'POST', path: '/__gateway/restart', jar: aliceFresh.jar })
  check('restart answers ok', restarted.status === 200 && restarted.body.includes('"ok"'),
    `status ${String(restarted.status)} body ${restarted.body}`)
  await sleep(100)
  const stateAfterRestart = JSON.parse((await admin(adminLogin.jar, 'GET', '/state')).body)
  check('restart removed the running instance',
    !stateAfterRestart.instances.some(i => i.user === 'alice'),
    JSON.stringify(stateAfterRestart.instances))
  const aliceAfterRestart = JSON.parse((await request({ path: '/whoami', jar: aliceFresh.jar })).body)
  check('the next request starts a fresh dsh process',
    aliceAfterRestart.pid !== aliceBefore.pid,
    `${String(aliceBefore.pid)} -> ${String(aliceAfterRestart.pid)}`)

  process.stdout.write('\n== 9. account security: hashed storage, restart, lockout ==\n')
  const accountsFile = join(root, 'accounts.json')
  check('the account database is a real file', existsSync(accountsFile), accountsFile)
  const accountsText = existsSync(accountsFile) ? readFileSync(accountsFile, 'utf8') : ''
  check('passwords are stored as scrypt digests', accountsText.includes('scrypt$'))
  check('no password is readable in the account database',
    !accountsText.includes(ADMIN.password) && !accountsText.includes('alice-password'))

  // Accounts live on disk, so they must outlive the process that made them.
  gateway.child.kill()
  await sleep(500)
  const gateway2 = startGateway(stateFile, homeRoot, template, ['--max-failures', '2'])
  await gateway2.ready
  const aliceRestarted = await login('alice', 'alice-password')
  check('an account still signs in after the gateway restarts',
    aliceRestarted.status === 303, `status ${String(aliceRestarted.status)}`)
  const adminRestarted = await login(ADMIN.name, ADMIN.password)
  check('the administrator still signs in after the gateway restarts',
    adminRestarted.status === 303, `status ${String(adminRestarted.status)}`)

  // Order matters: a successful sign-in clears the throttle, so the guessing
  // has to come last. Every key is per client address, which is what makes
  // brute force cost something on a shared LAN.
  const guess1 = await login('eve', 'wrong-password')
  check('an unknown account is refused', guess1.status === 401, `status ${String(guess1.status)}`)
  const guess2 = await login('eve', 'wrong-password')
  check('a repeated guess is still refused', guess2.status === 401, `status ${String(guess2.status)}`)
  const guess3 = await login('eve', 'wrong-password')
  check('guessing past the limit is locked out', guess3.status === 429,
    `status ${String(guess3.status)}`)
  const lockedOther = await login('alice', 'alice-password')
  check('the lockout also covers other account names from the same client',
    lockedOther.status === 429, `status ${String(lockedOther.status)}`)

  // `--idle-minutes 0` is the documented "never reap": an appliance that must
  // not interrupt anything keeps every account's dsh alive however quiet it is.
  // The reaper still ticks (every 5 s at this setting), so one full idle window
  // passes inside the sleep below — the old comparison would have stopped the
  // instance on its very first tick.
  process.stdout.write('\n== 9b. --idle-minutes 0 never reaps ==\n')
  const idlePort = 8093
  const idleAuthority = `127.0.0.1:${String(idlePort)}`
  const gatewayIdleOff = startGateway(join(root, 'state-idle-off.json'), homeRoot, template, [],
    { listen: idlePort, idleMinutes: 0 })
  await gatewayIdleOff.ready
  await sleep(300) // the mode banner lands in the log just after the listening line
  check('the startup log says reaping is off',
    gatewayIdleOff.output().includes('idle reap off'),
    gatewayIdleOff.output().split('\n').find(line => line.includes('idle reap')) ?? '')
  const idleAdmin = await loginVia(ADMIN.name, ADMIN.password, idleAuthority, idlePort)
  const idleBase = { port: idlePort, host: idleAuthority }
  const keeperMade = await request({
    method: 'POST',
    path: '/__gateway/admin/api/users',
    jar: idleAdmin.jar,
    body: JSON.stringify({ name: 'keeper', password: 'keeper-password' }),
    headers: { 'content-type': 'application/json' },
    ...idleBase,
  })
  check('an account is created on the never-reap gateway',
    keeperMade.status === 201, `${String(keeperMade.status)} ${keeperMade.body}`)
  const keeper = await loginVia('keeper', 'keeper-password', idleAuthority, idlePort)
  check('the keeper signs in on the never-reap gateway', keeper.status === 303, `status ${String(keeper.status)}`)
  const keeperFirst = JSON.parse((await request({ path: '/whoami', jar: keeper.jar, ...idleBase })).body)
  await sleep(12000)
  const keeperSecond = JSON.parse((await request({ path: '/whoami', jar: keeper.jar, ...idleBase })).body)
  check('an idle instance outlives the reap window', keeperSecond.pid === keeperFirst.pid,
    `${String(keeperFirst.pid)} -> ${String(keeperSecond.pid)}`)
  gatewayIdleOff.child.kill()

  process.stdout.write(`\n${passed}/${passed + failed} checks passed\n`)
  gateway2.child.kill()
  await sleep(200)
  rmSync(root, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`spawn test crashed: ${error?.stack ?? error}\n`)
  process.exit(1)
})
