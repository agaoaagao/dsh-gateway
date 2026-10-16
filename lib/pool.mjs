/**
 * The per-user dsh process pool.
 *
 * One dsh per user is the only way to isolate identities (see `homes.mjs`), so
 * the gateway must own a process lifecycle: lazy start, reuse, an instance cap,
 * idle reaping, and restart after a crash. Everything here exists to keep those
 * five promises without ever handing two users the same process.
 *
 * A pool instance is keyed by the *account name*, never by anything the client
 * supplies, so a session can only ever reach the instance its own sign-in
 * created.
 */

import { ensureUserHome, userHomePath } from './homes.mjs'
import { launchDsh, stopDsh } from './dsh.mjs'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Quote a value as a YAML scalar.
 *
 * Single-quoted scalars are literal — backslashes need no escaping, which
 * matters because a Windows home path is full of them — and a single quote
 * inside is escaped by doubling it.
 * @param value - the string to quote.
 * @returns the quoted scalar.
 */
function yamlScalar(value) {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * The per-instance overlay: this dsh's own port, and its own default workspace.
 *
 * Two problems, one mechanism.
 *
 * The profile's own patch list can pin `webserver.port` (the remote-web-ui
 * lan-bind toggle writes exactly that), and the patch layer beats the CLI flag —
 * so without this overlay every user's dsh would try to bind the same port and
 * only the first would start. An overlay applied after the profile layer wins,
 * and `port: 0` asks the OS for a free port; dsh prints the port it actually got
 * in its startup banner, which is what the pool reads. `host` is pinned too:
 * behind the gateway dsh must stay on loopback, whatever the shared profile was
 * configured to do.
 *
 * The second row fixes first-use workspace creation. Left alone, dsh asks the OS
 * for the system Documents directory and creates
 * `<Documents>/deepseek-harness/default-workspace` inside it. For a multi-user
 * gateway that is wrong twice over: the directory is per-MACHINE, so every
 * account on one host would open the very same folder and share files across
 * users; and on a slim Linux image there is no `xdg-user-dir`, so the lookup
 * fails and the user is told to pick a folder by hand. Pinning
 * `workspace-controller.documentsDirectory` inside this user's own home makes
 * the default workspace private and deterministic on every platform.
 *
 * @param home - the user's `DSH_HOME`.
 * @returns the overlay's YAML text.
 */
function instancePatch(home) {
  const documents = yamlScalar(join(home, 'workspace'))
  return `# Written by dsh-gateway for one user's dsh process — do not edit.
# Applied after the profile layer so this instance gets its own port, stays on
# loopback where the gateway can reach it, and keeps its default workspace
# inside this user's own home.
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '127.0.0.1'
    port: 0
- id: workspace-controller
  config:
    documentsDirectory: ${documents}
`
}

/**
 * Write (or refresh) the per-user overlay and return its path.
 * @param home - the user's `DSH_HOME`.
 * @returns the overlay path.
 */
function writeInstancePatch(home) {
  const path = join(home, 'gateway-instance.yml')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, instancePatch(home))
  // Older gateways wrote the same overlay as `gateway-webserver.yml`, before it
  // also carried the workspace row. It is no longer passed to dsh, but a stale
  // copy would sit in the user's home forever, so clear it out.
  rmSync(join(home, 'gateway-webserver.yml'), { force: true })
  return path
}

/**
 * Read resident memory and CPU time for a process.
 *
 * Linux only: `/proc` is the honest source and the Docker deployment is Linux.
 * Elsewhere the admin panel reports the process as running without numbers,
 * rather than inventing them.
 * @param pid - process id.
 * @returns `{ rssKb, cpuSeconds }`, or undefined.
 */
export function readProcStats(pid) {
  if (process.platform !== 'linux') return undefined
  try {
    const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8')
    const rss = /VmRSS:\s*(\d+)\s*kB/.exec(status)
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    // Field 14 is utime in clock ticks; `comm` may contain spaces, so cut at `)`.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(fields[11]) + Number(fields[12])
    return {
      rssKb: rss === null ? 0 : Number(rss[1]),
      cpuSeconds: Number.isFinite(ticks) ? Math.round(ticks / 100) : 0,
    }
  } catch {
    return undefined
  }
}

