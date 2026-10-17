#!/usr/bin/env node
/**
 * dsh-gateway — sign in once, and your dsh is yours alone.
 *
 * The problem it solves: dsh's Web GUI is a single-user application. Its session
 * store lives at `$DSH_HOME/sessions` and is keyed by workspace path, not by
 * user, so two people reaching the same dsh process see the same conversations.
 * No plugin can change that, because the store belongs to the process.
 *
 * So identity isolation has to be structural: one dsh process per account, each
 * with its own `DSH_HOME`. This gateway is the front door that makes that
 * invisible — you sign in once, and everything behind that sign-in is yours.
 *
 * Two modes:
 *   --spawn            one dsh process per user (the product)
 *   --target/--token   relay to one already-running dsh (the prototype mode,
 *                      kept because it is the simplest way to develop against)
 *
 * Everything is standard library: no dependencies to audit, nothing to build.
 *
 * Usage:
 *   node gateway.mjs --spawn --listen 8080 --bind 0.0.0.0
 *   node gateway.mjs --listen 8080 --target http://127.0.0.1:3090 --token <token>
 */

import { dirname, join, resolve } from 'node:path'

import { AccountStore, LoginThrottle } from './lib/accounts.mjs'
import { checkTemplate, resolveSharedHome, userHomePath } from './lib/homes.mjs'
import { DshPool } from './lib/pool.mjs'
import { createAdmin } from './lib/admin.mjs'
import { createGateway } from './lib/server.mjs'
import { localAuthorities } from './lib/dsh.mjs'

const USAGE = `dsh-gateway — sign in once, and your dsh is yours alone

Usage
  node gateway.mjs --spawn [options]
  node gateway.mjs --target <url> --token <token> [options]

Core
  --listen <port>          port to serve on                       (default 8080)
  --bind <address>         interface to bind                (default 0.0.0.0)
  --spawn                  run one dsh process per user
  --target <url>           relay to an already-running dsh instead
  --token <token>          that dsh's launch token (never sent to the browser)

Accounts
  --state <file>           gateway session state    (default ./gateway-state.json)
  --accounts <file>        account database     (default <state dir>/accounts.json)
  --admin-password <pw>    initial admin password      (default admin12345)
  --max-failures <n>       failed sign-ins before a lockout           (default 5)
  --lockout-minutes <n>    how long a lockout lasts                   (default 5)

Per-user dsh (--spawn)
  --profile <name>         dsh profile to boot                     (default web)
  --home-root <dir>        where per-user DSH_HOME dirs live
                                               (default <state dir>/users)
  --shared-home <dir>      dsh home an account may be granted, so that account
                           lists this home's sessions
                                               (default $DSH_HOME, else ~/.dsh)
  --template <dir>         optional DSH_HOME to seed each user's home from;
                           omit it and every account starts from the profile
                           dsh ships, with none of the operator's plugins
   --dsh-bin <path>         executable to spawn                    (default dsh)
  --dsh-arg <arg>          argument before dsh's own flags (repeatable)
  --max-instances <n>      hard cap on concurrent dsh processes       (default 8)
  --idle-minutes <n>       stop an idle user's dsh (0 = never)      (default 30)
  --trusted-host <host>    extra authority dsh should accept (repeatable)

Other
  --public-asset <path>    extra unauthenticated path to relay (repeatable)
  --help                   show this text

The gateway enumerates this machine's own addresses and passes them to every dsh
it starts, so LAN and phone access work without hand-written --trusted-host.
`

/** Collect every value given for a repeatable flag, in order. */
function collect(argv, flag) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1])
  }
  return out
}

