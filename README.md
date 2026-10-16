# dsh-gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-134%20checks-blue)](#tests)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4)](https://github.com/agaoaagao/dsh-gateway/pulls)

English | [中文文档](docs/README.zh-CN.md) | [Design notes](docs/DESIGN.md)

**Sign in once, and your dsh is yours alone.**

## Why this exists

dsh's Web GUI is a single-user application. Its session store lives at
`$DSH_HOME/sessions` and is keyed by *workspace path*, not by user, so two people
reaching the same dsh process see the same conversations. This was measured
directly: two different logins on one process listed the same 43 sessions.

That is not something a plugin can fix, because the store belongs to the process.
No amount of authentication changes which data exists behind it. A plugin that
adds a QR-code pairing gate, for example, answers *who may enter* �?while every
paired phone still sees the same sessions.

So isolation has to be structural: **one dsh process per account, each with its own
`DSH_HOME`**. This gateway is the front door that makes that invisible.

```text
              ┌─────────────────────────────────────────────�?  browser ──�?�? gateway :8080                              �?  (LAN/phone) �? · sign-in page, sessions, admin console     �?              �? · one dsh process per account, lazily       �?              └───────┬───────────────┬─────────────────────�?                      �?              �?              ┌───────▼──────�?┌──────▼───────�?              �?dsh (alice)  �?�?dsh  (bob)   �?  ...up to --max-instances
              �?:ephemeral   �?�?:ephemeral   �?              �?DSH_HOME=    �?�?DSH_HOME=    �?              �? .../alice   �?�? .../bob     �?              └──────────────�?└──────────────�?```

By default a per-user home starts *empty* �?dsh materialises its own shipped
profile inside it, so it can only ever contain what that account installs or
saves. If you do pass `--template`, installation trees in it are linked (a
junction on Windows, a symlink elsewhere) because they hold no user data, while
`profiles/` is a **real copy** per user �?dsh saves the provider and model a user
picks into `profiles/<name>/cordis.patch.yml` *inside `DSH_HOME`*, so sharing that
directory would make one user's settings the default for everyone. `sessions/`,
`storages/`, `logs/`, `attachments/` and `.credentials.yaml` are deliberately
**not** seeded and are created fresh inside each user's own home. That is the
isolation.

## Quick start

### Docker

```sh
DSH_GATEWAY_ADMIN_PASSWORD='choose-something' \
DSH_GATEWAY_TRUSTED_HOSTS=192.168.100.1 \
docker compose up -d --build
```

Open `http://<docker-host>:8080/` and sign in as `admin`.

`DSH_GATEWAY_TRUSTED_HOSTS` is the address **a browser uses to reach the
gateway**. It is required behind a bridge network: dsh refuses API calls from
authorities it does not trust, it can only enumerate its *own* interfaces, and the
host's LAN address is not one of them. A port-less entry matches any port.

### Bare Node

```sh
node gateway.mjs --spawn \
  --listen 8080 --bind 0.0.0.0 \
  --home-root /srv/dsh-users \
  --state /srv/gateway/state.json
```

No dependencies, no build step �?everything is Node's standard library.

### Every account starts clean, automatically

Nothing to build: leave `--template` off and a new account's home is an empty
directory. dsh materialises the profile *it* ships inside it the first time that
account starts �?the two bundles `@deepseek-ai/dsh-base` and
`@deepseek-ai/dsh-web-app`, an empty `cordis.patch.yml`, four files and no
`node_modules`, because dsh resolves those bundles from its own installation.

That account then has dsh's plugin manager (`plugin-manager`,
`ui-settings-plugins`, `ui-settings-plugin-inventory`), so the user installs
whatever they want from the interface, into their own `profiles/` copy. Existing
accounts are never re-seeded �?rename or delete a home only to have it rebuilt.

`--template` exists only for the case where every account *should* start with the
same pre-installed set. Point it at your own `~/.dsh` and every account inherits
your plugins, your market database and your saved model settings, which is
exactly what one account must not see from another.

### On Windows, without a service manager