/** One running dsh, and the bookkeeping the pool needs to manage it. */
export class Instance {
  /**
   * @param options - the launched process plus its identity.
   */
  constructor({ user, home, child, port, token, url }) {
    this.user = user
    this.home = home
    this.child = child
    this.port = port
    this.token = token
    this.url = url
    this.origin = { hostname: '127.0.0.1', port }
    this.startedAt = Date.now()
    this.lastUsed = Date.now()
    this.requests = 0
    this.crashes = 0
  }

  /** Whether the process is still running. @returns true when alive. */
  get alive() {
    return this.child !== undefined && this.child.exitCode === null
  }

  /** Record use, so idle reaping measures the right thing. */
  touch() {
    this.lastUsed = Date.now()
    this.requests += 1
  }

  /** Idle time in milliseconds. @returns milliseconds since last use. */
  get idleMs() {
    return Date.now() - this.lastUsed
  }
}

/**
 * The pool.
 */
export class DshPool {
  /**
   * @param options - launch configuration and limits.
   * @param options.command - executable to run (`node`, or `dsh`).
   * @param options.prefix - arguments before app flags (the dsh `bin.js`).
   * @param options.profile - profile name.
   * @param options.homeRoot - where per-user homes live.
   * @param options.template - `DSH_HOME` to seed each user's home from.
   * @param options.trustedHosts - authorities dsh should accept.
   * @param options.env - extra environment for dsh.
   * @param options.maxInstances - hard cap on concurrent dsh processes.
   * @param options.idleMs - reap an instance after this much inactivity.
   * @param options.log - logger.
   */
  constructor({
    command,
    prefix = [],
    profile = 'web',
    homeRoot,
    template,
    trustedHosts = [],
    env = {},
    maxInstances = 8,
    idleMs = 30 * 60 * 1000,
    log = console,
  }) {
    this.command = command
    this.prefix = prefix
    this.profile = profile
    this.homeRoot = homeRoot
    this.template = template
    this.trustedHosts = trustedHosts
    // Authorities learned from live traffic. dsh fixes its trust list at spawn
    // time and the gateway cannot know in advance which name a reverse proxy or
    // a phone will use, so a refused authority is granted and the user's dsh is
    // restarted once — see `grantHost`.
    this.extraTrustedHosts = new Map()
    this.env = env
    this.maxInstances = maxInstances
    this.idleMs = idleMs
    this.log = log
    /** @type {Map<string, Instance>} */
    this.instances = new Map()
    /** @type {Map<string, Promise<Instance>>} */
    this.pending = new Map()
    /** Crash counters, kept across restarts so the admin panel can show churn. */
    this.crashes = new Map()
    this.reaper = setInterval(() => this.reap(), Math.max(5000, Math.min(60_000, Math.floor(idleMs / 4))))
    this.reaper.unref()
  }

  /**
   * Get the running instance for a user, starting one if needed.
   *
   * Concurrent requests from the same user must not race into two dsh
   * processes, so an in-flight start is stored and shared.
   * @param user - the signed-in account name.
   * @returns the live instance.
   */
  async acquire(user) {
    const existing = this.instances.get(user)
    if (existing !== undefined && existing.alive) {
      existing.touch()
      return existing
    }
    if (existing !== undefined) {
      // The process died under us; count it and fall through to a restart.
      this.instances.delete(user)
      this.log.error(`dsh: instance for ${user} is gone; restarting`)
    }
    const inFlight = this.pending.get(user)
    if (inFlight !== undefined) return await inFlight

    const start = this.#start(user).finally(() => this.pending.delete(user))
    this.pending.set(user, start)
    return await start
  }

