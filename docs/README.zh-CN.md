# dsh-gateway（中文文档）

**登录一次，这个 dsh 就只属于你。**

> 英文文档（默认）：[README.md](../README.md) ｜ 设计说明：[DESIGN.md](DESIGN.md)

## 为什么需要它

dsh 的 Web GUI 是一个单用户应用。它的会话存储位于 `$DSH_HOME/sessions`，
按*工作区路径*而不是按用户来组织，所以两个人连到同一个 dsh 进程时，看到的是
同样的会话。这是实测结论：同一进程上的两个不同登录，列出的是同样的 43 条会话。

这不是插件能修复的问题，因为这个存储属于进程本身。再多的认证也改变不了门后
存在哪些数据。比如一个加扫码配对门禁的插件，回答的是*谁可以进*——而每一部
配过对的手机看到的仍然是同样的会话。

所以隔离必须是结构性的：**每个账号一个 dsh 进程，每个进程有自己的
`DSH_HOME`**。本网关就是让这件事对用户不可见的前门。

```text
              ┌─────────────────────────────────────────────┐
  浏览器 ───▶ │  gateway :8080                              │
  (局域网/手机)│  · 登录页、会话、管理控制台                    │
              │  · 每账号一个 dsh 进程，按需启动               │
              └───────┬───────────────┬─────────────────────┘
                      │               │
              ┌───────▼──────┐ ┌──────▼───────┐
              │ dsh (alice)  │ │ dsh  (bob)   │   ...上限 --max-instances
              │ :临时端口     │ │ :临时端口     │
              │ DSH_HOME=    │ │ DSH_HOME=    │
              │  .../alice   │ │  .../bob     │
              └──────────────┘ └──────────────┘
```

默认情况下，每用户家目录从*空目录*开始——dsh 首次启动时会在里面落地自己自带
的 profile，因此里面只可能包含该账号自己安装或保存的内容。如果传入
`--template`，模板里的安装树会被链接（Windows 上是 junction，其他平台是符号
链接），因为它们不含用户数据；而 `profiles/` 是每用户**真实拷贝**——dsh 会把
用户选的 provider 和模型保存到 `DSH_HOME` 里的
`profiles/<name>/cordis.patch.yml`，共享这个目录会让一个人的设置变成所有人的
默认值。`sessions/`、`storages/`、`logs/`、`attachments/` 和
`.credentials.yaml` 被**刻意**不播种，在各用户自己的家目录里全新创建。这就是
隔离。

## 快速上手

### Docker

官方镜像发布在 GHCR。用 `docker compose`：先把
[`.env.example`](../.env.example) 复制为 [`docker-compose.yml`](../docker-compose.yml)
旁边的 `.env` 并编辑：

```sh
DSH_GATEWAY_ADMIN_PASSWORD='choose-something' \
DSH_GATEWAY_TRUSTED_HOSTS=192.168.100.1 \
docker compose up -d
```

或者用裸 `docker run`：

```sh
docker run -d --name dsh-gateway -p 8080:8080 \
  -v dsh-gateway-data:/srv \
  -e DSH_GATEWAY_ADMIN_PASSWORD='choose-something' \
  -e DSH_GATEWAY_TRUSTED_HOSTS=192.168.100.1 \
  --restart unless-stopped \
  ghcr.io/agaoaagao/dsh-gateway:latest
```

想从源码构建镜像，克隆本仓库后执行 `docker compose up -d --build`（或
`docker build -t dsh-gateway .`）。

打开 `http://<docker-host>:8080/`，以 `admin` 登录。

`DSH_GATEWAY_TRUSTED_HOSTS` 是**浏览器**用来访问网关的地址，逗号分隔。桥接
网络下必填：dsh 拒绝它不信任的 authority 的 API 调用，而且只能枚举自己容器
内的接口，宿主机的局域网地址不在其中。不带端口的条目匹配任意端口。

