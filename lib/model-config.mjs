/**
 * Per-user model configuration.
 *
 * The gateway never edits `settings.yaml` or `.credentials.yaml` itself. dsh
 * validates both documents on its own terms — a route whose model list cannot be
 * resolved is refused outright, and only dsh knows the schema — so every save
 * here goes through dsh's own settings and credentials RPCs. The form is then
 * either accepted whole or refused with dsh's own reason, and no half-written
 * document can exist.
 *
 * This exists because dsh's own Models settings page is unreachable over a LAN:
 * it runs in process-local "memory" mode unless the page itself is loopback, and
 * refuses to load with `settings are unavailable in this browser`. The gateway
 * is a trusted authority, so it can read and write the same state on the user's
 * behalf from the server side.
 *
 * Where a write lands is decided by dsh, not by this file: `llm/
 * listConfigurableProviders` states each route's `settingsNs` and the
 * `settingsPath` from that namespace's section root to the route's profile.
 * `deepseek-official`, for example, is `{settingsNs: 'llm-deepseek',
 * settingsPath: []}` — the whole section is the profile — while a pi-ai route is
 * `{settingsNs: 'llm-pi-ai', settingsPath: ['providers', <route>]}`. Writing a
 * route's key reference anywhere else leaves the route resolving the reference
 * it already named, which is exactly the `no API key for provider route`
 * failure.
 */
import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'

/** Namespace dsh uses when a route's adapter declares none of its own. */
export const SETTINGS_NS = 'llm-pi-ai'

/** The settings namespace that names the default provider and model. */
export const MODEL_NS = 'agent-default-model'

/**
 * The credential reference a typed key is stored under.
 *
 * Mirrors `deriveKeyRef` in `dsh-client-ui-settings-models`: that page never asks
 * for an environment-variable name, so a key typed for a route is stored under
 * this derived reference and the route profile records it as `apiKeyEnv`.
 */
export const deriveKeyRef = provider =>
  `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

/**
 * One JSON-RPC channel to a running dsh over loopback.
 *
 * `cookie` is a `dsh-auth-<authority hash>=<secret>` pair minted against the
 * loopback authority, and dsh binds the cookie *name* to that authority. Node's
 * default `Host` header for a request to `127.0.0.1:<port>` is exactly the
 * authority the pair was minted for, so the name matches without an override.
 *
 * @param port - the instance's loopback port.
 * @param cookie - the loopback-bound dsh session pair.
 */
export function createConfigClient({ port, cookie, timeoutMs = 20000 }) {
  function call(method, args) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload: { args },
      }), 'utf8')
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        path: `/api/${method}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          cookie,
        },
      }, (response) => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`dsh answered ${String(response.statusCode)} for ${method}`))
            return
          }
          let body
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            reject(new Error(`${method}: dsh's answer was not JSON`))
            return
          }
          if (body?.result?.ok === true) {
            resolve(body.result.value)
            return
          }
          reject(new Error(body?.result?.error?.message ?? `${method} was refused by dsh`))
        })
      })
      request.on('error', reject)
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`${method}: dsh did not answer within ${String(timeoutMs)}ms`))
      })
      request.end(payload)
    })
  }

  return {
    call,
    listProviders: () => call('llm/listProviders', {}),
    listRoutes: () => call('llm/listConfigurableProviders', {}),
    describeSettings: () => call('settings/describe', {}),
    describeCredentials: refs => call('credentials/describe', { refs }),
    setCredential: (ref, value) => call('credentials/set', { ref, value }),
    /**
     * Ask the route's own adapter what models it offers.
     *
     * This is the same remote call dsh's own Models page makes for its "fetch
     * models" action: the adapter answers from a shipped catalogue when it has
     * one, and otherwise reads the provider's `GET /models`. A route whose
     * adapter registered no discovery refuses it, which is why the caller has a
     * catalogue fallback.
     */
    discoverModels: (settingsNs, request) => call('llm/discoverModels', { settingsNs, request }),
    /**
     * Path-addressed settings edit. A `set` at `[...settingsPath, 'apiKeyEnv']`
     * names one field of one route instead of rebuilding the section, so fields
     * this page cannot see survive the write.
     */
    mutateSettings: (ns, ops, expectedRevision) => call('settings/mutate', { ns, ops, expectedRevision }),
  }
}

