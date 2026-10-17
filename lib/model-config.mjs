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
export const MODEL_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
export const PROVIDER_ID_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,62})$/

/**
 * Everything the provider-list page renders from, in one snapshot.
 *
 * Rows are the union dsh can configure: registered providers, configurable
 * routes and the pi-ai profiles the user's own dsh carries (custom providers
 * included, even when dsh has not registered them yet). Each row carries the
 * profile fields the editor edits — baseURL, displayName, models — so the page
 * renders the real stored state rather than a guess.
 */
export async function readProviderCatalog(client) {
  const [registered, routes, described] = await Promise.all([
    client.listProviders(),
    client.listRoutes(),
    client.describeSettings(),
  ])
  const section = namespaceOf(described, SETTINGS_NS)
  const profiles = valueAt(section?.value, ['providers'])
  const live = new Set((registered ?? []).map(entry => entry.id))
  const model = namespaceOf(described, MODEL_NS)
  const current = model?.value ?? {}
  const defaultProvider = typeof current.provider === 'string' ? current.provider : ''

  const seen = new Set()
  const providers = []
  for (const entry of routes ?? []) {
    if (seen.has(entry.provider)) continue
    seen.add(entry.provider)
    const facts = routeFacts(routes, described, entry.provider)
    const profile = valueAt(section?.value, facts.settingsPath) ?? null
    const derived = deriveKeyRef(entry.provider)
    const refs = [...new Set([facts.refFromProfile, derived].filter(ref => typeof ref === 'string' && ref !== ''))]
    const credentials = refs.length === 0 ? {} : await client.describeCredentials(refs)
    const namedConfigured = facts.refFromProfile !== undefined
      && credentials[facts.refFromProfile]?.configured === true
    providers.push({
      provider: entry.provider,
      label: profile?.displayName || entry.displayName || entry.provider,
      active: live.has(entry.provider),
      configurable: facts.settingsPath.length > 0,
      custom: facts.settingsPath.length > 0 && typeof profile?.api === 'string',
      keyConfigured: namedConfigured || credentials[derived]?.configured === true,
      keyRef: namedConfigured ? facts.refFromProfile : derived,
      profile: profile === null ? null : {
        api: typeof profile.api === 'string' ? profile.api : undefined,
        baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : undefined,
        displayName: typeof profile.displayName === 'string' ? profile.displayName : undefined,
        models: normaliseModels(profile.models),
      },
    })
  }
  // Custom profiles dsh has not registered as routes yet (created but keyed
  // routes register on their own; dormant ones would otherwise vanish).
  if (profiles && typeof profiles === 'object') {
    for (const [id, profile] of Object.entries(profiles)) {
      if (seen.has(id) || profile === null || typeof profile !== 'object') continue
      seen.add(id)
      const derived = deriveKeyRef(id)
      const credentials = await client.describeCredentials([derived])
      providers.push({
        provider: id,
        label: profile.displayName || id,
        active: live.has(id),
        custom: true,
        keyConfigured: credentials[derived]?.configured === true,
        keyRef: derived,
        profile: {
          api: typeof profile.api === 'string' ? profile.api : undefined,
          baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : undefined,
          displayName: typeof profile.displayName === 'string' ? profile.displayName : undefined,
          models: normaliseModels(profile.models),
        },
      })
    }
  }
  return {
    writable: described?.writable === true,
    providers,
    defaultModel: {
      provider: defaultProvider,
      model: typeof current.model === 'string' ? current.model : '',
    },
  }
}

/**
 * Save one provider row: credential + key reference as before, plus the custom
 * profile fields (baseURL, displayName, models) and the creation of hand-
 * declared providers under `llm-pi-ai.providers.<id>`.
 *
 * `remove` unsets the profile instead. The credential the profile named is left
 * in the store — an unreferenced secret is harmless, and dsh exposes no unset
 * over the loopback this page speaks.
 */