### 裸 Node

```sh
node gateway.mjs --spawn \
  --listen 8080 --bind 0.0.0.0 \
  --home-root /srv/dsh-users \
  --state /srv/gateway/state.json
```

零依赖、无需构建——全部是 Node 标准库。

### 每个账号自动从干净状态开始

无需构建：不传 `--template`，新账号的家目录就是一个空目录。dsh 首次启动时会把
*它*自带的 profile 落地进去，该账号随之获得 dsh 自带的插件管理器，用户可以在
界面里把想要的东西装进自己那份 `profiles/` 拷贝。已有账号永远不会被重新播种
——把家目录改名或删掉才会重建。

`--template` 只用于"所有账号都*应该*以同一套预装内容开始"的场景。把它指向你
自己的 `~/.dsh`，每个账号就继承你的插件、你的市场数据库和你保存的模型设置——
而这恰恰是一个账号最不该看到另一个账号的东西。

### Windows 上，不用服务管理器

同样的命令行在 Windows 上可用。只有一个区别需要注意：传 `--template` 时，播种
的 profile 树里包含 junction/符号链接，网关会把它们按链接复现，而不是解引用
成完整拷贝（见 [DESIGN.md](DESIGN.md)）。

开机自启动的一种做法：把启动命令写进
`启动` 文件夹里的一个 `.vbs`（用 `wscript.exe` 隐藏窗口执行），由一个循环脚
本充当监督进程：进程退出就追加一行日志并重启，崩溃总是留有两份记录——网关自
己的 `uncaughtException` 处理器一份，监督进程的重启行一份。

每个账号的成本只是它存储的东西：不带 `--template` 时家目录为空，dsh 引导出一
个很小的 profile，新账号只有几 KB。只有当模板带着装满插件的
`profiles/*/node_modules` 时，才需要按账号预留可观的磁盘空间。

## 账号与管理控制台

首次启动会播种一个管理员：`admin` / `admin12345`。**请立刻改掉。**然后打开
控制台：

```text
http://<host>:8080/__gateway/admin
```

以管理员登录后，这个入口也能从 dsh 界面本身到达：悬浮的网关控件里会在"配置模
型"旁多出一个**用户管理**按钮。非管理员永远看不到它，因为该路由只会把他弹回
登录页。

管理员可以在这里添加、删除、启用、禁用账号和重设密码，并看到每个运行中的
dsh 及其端口、运行时长、内存和请求数。禁用或删除账号会立刻停掉它的 dsh 并吊
销其会话——效果是即时的，而不是"等 cookie 过期"。

最后一个管理员不能被删除。反复登录失败会按客户端地址和用户名分别限流锁定。

## 选项

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `--listen <port>` | `8080` | 服务端口 |
| `--bind <address>` | `0.0.0.0` | 绑定接口 |
| `--spawn` | 关 | 每用户一个 dsh 进程（正式模式） |
| `--target <url>` `--token <t>` | — | 中继到一个已在运行的 dsh（原型模式） |
| `--state <file>` | `./gateway-state.json` | 网关会话 |
| `--accounts <file>` | `--state` 旁边 | 账号数据库 |
| `--admin-password <pw>` | `admin12345` | 初始管理员密码 |
| `--max-failures <n>` | `5` | 锁定前的失败次数 |
| `--lockout-minutes <n>` | `5` | 锁定时长 |
| `--profile <name>` | `web` | 启动的 dsh profile |
| `--template <dir>` | 无 | 可选的、用于播种新账号的 DSH_HOME；不传则由 dsh 自带 profile（见*每个账号自动从干净状态开始*） |
| `--home-root <dir>` | `--state` 旁边 | 每用户家目录的根 |
| `--dsh-bin <path>` | `dsh` | 要启动的可执行文件 |
| `--dsh-arg <arg>` | — | 传在 dsh 自身参数之前的参数（可重复） |
| `--max-instances <n>` | `8` | 并发 dsh 进程的硬上限 |
| `--idle-minutes <n>` | `30` | 空闲多久后停掉该用户的 dsh |
| `--trusted-host <host>` | — | 额外让 dsh 信任的 authority（可重复） |
| `--public-asset <path>` | — | 额外免认证中继的路径（可重复） |