/** One namespace's view out of a `settings/describe` answer. */
const namespaceOf = (described, ns) =>
  (described?.namespaces ?? []).find(entry => entry.ns === ns)

/** A value at a path inside a namespace's section, or undefined. */
function valueAt(section, path) {
  let node = section
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = node[key]
  }
  return node
}

/**
 * The route's profile as dsh describes it, plus the reference it currently
 * names. `refFromProfile` is undefined for a route the adapter configures
 * without a credential (dsh's account route signs in instead).
 */
function routeFacts(routes, described, provider) {
  const descriptor = (routes ?? []).find(entry => entry.provider === provider)
  const settingsNs = descriptor?.settingsNs ?? SETTINGS_NS
  const settingsPath = [...(descriptor?.settingsPath ?? [])]
  const section = namespaceOf(described, settingsNs)
  const profile = valueAt(section?.value, settingsPath)
  const named = profile?.apiKeyEnv
  return {
    declared: descriptor !== undefined,
    settingsNs,
    settingsPath,
    revision: section?.revision ?? 0,
    refFromProfile: typeof named === 'string' && named.length > 0 ? named : undefined,
  }
}

/**
 * Read everything the configuration form renders from.
 *
 * `listProviders` is the routes dsh actually registered; `listRoutes` is every
 * route it can be configured for. The form offers the union, because a route
 * that is configurable but not yet keyed is precisely the one a user comes here
 * to set up.
 */
export async function readModelConfig(client) {
  const [registered, routes, described] = await Promise.all([
    client.listProviders(),
    client.listRoutes(),
    client.describeSettings(),
  ])

  const model = namespaceOf(described, MODEL_NS)
  const current = model?.value ?? {}
  const provider = typeof current.provider === 'string' ? current.provider : ''
  const facts = provider === ''
    ? { refFromProfile: undefined, settingsNs: SETTINGS_NS, settingsPath: [], revision: 0 }
    : routeFacts(routes, described, provider)

  const derived = provider === '' ? '' : deriveKeyRef(provider)
  const refs = [...new Set([facts.refFromProfile, derived].filter(ref => typeof ref === 'string' && ref !== ''))]
  const credentials = refs.length === 0 ? {} : await client.describeCredentials(refs)

  // Show the reference the route actually resolves: the one its profile names
  // when that reference is configured, otherwise the derived one this page
  // writes and reads.
  const namedConfigured = facts.refFromProfile !== undefined
    && credentials[facts.refFromProfile]?.configured === true
  const keyRef = namedConfigured ? facts.refFromProfile : derived
  const keyConfigured = namedConfigured || credentials[derived]?.configured === true

  const live = new Set((registered ?? []).map(entry => entry.id))
  const options = (routes ?? []).map(entry => ({
    provider: entry.provider,
    label: entry.displayName || entry.provider,
    active: live.has(entry.provider),
  }))
  if (provider !== '' && !options.some(option => option.provider === provider)) {
    options.unshift({ provider, label: provider, active: live.has(provider) })
  }

  return {
    writable: described?.writable === true,
    options,
    provider,
    model: typeof current.model === 'string' ? current.model : '',
    keyRef,
    keyConfigured,
    refFromProfile: facts.refFromProfile,
    revision: facts.revision,
    modelRevision: model?.revision ?? 0,
  }
}

/**
 * Normalise one model list — dsh's discovery answer or a section's stored
 * catalogue.
 *
 * Both are arrays of objects carrying at least an id; `name` is dsh's display
 * label and `contextWindow` the window when the route declares one. An entry
 * without an id is dropped rather than offered as an unusable choice.
 */
function normaliseModels(list) {
  if (!Array.isArray(list)) return []
  const models = []
  for (const entry of list) {
    const id = typeof entry === 'string'
      ? entry
      : (typeof entry?.id === 'string' ? entry.id : '')
    if (id === '') continue
    models.push({
      id,
      label: typeof entry?.name === 'string' && entry.name !== '' ? entry.name : id,
      contextWindow: typeof entry?.contextWindow === 'number' ? entry.contextWindow : undefined,
    })
  }
  return models
}

