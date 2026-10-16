# Design notes: why the gateway is built the way it is

Every decision below was measured against a real `dsh` process with a real
browser, not derived from reading source alone. Where a number appears, it is
an observation, not an estimate. The full Chinese investigation log behind
these notes is kept out of the repository on purpose.

## 1. Why a plugin cannot isolate users

dsh's Web GUI is a single-user application. Its session store lives at
`$DSH_HOME/sessions` and is keyed by *workspace path*, not by user. Two
different accounts signing in to the same dsh process both see the same
session list — measured directly: two logins on one process returned the same
43 sessions (a second experiment with fresh accounts returned the same 39 to
both).

The store root is resolved once, at process start, from `DSH_HOME`:

```yaml
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')   # process-level, user-independent
```

A plugin runs *inside* that process. It can authenticate (answer "who may
enter"), but it cannot change which data exists behind the door. A QR-pairing
gate answers *who may enter* — while every paired phone still sees the same
sessions. The capabilities table:

| Capability | Plugin | Gateway |
| --- | :-: | :-: |
| Authenticate a user | ✅ | ✅ |
| Switch the session-store root per user | ❌ | ✅ (one `DSH_HOME` per process) |
| Isolate process memory per user | ❌ | ✅ (process boundary) |
| Start/stop/reap dsh | ❌ | ✅ |

So isolation has to be structural. That is the reason this gateway spawns one
dsh process per account instead of fronting a single shared one.

## 2. The trust fence is port-sensitive

dsh refuses `/api/*` calls from a non-loopback authority that is not in its
trusted-host list with **403**. Measured with `--trusted-host
192.168.100.51:3081`:

| Request Host | Result |
| --- | --- |
| `127.0.0.1:8080` | 401 (reachable, only missing auth) |
| `192.168.100.51:8080` | **403** — port does not match |
| `192.168.100.51:3081` | 401 |
| `dsh.example.com` | 401 |

A host entry *with* a port matches that exact port only; a host entry *without*
a port matches any port on that host. The gateway forwards the **public
authority the browser used** (never dsh's internal port), so the trusted entry
must describe the gateway's address. The gateway enumerates the machine's own
interfaces at startup and passes them to every dsh it spawns, which is why
plain LAN access needs no configuration; a bridge network (Docker) hides the
host address, which is the one case where `DSH_GATEWAY_TRUSTED_HOSTS` is
required.

There is also a recovery path: when dsh refuses an authority it has never
seen, the gateway grants that hostname to the affected account and restarts
that account's dsh once, then replays the request. A reverse proxy in front of
the gateway therefore works with no configuration, at the cost of one restart
per new hostname.

## 3. Cookies ignore the port, so the session cookie is named per authority

Two gateways sharing one hostname on different ports (`:2020` on a router,
`:2021` on a workstation) would otherwise overwrite each other's sign-in
cookie, and every request would answer `{"error":"unauthenticated"}`. The
gateway therefore names its cookie `dsh-gateway-session-<hash of authority>`,
so each public authority carries its own session. This mirrors dsh's own
`dsh-auth-*` behaviour: reaching the same instance by a second name asks for a
second sign-in.

## 4. dsh credentials never reach the browser

The gateway reads the launch token from dsh's startup banner, mints dsh's own
`dsh-auth-*` cookie once, server-side, and hands the browser an opaque
`__dsh_relay` handle instead. If dsh ever rejects the cached credential, the
gateway re-mints and retries once rather than stranding the page on a 401 —
including replaying a POST body.

## 5. A user's profile must be a real copy, not a link

dsh saves the provider/model a user picks into
`profiles/<name>/cordis.patch.yml` *inside `DSH_HOME`*. With a shared or
linked `profiles/` tree, one user's saved provider silently became the default
for everyone — measured with two real accounts, which is why `profiles/` is a
real copy per user while the installation trees (`node_modules`,
`dsh-runtimes`) are shared links.

On Windows, seeding a home must reproduce pnpm-style junctions **as junctions**;
dereferencing one is what produced `EPERM: operation not permitted, copyfile`.
With no `--template`, a fresh account is an empty directory and dsh
materialises its own shipped profile inside it — kilobytes per account, and
the cleanest possible starting state.

## 6. Model settings cannot be edited over LAN — so the gateway writes them

dsh's own settings pages degrade their persistence to `memory` when
`location.hostname` is not loopback (the LAN page reports *"settings are
unavailable in this browser"*). The gateway therefore offers a 配置模型
(configure model) path that writes the provider, key reference and default
model into that user's dsh **over the dsh process's loopback connection**,
where validation is real. It writes `apiKeyEnv` at the exact
`settingsNs`/`settingsPath` that `llm/listConfigurableProviders` reports for
the route, so different route shapes land where they resolve from. The
获取模型 (fetch models) button calls dsh's own `llm/discoverModels`, the same
remote call dsh's page would make, falling back to the catalogue dsh already
holds for the route.

## 7. What is deliberately out of scope

- **TLS.** This is built for a trusted LAN. Terminate TLS in a reverse proxy
  if it is exposed further.
- **One shared API key.** Each account is a separate dsh with a separate
  credential store; accounts that should share a key can each point at the
  same key, but nothing in the gateway forces or hides that.
