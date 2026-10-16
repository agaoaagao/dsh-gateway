/**
 * Per-user `DSH_HOME` materialisation — the mechanism behind identity isolation.
 *
 * dsh stores conversations in `dshHomePath('sessions')`, which is
 * `$DSH_HOME/sessions` (see `dsh-base/cordis.patch.yml`), and it namespaces that
 * directory by *workspace path*, not by user. Two accounts sharing one
 * `DSH_HOME` therefore share one session store: that was measured directly (two
 * different logins listed the same 43 sessions), and it is why a plugin cannot
 * isolate users no matter how well it authenticates them.
 *
 * The only honest fix is one dsh process per user, each with its own `DSH_HOME`.
 * Doing that naively costs a full profile copy per user (~174 MB of
 * `node_modules` here), which is wasteful and slow. So each user's home is built
 * as a *view* of a template home:
 *
 *   - Installation directories such as `dsh-runtimes/` and `llm-deepseek/` are
 *     shared by symlink (a junction on Windows, so no elevation is needed).
 *     These are code and installation state, not user data.
 *   - Root-level files such as `settings.yaml` are copied, so the deployment can
 *     ship shared configuration without every process writing the same file.
 *   - `profiles/` is a real, private copy per user. This one is not a
 *     performance choice: dsh persists the model and provider settings a user
 *     saves into `profiles/<name>/cordis.patch.yml`, so a shared profile
 *     directory would put every user's saved settings — including provider
 *     references — into one file. Measured directly: two accounts configured
 *     through the gateway wrote their `agent-default-model` into the same
 *     patch, and both then read each other's value.
 *   - Anything private — `sessions/`, `storages/`, `task-board/`, `logs/`,
 *     `attachments/`, `.credentials.yaml` — is deliberately NOT created here.
 *     dsh creates each one fresh inside the user's own home, which is exactly
 *     the isolation this gateway exists to provide.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Entries that must never be shared and must never be seeded.
 *
 * They are absent from a fresh home on purpose: dsh creates them, so they are
 * private by construction rather than by permission.
 */
const PRIVATE_ENTRIES = new Set([
  'sessions',
  'storages',
  'task-board',
  'dsh-usage',
  'logs',
  'attachments',
  'cache',
  '.credentials.yaml',
  '.anonymous-user-id',
  '.dsh-home.lock',
  'user-auth.sqlite',
  'remote-web-ui-devices.json',
])

/** The per-user profile directory: a real copy, never a link. */
const PROFILE_ENTRY = 'profiles'

/**
 * Resolve the home directory for one user, refusing anything that could escape
 * the root.
 * @param root - the configured home root.
 * @param user - the validated account name.
 * @returns the absolute per-user home path.
 */
export function userHomePath(root, user) {
  const base = resolve(root)
  const home = resolve(join(base, user))
  if (home !== join(base, user) && !home.startsWith(`${base}\\`) && !home.startsWith(`${base}/`)) {
    throw new Error(`refusing to build a home outside the root: ${user}`)
  }
  return home
}

/**
 * Create a symlink that works without elevation on Windows.
 * @param target - absolute directory to point at.
 * @param link - the link to create.
 */
function linkDirectory(target, link) {
  symlinkSync(target, link, 'junction')
}

/**
 * Materialise one user's `DSH_HOME`.
 *
 * Idempotent: existing entries are left alone, so a restart never disturbs a
 * running user's state.
 *
 * @param options - root, user, and template.
 * @param options.root - directory holding every user's home.
 * @param options.user - validated account name.
 * @param options.template - an existing `DSH_HOME` to share from (optional).
 * @param options.log - logger.
 * @returns the user's home path.
 */