The same command line works on Windows. One difference matters when you *do* pass
`--template`: seeding a user home copies it, and a pnpm-style
`profiles\*\node_modules` is made almost entirely of junctions. Those are
reproduced as junctions �?never dereferenced (see [docs/DESIGN.md](docs/DESIGN.md));
dereferencing one is what produced `EPERM: operation not permitted, copyfile`.

One way to run it at logon without a service manager �?put your data under
`%USERPROFILE%\dsh-gateway-data` and start it from a hidden script:

```powershell
# start-gateway.ps1 �?the launch line, with your own paths
node gateway.mjs --spawn --listen 8080 --bind 0.0.0.0 `
  --state     "$env:USERPROFILE\dsh-gateway-data\gateway-state.json" `
  --accounts  "$env:USERPROFILE\dsh-gateway-data\accounts.json" `
  --home-root "$env:USERPROFILE\dsh-gateway-data\users" `
  --profile web `
  --dsh-bin node `
  --dsh-arg "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
```

Launch it hidden at logon with a one-line `.vbs` in your Startup folder
(`Register-ScheduledTask` instead needs elevation and returns `Access is
denied.` on a non-admin account):

```vbscript
' %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-gateway.vbs
CreateObject("Wscript.Shell").Run "powershell -WindowStyle Hidden -File """ & _
  CreateObject("Wscript.Shell").ExpandEnvironmentStrings("%USERPROFILE%") & _
  "\dsh-gateway-data\start-gateway.ps1""", 0, False
```

