/**
 * The admin API.
 *
 * Everything here is guarded by a single rule: the caller's session must belong
 * to an account with `admin: true`, re-checked from the store on every request
 * rather than trusted from the session record. Disabling an administrator
 * therefore takes effect immediately instead of at their next sign-in.
 *
 * Deleting or disabling a user also tears down their running dsh and revokes
 * their gateway sessions. Leaving either behind would let a "deleted" account
 * keep reading an already-open session, which is the one thing user management
 * must not permit.
 */

import { validName } from './accounts.mjs'

/** Read and parse a JSON body, capped so a huge body cannot exhaust memory. */
async function readJson(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
}

/** Send JSON with no-store, since every response here is account state. */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Build the admin request handler.
 *
 * @param options - dependencies.
 * @param options.accounts - the account store.
 * @param options.pool - the dsh pool, or undefined in single-target mode.
 * @param options.revokeUser - callback that drops every session for a user.
 * @param options.log - logger.
 * @returns `handle(req, res, url, viewer)` — true when the request was handled.
 */
export function createAdmin({ accounts, pool, revokeUser, log = console }) {
  /** Users plus the live process table, in one round trip for the SPA. */
  const state = (viewer) => ({
    viewer,
    users: accounts.list(),
    instances: pool === undefined ? [] : pool.status(),
    // null means this gateway has no shared home, so no account can be granted it.
    sharedHome: pool?.sharedHome ?? null,
  })

  return async function handle(req, res, url, viewer) {
    const path = url.pathname.slice('/__gateway/admin/api'.length)
    const method = req.method ?? 'GET'

    if (path === '/state' && method === 'GET') {
      json(res, 200, { ...state(viewer), plugins: accounts.listPlugins(), branding: accounts.getBranding() })
      return true
    }

    if (path === '/users' && method === 'POST') {
      let body
      try {
        body = await readJson(req)
      } catch (error) {
        json(res, 400, { error: error.message })
        return true
      }
      const sharedHome = body.sharedHome === true
      if (sharedHome && pool?.sharedHome === undefined) {
        json(res, 400, { error: 'this gateway has no shared dsh home configured' })
        return true
      }
      const created = accounts.create({
        name: String(body.name ?? '').trim(),
        password: body.password,
        admin: body.admin === true,
        sharedHome,
      })
      if (created.error !== undefined) {
        json(res, 400, { error: created.error })
        return true
      }
      log.log(`admin: ${viewer} created user ${created.user.name}`)
      json(res, 201, { user: { name: created.user.name } })
      return true
    }

    const userMatch = /^\/users\/([^/]+)(?:\/(password|enabled|shared-home))?$/.exec(path)
    if (userMatch !== null) {
      const name = decodeURIComponent(userMatch[1])
      const action = userMatch[2]
      if (!validName(name)) {
        json(res, 400, { error: 'invalid user name' })
        return true
      }

      if (action === 'password' && method === 'POST') {
        const body = await readJson(req).catch(error => ({ error: error.message }))
        if (body.error !== undefined) {
          json(res, 400, { error: body.error })
          return true
        }
        if (!accounts.setPassword(name, body.password)) {
          json(res, 400, { error: 'unknown user, or password shorter than 8 characters' })
          return true
        }
        // A password change must not leave older sessions usable.
        revokeUser(name)
        log.log(`admin: ${viewer} reset the password for ${name}`)
        json(res, 200, { ok: true })
        return true
      }

      if (action === 'enabled' && method === 'POST') {
        const body = await readJson(req).catch(() => ({}))
        const enabled = body.enabled === true
        const applied = accounts.setEnabled(name, enabled)
        if (applied === undefined) {
          json(res, 404, { error: 'unknown user' })
          return true
        }
        if (!applied) {
          pool?.stop(name, 'account disabled')
          revokeUser(name)
        }
        log.log(`admin: ${viewer} ${applied ? 'enabled' : 'disabled'} ${name}`)
        json(res, 200, { enabled: applied })
        return true
      }

      if (action === 'shared-home' && method === 'POST') {
        if (pool?.sharedHome === undefined) {
          json(res, 400, { error: 'this gateway has no shared dsh home configured' })
          return true
        }
        const body = await readJson(req).catch(() => ({}))
        const sharedHome = body.sharedHome === true
        const applied = accounts.setSharedHome(name, sharedHome)
        if (applied === undefined) {
          json(res, 404, { error: 'unknown user' })
          return true
        }
        // A running dsh is bound to the home it was started with, so the grant
        // takes effect on the account's next request, not on this one.
        pool?.stop(name, 'shared home access changed')
        log.log(`admin: ${viewer} ${applied ? 'granted' : 'revoked'} shared home access for ${name}`)
        json(res, 200, { sharedHome: applied })
        return true
      }

      if (action === undefined && method === 'DELETE') {
        if (accounts.get(name) === undefined) {
          json(res, 404, { error: 'unknown user' })
          return true
        }
        if (!accounts.remove(name)) {
          json(res, 400, { error: 'cannot remove the last administrator' })
          return true
        }
        pool?.stop(name, 'account deleted')
        revokeUser(name)
        log.log(`admin: ${viewer} deleted ${name}`)
        json(res, 200, { ok: true })
        return true
      }

      json(res, 405, { error: `method ${method} not allowed here` })
      return true
    }

    if (path === '/branding' && method === 'POST') {
      const body = await readJson(req).catch(error => ({ error: error.message }))
      if (body.error !== undefined) {
        json(res, 400, { error: body.error })
        return true
      }
      const applied = accounts.setBranding({ name: body.name, logo: body.logo })
      if (applied.error !== undefined) {
        json(res, 400, { error: applied.error })
        return true
      }
      log.log(`admin: ${viewer} updated branding (name=${applied.branding.name ? 'set' : 'cleared'}, logo=${applied.branding.logo ? 'set' : 'cleared'})`)
      json(res, 200, { branding: { name: applied.branding.name, hasLogo: applied.branding.logo !== '' } })
      return true
    }

    const pluginMatch = /^\/plugins\/([^/]+)$/.exec(path)
    if (pluginMatch !== null) {
      const id = decodeURIComponent(pluginMatch[1])
      if (method === 'POST') {
        const body = await readJson(req).catch(error => ({ error: error.message }))
        if (body.error !== undefined) {
          json(res, 400, { error: body.error })
          return true
        }
        const applied = accounts.setPlugin(id, { name: body.name, enabled: body.enabled })
        if (applied.error !== undefined) {
          json(res, 400, { error: applied.error })
          return true
        }
        log.log(`admin: ${viewer} set plugin ${id} (enabled=${String(applied.plugin.enabled)})`)
        json(res, 200, { plugin: { id, name: applied.plugin.name, enabled: applied.plugin.enabled } })
        return true
      }
      if (method === 'DELETE') {
        if (!accounts.removePlugin(id)) {
          json(res, 404, { error: 'unknown plugin' })
          return true
        }
        log.log(`admin: ${viewer} removed plugin ${id}`)
        json(res, 200, { ok: true })
        return true
      }
      json(res, 405, { error: `method ${method} not allowed here` })
      return true
    }

    const grantMatch = /^\/users\/([^/]+)\/plugins$/.exec(path)
    if (grantMatch !== null && method === 'POST') {
      const name = decodeURIComponent(grantMatch[1])
      const body = await readJson(req).catch(error => ({ error: error.message }))
      if (body.error !== undefined) {
        json(res, 400, { error: body.error })
        return true
      }
      const id = String(body.plugin ?? '')
      const applied = accounts.setPluginGrant(name, id, body.granted === true)
      if (applied === undefined) {
        json(res, 404, { error: 'unknown user or plugin' })
        return true
      }
      log.log(`admin: ${viewer} ${body.granted === true ? 'granted' : 'revoked'} ${id} for ${name}`)
      json(res, 200, { plugins: accounts.pluginsFor(name) })
      return true
    }

    const stopMatch = /^\/instances\/([^/]+)\/stop$/.exec(path)
    if (stopMatch !== null && method === 'POST') {
      const name = decodeURIComponent(stopMatch[1])
      const stopped = pool?.stop(name, `stopped by ${viewer}`) ?? false
      json(res, stopped ? 200 : 404, stopped ? { ok: true } : { error: 'no running dsh for that user' })
      return true
    }

    json(res, 404, { error: 'no such admin endpoint' })
    return true
  }
}