export function ensureUserHome({ root, user, template, log = console }) {
  const home = userHomePath(root, user)
  mkdirSync(home, { recursive: true })

  // No template configured is the normal case: dsh materialises its own shipped
  // profile inside this home on first start, which is what keeps a new account
  // free of the operator's plugins and credentials.
  if (template === undefined || !existsSync(template)) {
    log.log(`home: ${home} (no template; dsh will bootstrap it)`)
    return home
  }

  const source = resolve(template)
  if (source === resolve(home)) return home

  for (const entry of readdirSync(source)) {
    if (PRIVATE_ENTRIES.has(entry)) continue
    const from = join(source, entry)
    const to = join(home, entry)
    if (entry === PROFILE_ENTRY) {
      seedPrivateProfiles(from, to, log)
      continue
    }
    // Already present; never overwrite anything the user's dsh has written.
    if (existsSync(to)) continue
    try {
      const stat = lstatSync(from)
      if (stat.isDirectory()) linkDirectory(from, to)
      else if (stat.isFile()) copyFileSync(from, to)
    } catch (error) {
      log.error(`gateway: could not seed ${entry} into ${home} (${error.message})`)
    }
  }

  log.log(`home: ${home} (profile copied from ${source})`)
  return home
}

/**
 * Give one user their own `profiles/` tree.
 *
 * dsh writes saved model/provider settings into `profiles/<name>/cordis.patch.yml`
 * inside `DSH_HOME`, so this directory is user data even though it looks like
 * installation state. A deployment that predates this rule shares it by symlink;
 * such a link is replaced with a real copy, which is what stops one user's
 * settings from appearing in everyone else's.
 *
 * @param from - the template's `profiles` directory.
 * @param to - this user's `profiles` path.
 * @param log - logger.
 */
function seedPrivateProfiles(from, to, log) {
  let existing
  try {
    existing = lstatSync(to)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) return
    rmSync(to, { force: true, recursive: true })
  }
  copyDirectory(from, to, log)
  log.log(`profiles: copied into ${to} (saved settings live here, per user)`)
}

/**
 * Recursively copy a directory tree, for the per-user `profiles` seeds.
 *
 * Links are reproduced, never dereferenced. A profile's `node_modules` is a
 * pnpm-style layout: on Windows nearly every entry there is a junction into the
 * installation (`…\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\<pkg>`),
 * so dereferencing turns a few hundred kilobytes of settings into a ~175 MB copy
 * per user and re-copies code that is not user data at all. `lstatSync` reports a
 * junction as a symbolic link — *not* as a directory — which is why the old
 * `isDirectory()` branch sent it to `copyFileSync` and died with
 * `EPERM: operation not permitted, copyfile`.
 *
 * @param from - source directory.
 * @param to - destination directory.
 * @param log - logger for entries that could not be reproduced.
 */
function copyDirectory(from, to, log = console) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const src = join(from, entry)
    const dst = join(to, entry)
    const stat = lstatSync(src)
    if (stat.isSymbolicLink()) {
      try {
        copyLink(src, dst)
      } catch (error) {
        log.error(`gateway: could not reproduce the link ${src} (${error.message})`)
      }
      continue
    }
    if (stat.isDirectory()) copyDirectory(src, dst, log)
    else copyFileSync(src, dst)
  }
}

/**
 * Reproduce one symlink or junction without following it.
 *
 * A link to a directory becomes a junction so no elevation is needed on Windows;
 * a link to a file keeps its target verbatim, falling back to a copy of the bytes
 * where the platform refuses to create a file symlink.
 *
 * @param src - the link to reproduce.
 * @param dst - where to create it.
 */
function copyLink(src, dst) {
  const target = readlinkSync(src)
  if (statSync(src).isDirectory()) {
    symlinkSync(isAbsolute(target) ? target : resolve(dirname(src), target), dst, 'junction')
    return
  }
  try {
    symlinkSync(target, dst)
  } catch {
    copyFileSync(src, dst)
  }
}

/**
 * Check that a template home is usable.
 * @param template - candidate path.
 * @returns an error message, or undefined when fine.
 */
export function checkTemplate(template) {
  if (template === undefined) return 'no template configured (--home-template)'
  if (!isAbsolute(template)) return 'template path must be absolute'
  if (!existsSync(template)) return `template does not exist: ${template}`
  return undefined
}