  /**
   * Start one instance, enforcing the cap first.
   * @param user - the account name.
   * @returns the new instance.
   */
  async #start(user) {
    this.#makeRoom()
    const home = ensureUserHome({
      root: this.homeRoot,
      user,
      template: this.template,
      log: this.log,
    })
    const launched = await launchDsh({
      command: this.command,
      prefix: this.prefix,
      profile: this.profile,
      patches: [writeInstancePatch(home)],
      home,
      trustedHosts: [...this.trustedHosts, ...(this.extraTrustedHosts.get(user) ?? [])],
      env: this.env,
      log: this.log,
    })
    const instance = new Instance({ user, home, ...launched })
    instance.crashes = this.crashes.get(user) ?? 0
    this.instances.set(user, instance)
    launched.child.on('exit', (code) => {
      this.log.error(`dsh: ${user} exited (code ${String(code)}); the next request restarts it`)
      if (this.instances.get(user) === instance) this.instances.delete(user)
      this.crashes.set(user, (this.crashes.get(user) ?? 0) + 1)
    })
    this.log.log(`dsh: ${user} listening on 127.0.0.1:${String(instance.port)} (pid ${String(launched.child.pid)})`)
    return instance
  }

  /**
   * Stop the instance for a user.
   * @param user - the account name.
   * @param reason - why it is being stopped, for the log.
   * @returns true when something was stopped.
   */
  stop(user, reason = 'requested') {
    const instance = this.instances.get(user)
    if (instance === undefined) return false
    this.instances.delete(user)
    stopDsh(instance.child)
    this.log.log(`dsh: stopped ${user} (${reason})`)
    return true
  }

  /** Stop every instance for an account, e.g. after deletion or disable. */
  stopAll(reason = 'shutdown') {
    for (const user of [...this.instances.keys()]) this.stop(user, reason)
  }

  /**
   * Grant one account's dsh a newly seen request authority.
   *
   * dsh's browser-trust fence fixes its list of accepted authorities when the
   * process starts, so a name it has not seen is answered with 403 and every
   * API call on an otherwise working page fails. Rather than make the operator
   * enumerate every hostname up front, the caller reports the refused authority
   * and the account's dsh is stopped so the next acquire starts with it added.
   *
   * @param user - the account name.
   * @param host - a port-less hostname (`home.example.com`).
   * @returns true when this is a new grant, false when it was already known.
   */
  grantHost(user, host) {
    if (host === undefined || host === '') return false
    const known = this.extraTrustedHosts.get(user) ?? new Set()
    if (known.has(host) || this.trustedHosts.includes(host)) return false
    known.add(host)
    this.extraTrustedHosts.set(user, known)
    // The running process cannot learn the new authority, so restart it.
    this.stop(user, `granted host ${host}`)
    return true
  }

  /**
   * Authorities already granted to an account from live traffic.
   * @param user - the account name.
   * @returns a set of hostnames.
   */
  grantedHosts(user) {
    return this.extraTrustedHosts.get(user) ?? new Set()
  }

  /**
   * Kill instances that have been idle longer than the configured limit.
   * @returns the number reaped.
   */
  reap() {
    let reaped = 0
    for (const [user, instance] of this.instances) {
      if (instance.idleMs < this.idleMs) continue
      this.stop(user, `idle for ${String(Math.round(instance.idleMs / 60000))} min`)
      reaped += 1
    }
    return reaped
  }

  /**
   * Enforce the instance cap by evicting the least recently used process.
   *
   * Eviction is not silent: the user's next request restarts their dsh and their
   * sessions are on disk, so the cost is a cold start, not lost data.
   */
  #makeRoom() {
    while (this.instances.size >= this.maxInstances) {
      let oldest
      for (const instance of this.instances.values()) {
        if (oldest === undefined || instance.lastUsed < oldest.lastUsed) oldest = instance
      }
      if (oldest === undefined) return
      this.log.error(`dsh: at the ${String(this.maxInstances)}-instance cap; evicting ${oldest.user}`)
      this.stop(oldest.user, 'instance cap')
    }
  }

  /**
   * A snapshot for the admin panel.
   * @returns one row per running instance.
   */
  status() {
    return [...this.instances.values()].map((instance) => {
      const stats = readProcStats(instance.child?.pid)
      return {
        user: instance.user,
        pid: instance.child?.pid ?? null,
        port: instance.port,
        home: instance.home,
        uptimeSec: Math.round((Date.now() - instance.startedAt) / 1000),
        idleSec: Math.round(instance.idleMs / 1000),
        requests: instance.requests,
        crashes: this.crashes.get(instance.user) ?? 0,
        rssMb: stats === undefined ? null : Math.round(stats.rssKb / 1024),
        cpuSec: stats === undefined ? null : stats.cpuSeconds,
      }
    })
  }

  /**
   * The home path a user would get, whether or not it exists yet.
   * @param user - the account name.
   * @returns the absolute path.
   */
  homeOf(user) {
    return userHomePath(this.homeRoot, user)
  }

  /** Stop the reaper and every instance. */
  shutdown() {
    clearInterval(this.reaper)
    this.stopAll('gateway shutdown')
  }
}
