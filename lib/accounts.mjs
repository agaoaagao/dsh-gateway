/**
 * The gateway's account store and sign-in throttle.
 *
 * Two things live here that the prototype deliberately skipped:
 *
 *   - Passwords are stored as scrypt digests, never as text. A gateway holds
 *     the only door to every user's dsh, so a readable account file would be a
 *     readable master key.
 *   - Failed sign-ins are counted. Without a counter the sign-in page is an
 *     unlimited guessing oracle, which matters much more once the gateway is
 *     reachable from a whole LAN rather than from localhost.
 *
 * The store is a single JSON document written atomically. It is small (a few
 * hundred bytes per user) and read once at startup, so a database would add an
 * operational dependency without adding a capability.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'

/** scrypt cost parameters. N=2^14 is the common interactive-login setting. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

/**
 * Derive a self-describing password digest.
 * @param password - the plaintext password.
 * @returns `scrypt$N$r$p$salt$key`, safe to store and to print.
 */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64url'), key.toString('base64url')].join('$')
}

/**
 * Check a password against a stored digest in constant time.
 * @param password - the presented password.
 * @param encoded - the stored digest.
 * @returns whether the password matches.
 */
export function verifyPassword(password, encoded) {
  try {
    const [scheme, n, r, p, salt, key] = String(encoded).split('$')
    if (scheme !== 'scrypt') return false
    const expected = Buffer.from(key, 'base64url')
    const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** User names become directory names, so they must not escape the home root. */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/**
 * Validate a user name.
 * @param name - candidate name.
 * @returns true when the name is safe to use as a directory name and cookie key.
 */
export function validName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name) && !name.includes('..')
}

/**
 * The account table.
 *
 * Records are `{ name, hash, admin, enabled, profile, sharedHome, createdAt }`.
 * `sharedHome` is an administrator's explicit grant: that account's dsh runs on
 * the deployment's shared dsh home instead of its own, so it lists the sessions
 * stored there. The hash is never returned by {@link AccountStore.list}, so the
 * admin API cannot leak it.
 */
export class AccountStore {
  /**
   * @param options - file path and the bootstrap password for the first admin.
   * @param options.file - JSON file to persist to.
   * @param options.adminPassword - password for the seeded `admin` account.
   * @param options.profile - default dsh profile for new accounts.
   * @param options.log - logger.
   */
  constructor({ file, adminPassword = 'admin12345', profile = 'web', log = console }) {
    this.file = file
    this.profile = profile
    this.log = log
    /** @type {Map<string, object>} */
    this.users = new Map()
    this.#load(adminPassword)
  }