/**
 * The models a provider can be pointed at, behind the configuration page's
 * "获取模型" button.
 *
 * dsh's own Models page asks the route's adapter, so this does too. Not every
 * adapter answers: only the pi-ai routes register a discovery, and it refuses
 * the rest with `no model discovery is registered for "<ns>"`. A route that
 * refuses still publishes its catalogue inside its own settings section —
 * `llm-deepseek` ships its models as the value of `models`, which is what dsh's
 * own page renders before the button is pressed — so that section is the
 * fallback.
 *
 * @param client - a `createConfigClient` instance for the user's dsh.
 * @param provider - the route the form currently has selected.
 * @returns `{models, source, note}`; `source` is `discovery`, `catalogue` or `''`.
 */
export async function listModelCandidates(client, provider) {
  const [routes, described] = await Promise.all([
    client.listRoutes(),
    client.describeSettings(),
  ])
  const facts = routeFacts(routes, described, provider)

  let note = ''
  try {
    const found = normaliseModels(await client.discoverModels(facts.settingsNs, { provider }))
    if (found.length > 0) return { models: found, source: 'discovery', note: '' }
    note = 'dsh 没有报出任何模型'
  } catch (error) {
    note = error.message
  }

  const section = namespaceOf(described, facts.settingsNs)
  const stored = normaliseModels(valueAt(section?.value, [...facts.settingsPath, 'models']))
  if (stored.length > 0) return { models: stored, source: 'catalogue', note }
  return { models: [], source: '', note }
}

/**
 * Write one provider configuration.
 *
 * Order matters, because each document is validated on its own: the credential
 * first (a profile naming a reference that does not exist yet would be a broken
 * profile), then the route's key reference, then the default model. A failure
 * after the credential leaves an unreferenced secret behind, which is harmless;
 * a failure before it leaves nothing.
 *
 * A key typed into the form is always stored under the derived reference and the
 * route is pointed at it, so the pair can never disagree — that disagreement is
 * what makes a route report a missing key while the credential store holds one.
 * With no key typed the profile is left objecting only when it already names a
 * configured reference, which is also how a key saved by an older build (stored
 * under the derived reference, never named by the profile) starts working.
 *
 * A route the adapter configures without a credential — dsh's account route
 * signs in instead — is only given a default model.
 */
export async function saveModelConfig(client, { provider, apiKey, model }) {
  const derived = deriveKeyRef(provider)
  const changed = []

  const described = await client.describeSettings()
  const dependsOnCredential = await (async () => {
    const routes = await client.listRoutes()
    const facts = routeFacts(routes, described, provider)
    if (!facts.declared) throw new Error(`dsh does not describe a route "${provider}"`)
    // A route names a credential when its profile already carries a reference,
    // or when its profile is a subtree this page may create (the pi-ai layout).
    return {
      ...facts,
      usesCredential: facts.refFromProfile !== undefined || facts.settingsPath.length > 0,
    }
  })()

  if (dependsOnCredential.usesCredential) {
    let ref = derived
    let pointAt = false

    if (apiKey !== '') {
      await client.setCredential(derived, apiKey)
      pointAt = true
    } else if (dependsOnCredential.refFromProfile === derived) {
      // Already named and (presumably) configured: nothing to change.
    } else {
      const refs = [...new Set([derived, dependsOnCredential.refFromProfile].filter(Boolean))]
      const credentials = refs.length === 0 ? {} : await client.describeCredentials(refs)
      if (credentials[derived]?.configured === true) {
        // Stored by an older build that never named it: adopt the derived
        // reference so the credential the user already saved takes effect.
        pointAt = true
      } else if (dependsOnCredential.refFromProfile !== undefined) {
        ref = dependsOnCredential.refFromProfile
      }
    }

    if (pointAt) {
      const described2 = await client.describeSettings()
      const revision = routeFacts(
        await client.listRoutes(), described2, provider,
      ).revision
      await client.mutateSettings(
        dependsOnCredential.settingsNs,
        [{
          op: 'set',
          path: [...dependsOnCredential.settingsPath, 'apiKeyEnv'],
          value: ref,
        }],
        revision,
      )
      changed.push(apiKey === '' ? 'API Key 引用' : 'API Key')
    }
  }

  if (model !== '') {
    const revision = namespaceOf(described, MODEL_NS)?.revision ?? 0
    await client.mutateSettings(MODEL_NS, [
      { op: 'set', path: ['provider'], value: provider },
      { op: 'set', path: ['model'], value: model },
    ], revision)
    changed.push('默认模型')
  }

  return { ref: derived, changed }
}