/** Read one flag's value. */
function value(argv, flag) {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

/** Whether a boolean flag is present. */
const has = (argv, flag) => argv.includes(flag)

/** Parse a non-negative number flag, falling back when absent or invalid. */
function number(argv, flag, fallback) {
  const raw = value(argv, flag)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** Parse a non-negative integer flag, falling back when absent or invalid. */
function integer(argv, flag, fallback) {
  const raw = value(argv, flag)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

async function main() {
  const argv = process.argv.slice(2)
  if (has(argv, '--help') || has(argv, '-h')) {
    process.stdout.write(USAGE)
    return
  }

  const log = console
  // The launcher supervises this process and restarts it, so a crash only has to
  // be *recorded* before it goes. Without this, an exception raised outside a
  // request handler ended the process with nothing written anywhere — the local
  // service simply "went away", and the log stopped mid-sentence.
  process.on('uncaughtException', (error) => {
    log.error(`gateway: uncaught exception: ${error?.stack ?? String(error)}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log.error(`gateway: unhandled rejection: ${reason?.stack ?? String(reason)}`)
    process.exit(1)
  })
  const spawnMode = has(argv, '--spawn')
  const stateFile = resolve(value(argv, '--state') ?? 'gateway-state.json')
  const accountsFile = resolve(value(argv, '--accounts') ?? join(dirname(stateFile), 'accounts.json'))
  const profile = value(argv, '--profile') ?? 'web'

  const accounts = new AccountStore({
    file: accountsFile,
    adminPassword: value(argv, '--admin-password') ?? 'admin12345',
    profile,
    log,
  })

  /**
   * A sign-in throttle keyed per client and per user name. The gateway's form is
   * the only thing an attacker sees, and a shared LAN is an untrusted network in
   * practice, so guessing must cost something.
   */
  const throttle = new LoginThrottle({
    maxFailures: integer(argv, '--max-failures', 5),
    windowMs: integer(argv, '--failure-window-minutes', 15) * 60 * 1000,
    lockMs: integer(argv, '--lockout-minutes', 5) * 60 * 1000,
  })

  let pool
  let target
  let launchToken

  if (spawnMode) {
    const homeRoot = resolve(value(argv, '--home-root') ?? join(dirname(stateFile), 'users'))
    // The home an administrator may grant to an account. It is the operator's own
    // dsh home by default, so a grant shows the sessions that home already holds;
    // it is resolved but never created here, since only a grant needs it.
    const sharedHome = resolveSharedHome(value(argv, '--shared-home'))
    const patchRoot = join(dirname(stateFile), 'instance-patches')
    // No template by default. dsh materialises its own shipped profile the first
    // time an account starts, so a brand-new account cannot inherit the
    // operator's plugins, credentials or saved settings — which is the whole
    // point of per-user homes. Point --template at a DSH_HOME only to hand every
    // account the same pre-installed set on purpose.
    const templateArg = value(argv, '--template')
    const template = templateArg === undefined ? undefined : resolve(templateArg)
    // Only a template the operator actually asked for can be wrong.
    const templateProblem = template === undefined ? undefined : checkTemplate(template, profile)
    if (templateProblem !== undefined) log.error(`gateway: ${templateProblem}`)

    // Every authority this machine answers on, plus anything the operator names.
    // Without this, dsh's browser-trust fence rejects the LAN authority with a
    // bare 403 and the page loads while every API call fails.
    const trustedHosts = [...new Set([...localAuthorities(), ...collect(argv, '--trusted-host')])]

    pool = new DshPool({
      command: value(argv, '--dsh-bin') ?? 'dsh',
      prefix: collect(argv, '--dsh-arg'),
      profile,
      homeRoot,
      sharedHome,
      patchRoot,
      template,
      trustedHosts,
      maxInstances: integer(argv, '--max-instances', 8),
      idleMs: number(argv, '--idle-minutes', 30) * 60 * 1000,
      log,
    })

    log.log('mode: one dsh process per user')
    log.log(`per-user home: ${userHomePath(homeRoot, '<user>')}`)
    log.log(`shared home: ${sharedHome} (grant it per account in the admin console)`)
    log.log(`profile template: ${template ?? `(none; each account gets dsh's shipped profile)`}`)
    log.log(`trusted hosts: ${trustedHosts.join(', ')}`)
  } else {
    target = new URL(value(argv, '--target') ?? 'http://127.0.0.1:3080')
    launchToken = value(argv, '--token') ?? process.env.DSH_LAUNCH_TOKEN
    log.log(`mode: single target ${target.origin}`)
  }

  // The admin API needs to revoke sessions and the gateway owns them, so the
  // handler is built first and handed the gateway once it exists.
  const holder = {}
  const adminHandler = createAdmin({
    accounts,
    pool,
    revokeUser: name => holder.gateway.revokeUser(name),
    log,
  })

  const listenPort = integer(argv, '--listen', 8080)
  const listenHost = value(argv, '--bind') ?? '0.0.0.0'

  const gateway = createGateway({
    listenPort,
    listenHost,
    target,
    launchToken,
    pool,
    accounts,
    throttle,
    stateFile,
    publicAssets: collect(argv, '--public-asset'),
    admin: adminHandler,
    log,
  })
  holder.gateway = gateway

  await gateway.listen()

  const shown = listenHost === '0.0.0.0' ? '<this-host>' : listenHost
  log.log(`sign in at http://${shown}:${String(listenPort)}/`)
  log.log(`admin console: http://${shown}:${String(listenPort)}/__gateway/admin`)

  /** Shut down in order: stop the dsh processes, then stop listening. */
  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    log.log(`gateway: ${signal} received; shutting down`)
    try {
      if (pool !== undefined) pool.shutdown()
      await gateway.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((error) => {
  process.stderr.write(`gateway: fatal: ${error?.stack ?? error}\n`)
  process.exit(1)
})