  /** Read the store, seeding the first administrator when the file is absent. */
  #load(adminPassword) {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        for (const record of Object.values(raw?.users ?? {})) {
          if (validName(record?.name) && typeof record.hash === 'string') {
            this.users.set(record.name, {
              name: record.name,
              hash: record.hash,
              admin: record.admin === true,
              enabled: record.enabled !== false,
              profile: typeof record.profile === 'string' ? record.profile : this.profile,
              sharedHome: record.sharedHome === true,
              createdAt: Number(record.createdAt) || Date.now(),
            })
          }
        }
        this.log.log(`accounts loaded: ${String(this.users.size)}`)
        return
      } catch (error) {
        this.log.error(`gateway: ignoring unreadable account store (${error.message})`)
      }
    }
    this.users.set('admin', {
      name: 'admin',
      hash: hashPassword(adminPassword),
      admin: true,
      enabled: true,
      profile: this.profile,
      sharedHome: false,
      createdAt: Date.now(),
    })
    this.#save()
    this.log.log('accounts seeded: admin (change this password)')
  }

  /** Persist atomically so a crash mid-write cannot corrupt the table. */
  #save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const payload = {
        version: 1,
        users: Object.fromEntries(this.users),
      }
      const temp = `${this.file}.tmp-${String(process.pid)}`
      writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
      renameSync(temp, this.file)
    } catch (error) {
      this.log.error(`gateway: failed to persist accounts (${error.message})`)
    }
  }

  /**
   * Look up a record.
   * @param name - user name.
   * @returns the record, or undefined.
   */
  get(name) {
    return this.users.get(name)
  }

  /**
   * The table without secrets, for the admin API.
   * @returns array of public projections, sorted by name.
   */
  list() {
    return [...this.users.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(u => ({
        name: u.name,
        admin: u.admin,
        enabled: u.enabled,
        profile: u.profile,
        sharedHome: u.sharedHome,
        createdAt: u.createdAt,
      }))
  }

  /**
   * Create an account.
   * @param options - name, password, admin flag, profile, shared-home grant.
   * @returns the created record, or an error string.
   */
  create({ name, password, admin = false, profile, sharedHome = false }) {
    if (!validName(name)) return { error: 'invalid user name' }
    if (typeof password !== 'string' || password.length < 8) {
      return { error: 'password must be at least 8 characters' }
    }
    if (this.users.has(name)) return { error: 'user already exists' }
    const record = {
      name,
      hash: hashPassword(password),
      admin: admin === true,
      enabled: true,
      profile: typeof profile === 'string' && profile.length > 0 ? profile : this.profile,
      sharedHome: sharedHome === true,
      createdAt: Date.now(),
    }
    this.users.set(name, record)
    this.#save()
    return { user: record }
  }

  /**
   * Delete an account.
   * @param name - user name.
   * @param options - guard against removing the last administrator.
   * @returns true when a row was removed.
   */
  remove(name, { allowLastAdmin = false } = {}) {
    const record = this.users.get(name)
    if (record === undefined) return false
    if (record.admin && !allowLastAdmin && this.#adminCount() <= 1) return false
    this.users.delete(name)
    this.#save()
    return true
  }

  /** Count enabled administrators. @returns the count. */
  #adminCount() {
    return [...this.users.values()].filter(u => u.admin).length
  }

  /**
   * Enable or disable an account without deleting it.
   * @param name - user name.
   * @param enabled - desired state.
   * @returns the new state, or undefined when the user is unknown.
   */
  setEnabled(name, enabled) {
    const record = this.users.get(name)
    if (record === undefined) return undefined
    record.enabled = enabled === true
    this.#save()
    return record.enabled
  }

  /**
   * Grant or revoke the shared dsh home for an account.
   *
   * The grant only changes which home the account's dsh is started with; the
   * caller must stop a running instance so the next start uses the new choice.
   * @param name - user name.
   * @param sharedHome - true to grant the shared home, false to revoke it.
   * @returns the new state, or undefined when the user is unknown.
   */
  setSharedHome(name, sharedHome) {
    const record = this.users.get(name)
    if (record === undefined) return undefined
    record.sharedHome = sharedHome === true
    this.#save()
    return record.sharedHome
  }

  /**
   * Set a new password, also revoking nothing else about the account.
   * @param name - user name.
   * @param password - the new password.
   * @returns true on success.
   */
  setPassword(name, password) {
    const record = this.users.get(name)
    if (record === undefined) return false
    if (typeof password !== 'string' || password.length < 8) return false
    record.hash = hashPassword(password)
    this.#save()
    return true
  }

  /**
   * Verify a sign-in.
   *
   * A disabled account and a wrong password are reported identically on purpose:
   * the sign-in page must not tell an attacker which user names exist.
   * @param name - presented user name.
   * @param password - presented password.
   * @returns whether the sign-in is accepted.
   */
  authenticate(name, password) {
    const record = this.users.get(name)
    if (record === undefined) {
      // Spend comparable time on an unknown user so timing does not enumerate.
      verifyPassword(password, hashPassword('placeholder-password'))
      return false
    }
    if (!record.enabled) return false
    return verifyPassword(password, record.hash)
  }
}

/**
 * A small fixed-window failure counter.
 *
 * Keyed per client address and per user name, because the two attacks differ:
 * guessing many names from one address is stopped by the address bucket, and
 * grinding one name from many addresses is stopped by the name bucket.
 */
export class LoginThrottle {
  /**
   * @param options - thresholds.
   * @param options.maxFailures - failures allowed inside the window.
   * @param options.windowMs - window length.
   * @param options.lockMs - how long a tripped bucket stays locked.
   */
  constructor({ maxFailures = 5, windowMs = 15 * 60 * 1000, lockMs = 5 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures
    this.windowMs = windowMs
    this.lockMs = lockMs
    /** @type {Map<string, { failures: number, first: number, lockedUntil: number }>} */
    this.buckets = new Map()
  }

  /** Drop buckets that have expired, so the map cannot grow without bound. */
  #sweep(now) {
    for (const [key, bucket] of this.buckets) {
      const expired = bucket.lockedUntil <= now && now - bucket.first > this.windowMs
      if (expired) this.buckets.delete(key)
    }
  }

  /**
   * Whether this key is currently locked.
   * @param key - bucket key.
   * @returns false, or the seconds remaining.
   */
  retryAfter(key) {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return 0
    const remaining = bucket.lockedUntil - Date.now()
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0
  }

  /**
   * Record a failed attempt, locking the bucket once the threshold is crossed.
   * @param key - bucket key.
   */
  fail(key) {
    const now = Date.now()
    this.#sweep(now)
    const bucket = this.buckets.get(key) ?? { failures: 0, first: now, lockedUntil: 0 }
    if (now - bucket.first > this.windowMs) {
      bucket.failures = 0
      bucket.first = now
    }
    bucket.failures += 1
    if (bucket.failures >= this.maxFailures) bucket.lockedUntil = now + this.lockMs
    this.buckets.set(key, bucket)
  }

  /**
   * Clear a bucket after a successful sign-in.
   * @param key - bucket key.
   */
  succeed(key) {
    this.buckets.delete(key)
  }
}