```powershell
# status �?one listener plus a 200 means it is up
(Get-NetTCPConnection -LocalPort 8080 -State Listen).Count
(Invoke-WebRequest http://127.0.0.1:8080/healthz -UseBasicParsing).StatusCode

# stop �?the gateway and every dsh it spawned (their --patch path carries it too)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-gateway\gateway.mjs*' -or $_.CommandLine -like '*dsh-gateway-data*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

The window is hidden, so `<data dir>\gateway.log` (rotated to
`gateway.log.1` past 5 MB) is where a failed start says why. A looping
`start-gateway.ps1` is also the
supervisor: there is no service manager here, so it loops �?`node` runs with its
streams in `gateway.out.log` / `gateway.err.log`, an exit appends
`--- gateway exited code N after Xs` to `gateway.log`, and the next start folds the
previous run's streams into it before they are truncated. A crash is therefore always
on record twice: once from the gateway's own `uncaughtException` handler, once from the
supervisor's restart line.

Each account costs only what it stores: with no `--template` the home is empty
and dsh bootstraps a four-file profile, so a fresh account is kilobytes. Budget
about 365 MB per account **only if your template carries a populated
`profiles/*/node_modules`** (a template seeded from a machine that had plugins
installed). The top-level `profiles\node_modules` is free either way because it is
399 links, and the junctions inside a profile are reproduced rather than copied.

## Accounts and the admin console

The first start seeds one administrator, `admin` / `admin12345`. **Change it.**
Then open the console:

```text
http://<host>:8080/__gateway/admin
```

Signed in as an administrator, this route is also reachable from the shell itself:
the floating gateway controls gain a **用户管理** button next to 配置模型. A
non-administrator never sees it, because the route would only bounce them back to
the sign-in page.

From there an administrator can add, delete, enable, disable and re-password
accounts, and see every running dsh with its port, uptime, memory and request
count. Disabling or deleting an account stops its dsh immediately and revokes its
sessions, so the effect is instant rather than "when the cookie expires".

The last remaining administrator cannot be deleted. Repeated failed sign-ins are
throttled per client address and per user name.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--listen <port>` | `8080` | port to serve on |
| `--bind <address>` | `0.0.0.0` | interface to bind |
| `--spawn` | off | one dsh process per user (the product) |
| `--target <url>` `--token <t>` | �?| relay to one already-running dsh (prototype mode) |
| `--state <file>` | `./gateway-state.json` | gateway sessions |
| `--accounts <file>` | next to `--state` | account database |
| `--admin-password <pw>` | `admin12345` | initial administrator password |
| `--max-failures <n>` | `5` | failed sign-ins before a lockout |
| `--lockout-minutes <n>` | `5` | how long a lockout lasts |
| `--profile <name>` | `web` | dsh profile to boot |
| `--template <dir>` | none | optional DSH_HOME seeding each new account; omit it and dsh ships the profile (see *Every account starts clean*) |
| `--home-root <dir>` | next to `--state` | where per-user homes live |
| `--dsh-bin <path>` | `dsh` | executable to spawn |
| `--dsh-arg <arg>` | �?| argument before dsh's own flags (repeatable) |
| `--max-instances <n>` | `8` | hard cap on concurrent dsh processes |
| `--idle-minutes <n>` | `30` | stop an idle user's dsh |
| `--trusted-host <host>` | �?| extra authority dsh should accept (repeatable) |
| `--public-asset <path>` | �?| extra unauthenticated path to relay (repeatable) |

The gateway enumerates this machine's own addresses and passes them to every dsh
it starts, so plain LAN and phone access works without hand-written
`--trusted-host`. Name the host address explicitly only when a bridge network
hides it.

## Container environment variables

`docker/entrypoint.sh` maps these onto the flags above:

| Variable | Default |
| --- | --- |
| `DSH_GATEWAY_ADMIN_PASSWORD` | `admin12345` |
| `DSH_GATEWAY_TRUSTED_HOSTS` | `192.168.100.1` (comma-separated) |
| `DSH_GATEWAY_MAX_INSTANCES` | `8` |
| `DSH_GATEWAY_IDLE_MINUTES` | `30` |
| `DSH_GATEWAY_PROFILE` | `web` |
| `DSH_GATEWAY_HOST_PORT` | `8080` (published port only) |
| `DSH_GATEWAY_STATE` | `/srv/gateway/state.json` |
| `DSH_GATEWAY_HOME_ROOT` | `/srv/users` |

One volume holds everything stateful: `/srv/dsh` (the shared profile template),
`/srv/users/<account>` (private homes) and `/srv/gateway` (sessions and accounts).

Anything after the image name is passed straight to the gateway, so no flag is
out of reach:

```sh
docker run �?dsh-gateway --max-instances 3 --idle-minutes 5
```

## How a request flows

1. The browser signs in once and gets an opaque `dsh-gateway-session` cookie
   (`HttpOnly`, 30-day `Max-Age`, persisted so a gateway restart does not sign
   anyone out).
2. The gateway resolves that session to an account, lazily starting that
   account's dsh if it is not running, and reads the launch token from the dsh
   startup banner.
3. It mints dsh's own `dsh-auth-*` cookie once, server-side, and relays it as an
   opaque `__dsh_relay` handle. **A dsh credential never reaches the browser.**
4. Every later request is a plain relay with `Host` preserved, so dsh emits URLs
   the browser can actually reach.
5. If dsh ever rejects the cached credential, the gateway re-mints and retries
   once instead of stranding the page on a 401.

## Operational notes

- **HTTP, not HTTPS.** This is meant for a trusted LAN. Put it behind a reverse
  proxy with TLS if it is exposed further.
- **Each account's default workspace is private.** dsh would normally create
  `~/Documents/deepseek-harness/default-workspace`, which on one machine is the
  same folder for everybody and does not exist at all in a slim container. The
  gateway pins it to
  `<users>/<account>/workspace/deepseek-harness/default-workspace` instead, so
  the folder a user opens on first sign-in is their own.
- **Each account's model settings are private.** dsh saves the provider and
  model a user picks into `profiles/<name>/cordis.patch.yml` *inside `DSH_HOME`*,
  so each user gets their own real copy of the profile tree, not a link to the
  template. Sharing it silently made one user's saved provider the default for
  everyone �?measured with two real accounts before this became a copy.
- **Each account needs its own model API key**, because each account is a
  separate dsh with a separate credential store. dsh's own settings pages cannot
  load over a non-loopback origin (it grades page-host persistence to `memory`
  when `location.hostname` is not loopback, which is why the LAN page reports
  `settings are unavailable in this browser`). Sign in with the **配置模型**
  switch instead: the gateway writes the provider, the key reference and the
  default model into that user's own dsh over its loopback connection, where dsh
  validates them. Where a route's profile lives is dsh's answer, not the
  gateway's �?it writes `apiKeyEnv` at the `settingsNs`/`settingsPath` that
  `llm/listConfigurableProviders` reports for that route, so
  `deepseek-official` (whole section is the profile) and a pi-ai route
  (`settingsPath: ['providers', <route>]`) each land where they resolve from.
  Leaving the key field blank keeps the stored key and only re-points the route
  at it, which is also how a key saved before that path was fixed starts working.
  The **获取模型** button next to the model field asks that user's dsh for the
  route's models (`llm/discoverModels`, the same remote call dsh's own page
  makes), so a model id never has to be typed from memory; a route whose adapter
  registers no discovery still answers from the catalogue dsh already holds for
  it (`deepseek-official` reports `deepseek-flash` / `deepseek-v4-pro`).
  See [docs/DESIGN.md](docs/DESIGN.md).
- **The sign-in cookie is named after the authority the browser used.** Cookies
  ignore the port, so two gateways sharing one hostname (`home.example.com:2020`
  on a router, `:2021` on a workstation) would otherwise overwrite each other's
  sign-in and every request would answer `{"error":"unauthenticated"}`. Each
  authority gets `dsh-gateway-session-<hash>` instead, so the two never collide;
  reaching one instance by a second name asks for a second sign-in, which is the
  same semantics dsh's own `dsh-auth-*` cookie has. See
  [docs/DESIGN.md](docs/DESIGN.md).
- **Plugins installed by a user stay that user's own.** `dsh plugin add` and the
  plugin manager write into `profiles/`, which is a real per-user copy; only the
  installation trees (`node_modules`, `dsh-runtimes`) are symlinked and shared.
  A new account therefore starts with the shipped profile only �?and with the
  plugin manager, so it can install what it wants.
- **Reverse proxies and extra hostnames work with no configuration.** dsh's
  browser-trust fence accepts only loopback plus authorities it was told about at
  startup, so a name it has never seen answers every `/api/*` call with 403 while
  the page itself loads. When that happens the gateway grants the hostname to
  that one account and restarts that account's dsh once, then replays the
  request. Add `--trusted-host` up front only if you would rather avoid the
  one-time restart.
- **Sign out** is the button in the gateway's own header, which appears on the
  settings page and injected into dsh's workspace top bar. It lands on the
  sign-in page and stops that account's dsh at the same time, so signing out and
  in again is also how a user restarts their own instance; anything durable is in
  their home, and a tab that is still signed in re-mints automatically.
- **Idle reaping** stops a user's dsh after `--idle-minutes`; the next request
  starts a fresh one. Sessions live in that user's own home, so nothing is lost.
- **`/healthz`** is unauthenticated and reports the live instance count, for
  container orchestration.

## Tests

```sh
node test-gateway.mjs   # 71 checks: the relay contract and gateway pages
node test-spawn.mjs     # 63 checks: per-account isolation and accounts
```

`test-gateway.mjs` drives the gateway against a fake dsh and covers durable
cookies, restart survival, stale-credential recovery (including a replayed POST
body), the no-token failure path, credential-less static assets, safe
post-sign-in redirects, the sign-in mode switch, the injected sign-out control,
and the model-configuration RPC path. `test-spawn.mjs` covers the thing the
product exists for: two accounts never reach each other's data, each account's
default workspace is pinned inside its own home, saved model settings cannot
leak between accounts, the instance cap evicts rather than refuses,
disabling stops a dsh at once, idle instances are reaped, passwords are stored
only as scrypt digests, accounts survive a gateway restart, and repeated
guessing is locked out per client.

[docs/DESIGN.md](docs/DESIGN.md) records the investigation these decisions rest
on �?in particular why a plugin cannot isolate users, and why the LAN trust
fence behaves the way it does.