export async function saveProviderConfig(client, {
  provider, apiKey = '', baseURL, displayName, models, protocol, remove = false,
}) {
  if (!PROVIDER_ID_RE.test(provider)) throw new Error(`非法的 Provider ID："${provider}"`)
  const described = await client.describeSettings()
  const routes = await client.listRoutes()
  const facts = routeFacts(routes, described, provider)
  const section = namespaceOf(described, SETTINGS_NS)
  const revision = section?.revision ?? 0
  const settingsPath = facts.settingsPath.length > 0 ? facts.settingsPath : ['providers', provider]
  const profile = valueAt(section?.value, settingsPath) ?? null
  const changed = []

  if (remove) {
    if (profile === null) throw new Error(`提供商 "${provider}" 没有可删除的配置。`)
    await client.mutateSettings(SETTINGS_NS, [{ op: 'unset', path: settingsPath }], revision)
    return { ref: deriveKeyRef(provider), changed: ['删除提供商'] }
  }

  const isCustom = profile !== null && typeof profile.api === 'string'
  const creating = profile === null && facts.settingsPath.length === 0
  if (creating) {
    // Hand-declared provider: protocol + endpoint + a non-empty catalogue are
    // the minimum dsh needs to route requests at all.
    if (!MODEL_PROTOCOLS.includes(protocol)) throw new Error('创建自定义提供商需要协议（openai-completions / openai-responses / anthropic-messages）。')
    if (typeof baseURL !== 'string' || !/^https?:\/\//i.test(baseURL.trim())) throw new Error('创建自定义提供商需要合法的端点（http(s) URL）。')
    const list = normaliseModelInputs(models)
    if (list.length === 0) throw new Error('创建自定义提供商至少需要一个模型：先「获取可用模型」选择，或手工填写模型 id。')
    const value = { apiKeyEnv: deriveKeyRef(provider), api: protocol, baseURL: baseURL.trim(), models: list }
    if (typeof displayName === 'string' && displayName.trim() !== '') value.displayName = displayName.trim()
    await client.mutateSettings(SETTINGS_NS, [{ op: 'set', path: settingsPath, value }], revision)
    changed.push('创建提供商')
    if (apiKey !== '') { await writeKey(client, provider, apiKey); changed.push('API Key') }
    return { ref: deriveKeyRef(provider), changed }
  }

  // Existing row: credential/keyRef exactly like saveModelConfig, then the
  // editable profile fields for custom routes.
  if (apiKey !== '') { await writeKey(client, provider, apiKey); changed.push('API Key') }
  const profileOps = []
  if (isCustom) {
    if (typeof baseURL === 'string' && baseURL.trim() !== '' && baseURL.trim() !== profile.baseURL) {
      if (!/^https?:\/\//i.test(baseURL.trim())) throw new Error('端点必须是 http(s) URL。')
      profileOps.push({ op: 'set', path: [...settingsPath, 'baseURL'], value: baseURL.trim() })
    }
    if (typeof displayName === 'string' && displayName.trim() !== (profile.displayName ?? '')) {
      profileOps.push({ op: 'set', path: [...settingsPath, 'displayName'], value: displayName.trim() })
    }
    if (models !== undefined) {
      const list = normaliseModelInputs(models)
      profileOps.push({ op: 'set', path: [...settingsPath, 'models'], value: list })
    }
    if (profileOps.length > 0) {
      const fresh = namespaceOf(await client.describeSettings(), SETTINGS_NS)?.revision ?? 0
      await client.mutateSettings(SETTINGS_NS, profileOps, fresh)
      changed.push('自定义设置')
    }
  }
  if (changed.length === 0 && apiKey === '') throw new Error('没有需要保存的修改。')
  return { ref: deriveKeyRef(provider), changed }
}

/** Store the key under the derived reference and make the profile name it. */
async function writeKey(client, provider, apiKey) {
  await client.setCredential(deriveKeyRef(provider), apiKey)
  const described = await client.describeSettings()
  const routes = await client.listRoutes()
  const facts = routeFacts(routes, described, provider)
  if (facts.refFromProfile !== deriveKeyRef(provider)) {
    const revision = namespaceOf(described, facts.settingsNs)?.revision ?? 0
    await client.mutateSettings(facts.settingsNs, [
      { op: 'set', path: [...facts.settingsPath, 'apiKeyEnv'], value: deriveKeyRef(provider) },
    ], revision)
  }
}

/** Client-supplied model rows → pi-ai catalogue entries (id required). */
function normaliseModelInputs(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const entry of list.slice(0, 200)) {
    const id = typeof entry === 'string' ? entry.trim() : String(entry?.id ?? '').trim()
    if (id === '') continue
    const model = { id }
    const name = typeof entry === 'object' && entry !== null ? String(entry.name ?? '').trim() : ''
    if (name !== '' && name !== id) model.name = name
    const contextWindow = typeof entry === 'object' && entry !== null ? Number(entry.contextWindow) : NaN
    if (Number.isFinite(contextWindow) && contextWindow > 0) model.contextWindow = Math.round(contextWindow)
    out.push(model)
  }
  return out
}

/**
 * Discovery for a row being edited — including a draft custom provider that is
 * not saved yet: the request carries the endpoint and protocol straight from
 * the form, and a freshly typed key beats the stored credential.
 */
export async function discoverDraftModels(client, { provider, baseURL, api, apiKey }) {
  const request = { provider }
  if (typeof baseURL === 'string' && baseURL.trim() !== '') request.baseURL = baseURL.trim()
  if (MODEL_PROTOCOLS.includes(api)) request.api = api
  if (typeof apiKey === 'string' && apiKey.trim() !== '') request.apiKey = apiKey.trim()
  return normaliseModels(await client.discoverModels(SETTINGS_NS, request))
}

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