网关会枚举本机自身的地址并传给它启动的每一个 dsh，所以普通局域网和手机访问
不需要手写 `--trusted-host`。只有在桥接网络遮住了宿主机地址时才需要显式指定。

## 容器环境变量

`docker/entrypoint.sh` 把这些变量映射到上面的参数：

| 变量 | 默认值 |
| --- | --- |
| `DSH_GATEWAY_ADMIN_PASSWORD` | `admin12345` |
| `DSH_GATEWAY_TRUSTED_HOSTS` | `192.168.100.1`（逗号分隔） |
| `DSH_GATEWAY_MAX_INSTANCES` | `8` |
| `DSH_GATEWAY_IDLE_MINUTES` | `30` |
| `DSH_GATEWAY_PROFILE` | `web` |
| `DSH_GATEWAY_HOST_PORT` | `8080`（仅发布端口） |
| `DSH_GATEWAY_STATE` | `/srv/gateway/state.json` |
| `DSH_GATEWAY_HOME_ROOT` | `/srv/users` |

一个卷装下所有有状态内容：`/srv/dsh`（共享 profile 模板）、
`/srv/users/<account>`（私有家目录）和 `/srv/gateway`（会话与账号）。

镜像名之后的参数原样传给网关，所以任何参数都触手可及：

```sh
docker run … dsh-gateway --max-instances 3 --idle-minutes 5
```

## 一个请求的完整流程

1. 浏览器登录一次，拿到一个不透明的 `dsh-gateway-session` cookie
   （`HttpOnly`，30 天 `Max-Age`，持久化存储，网关重启不会把人登出）。
2. 网关把该会话解析为一个账号，按需启动该账号的 dsh，并从 dsh 启动横幅里读
   取 launch token。
3. 它在服务端一次性铸出 dsh 自己的会话凭证，并以不透明句柄转发。
   **dsh 凭证永远不会到达浏览器。**
4. 之后的每个请求都是普通中继，`Host` 保持原样，因此 dsh 生成的 URL 是浏览
   器真正可达的。
5. 如果 dsh 某次拒绝了缓存的凭证，网关会重铸并重试一次，而不是把页面卡在
   401 上。

## 运维须知

- **是 HTTP，不是 HTTPS。**它面向受信任的局域网。要暴露到更外面，请在前面放
  一个带 TLS 的反向代理。
- **每个账号的默认工作区是私有的。**dsh 通常会创建
  `~/Documents/deepseek-harness/default-workspace`，在同一台机器上这是所有人
  共用的同一个目录，在精简容器里则根本不存在。网关把它固定到
  `<users>/<account>/workspace/deepseek-harness/default-workspace`，用户首次
  登录打开的就是自己的目录。
- **每个账号的模型设置是私有的。**dsh 把用户选的 provider 和模型保存到
  `DSH_HOME` 里的 `profiles/<name>/cordis.patch.yml`，所以每个用户拿到的是
  profile 树的真实拷贝而不是指向模板的链接。共享它会让一个用户保存的
  provider 成为所有人的默认值。
- **每个账号需要自己的模型 API key**，因为每个账号是独立的 dsh、独立的凭证
  存储。dsh 自己的设置页面无法在非回环源上加载，这正是局域网页面提示
  "settings are unavailable in this browser" 的原因。请改用**配置模型**开
  关：网关通过该用户 dsh 的回环连接把 provider、key 和默认模型写进去，由 dsh
  做真实验证。key 字段留空则保留已存的 key、只把路由重新指向它。模型字段旁
  的**获取模型**按钮向该用户的 dsh 询问该路由的模型列表，模型 id 无须凭记忆
  输入。详见 [DESIGN.md](DESIGN.md)。
- **登录 cookie 以浏览器使用的 authority 命名。**cookie 不区分端口，所以共
  用一个主机名的两个网关（路由器上的 `home.example.com:2020`、工作站上的
  `:2021`）会互相覆盖登录态，每个请求都会答
  `{"error":"unauthenticated"}`。每个 authority 得到自己的
  `dsh-gateway-session-<hash>`，互不冲突；用第二个名字访问同一实例会要求再
  登录一次，这与 dsh 自己会话 cookie 的语义一致。详见
  [DESIGN.md](DESIGN.md)。
- **用户装的插件只属于该用户。**`dsh plugin add` 和插件管理器写进
  `profiles/`，那是每用户真实拷贝；只有安装树（`node_modules`、
  `dsh-runtimes`）是链接共享的。新账号因此只带出厂 profile 启动——并且带插
  件管理器，想装什么自己装。
- **反向代理和额外主机名零配置可用。**dsh 的浏览器信任围栏只放行回环加启动
  时告知的 authority，没见过的主机名会让每个 `/api/*` 调用答 403 而页面本
  身正常加载。发生这种情况时，网关把该主机名授予该账号并重启一次它的 dsh，
  然后重放请求。如果不想承担这一次性重启，可以预先加 `--trusted-host`。
- **登出**是网关自己页头上的按钮，出现在设置页并被注入 dsh 的工作区顶栏。它
  落回登录页并结束浏览器会话——但**刻意不停掉该账号的 dsh**，因为里面的定时
  任务和自动化必须能在登出后继续跑。要真正重启进程，用它旁边的**重启 dsh**
  按钮：停掉该账号的实例，下一个请求会针对同一个家目录启动全新进程。管理员
  也可以在控制台停任何实例，禁用或删除账号仍然立即停掉它的 dsh。
- **空闲回收**在 `--idle-minutes` 之后停掉用户的 dsh；下一个请求会启动新的。
  会话在该用户自己的家目录里，什么都不会丢。如果某账号跑定时任务，把
  `--idle-minutes` 调大，让进程活过任务之间的空闲间隔。
- **`/healthz`** 免认证，报告存活实例数，供容器编排使用。

## 测试

```sh
node test-gateway.mjs   # 71 项检查：中继契约与网关页面
node test-spawn.mjs     # 66 项检查：按账号隔离与账号管理
```

`test-gateway.mjs` 用一个假 dsh 驱动网关，覆盖持久 cookie、重启存活、失效凭
证恢复（包括重放 POST body）、无 token 失败路径、免凭证静态资源、登录后安全
重定向、登录模式切换、注入的登出控件，以及模型配置 RPC 路径。
`test-spawn.mjs` 覆盖这个产品存在的理由：两个账号永远碰不到对方的数据、每个
账号的默认工作区被固定在自己的家目录内、保存的模型设置不会在账号间泄漏、实
例上限是驱逐而不是拒绝、禁用立刻停掉 dsh、空闲实例被回收、密码只以 scrypt
摘要存储、账号在网关重启后存活、反复猜测按客户端锁定。

[DESIGN.md](DESIGN.md) 记录了这些决定所依赖的调研——尤其是为什么插件无法隔
离用户，以及局域网信任围栏为什么是这样表现的。

## 参与贡献

欢迎提交 Pull Request——开发环境与约定见
[CONTRIBUTING.md](../CONTRIBUTING.md)（不引入新依赖；README 只描述可观察行为，
不写 dsh 内部细节）。安全问题请通过
[私有漏洞上报](https://github.com/agaoaagao/dsh-gateway/security)提交，不要开
公开 issue。本项目遵循
[贡献者公约](../CODE_OF_CONDUCT.md)。
