# dsh-external-guard

DSH 外部服务健康与日志面板，可通过本地配置登记和显式启停服务。默认 `monitorOnly: true`，不自动启动任何服务；未提供模型工具，`dependsOn` 只展示依赖。

**0.2.0 发行预览，尚未发布 npm。** 已在独立 profile 的正式 DSH Web 宿主完成只监测验收，见文末记录。MIT，完整许可见 [LICENSE](LICENSE)。

## 从 npm 安装到 DSH

在终端运行下面的命令。把 `web` 换成你实际使用的 DSH profile。DSH 会安装依赖并登记插件 bundle，重新加载该 profile 后生效。

```powershell
dsh plugin --profile web add @r-xuan/dsh-external-guard
```

如果这个 profile 已经链接了旧版 `dsh-external-guard`，请先移除旧的 bundle 登记和依赖，再安装新包，以免重复加载。

## 支持范围

- 目标平台为 Windows；端口反查和停止进程使用 Windows 原生命令。其它操作系统不在支持范围内。
- Node.js 要求 >=22，本轮离线验证使用24.22.2；最低Node22、第二台机器尚未验收。客户端React由DSH提供，无需另装。
- DSH需提供 `webServer`、客户端 `__ModuleLoader__` 和 slots 服务。已验证 DSH CLI 0.2.2-rc.1 的 Web profile。桌面宿主集成及其它 DSH 版本尚待验收。
- 内置条目为 Ollama、SnowLuma、surfcore bridge。这些外部程序需自行安装；本插件不下载程序、模型或账户数据，也不提供它们的分发授权。
- 与surfcore等自动保活并用时保持只监测；开启手动启停前先明确保活归属，避免停止后又被拉起。

## 先做纯离线自检

下载公开源码归档或发行预览并解压，打开该目录。零第三方运行时依赖，无编译步骤，不需要 `npm install`。

```powershell
npm run check
npm test
```

`npm test`（与 `npm run test:config` 相同）使用VM伪宿主、合成日志和伪执行器，**不探测真实服务、不发外部请求、不执行真实进程**。测试fixture默认写系统临时目录，也可指定：

```powershell
$env:DSH_GUARD_TEST_CACHE = 'D:\GuardChecks'
npm test
```

VM Modules的ExperimentalWarning来自测试隔离，不是测试失败。`npm run test:local`是另一个**可选本机诊断**：它会探测回环服务并读取配置目录的真实日志，不启动/停止服务，不能把它当纯离线测试。

## 独立安装到DSH（手动步骤，离线测试不会执行）

1. 保留稳定的源码解压路径。确认实际使用的profile，本例为 `$env:USERPROFILE\.dsh\profiles\desktop`，不要根据名称猜正在使用的profile。
2. 在退出宿主或安排维护窗口前，备份该profile的package.json，记下已有依赖、bundle和链接目标。如果仍安装旧包名，先规划旧项退出，不同时加载两个版本。下列代码片段应合并到现有结构中，不能覆盖整个package.json：

```jsonc
{
  "dependencies": {
    "@r-xuan/dsh-external-guard": "link:D:/Plugins/dsh-external-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["@r-xuan/dsh-external-guard"]
    }
  }
}
```

3. `link:`使用刚才的真实绝对路径。Windows中为profile的node_modules建立链接（在解压目录执行，将profile按实际情况调整）：

```powershell
$guardSource = (Resolve-Path -LiteralPath '.').Path
$guardProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$guardLink = Join-Path $guardProfile 'node_modules\@r-xuan\dsh-external-guard'
if (Test-Path -LiteralPath $guardLink) { throw '链接已存在，先核实旧目标，不覆盖' }
New-Item -ItemType Directory -Path (Split-Path -Parent $guardLink) -Force
New-Item -ItemType Junction -Path $guardLink -Target $guardSource
```

4. 配置使用本包的 `cordis.patch.yml` 中现有插件 `config`。不要在profile的patch再次插入同id，否则可能重复注册。首次保留只监测，必要时设置 `pollIntervalMs: 0` 关闭后台巡检。
5. 在维护窗口重启宿主；源码/宿主模块不靠面板刷新热更新。检查加载日志、新名侧栏和状态/日志卡片。仅面板能打开或端口健康不等于真实启停验收，不要为验收而随意关闭业务服务。

## 配置

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `pollIntervalMs` | 15000 | 后台巡检间隔，0关闭后台巡检 |
| `probeTimeoutMs` | 1200 | 单项探测超时 |
| `monitorOnly` | true | 禁止启停，面板隐藏操作按钮 |
| `writesEnabled` | true | HTTP写开关，false时拒绝启停 |
| `entries` | 不填 | 按id覆盖内置项或添加服务 |

只有 `monitorOnly: false` **且** `writesEnabled: true` 才允许显式启停，新增服务也受此限制。

### 覆盖路径及新增服务

无需改 `manifest.js`。在本包 `cordis.patch.yml` 现有插件的 `config:` 下加入 `entries:`；
下面展示的是 **config 内容**，不要另外插入同 id 插件。配置变化后需重启宿主才生效。

```yaml
monitorOnly: true
writesEnabled: true
entries:
  - id: ollama
    start:
      exec: 'D:\Apps\Ollama\ollama app.exe'
      cwd: 'D:\Apps\Ollama'
      args: [hidden]
    probes:
      - kind: port
        port: 11434
      - kind: http
        url: 'http://127.0.0.1:11434/api/tags'
    stopPorts: [11434]
    logSources:
      - label: Ollama 服务日志
        dir: 'D:\Data\Ollama'
        pattern: '^server(-\d+)?\.log$'
  - id: my-service
    title: 我的服务
    probes:
      - kind: http
        url: 'http://127.0.0.1:8080/health'
    start:
      exec: 'D:\Apps\node.exe'
      args: ['D:\Services\server.js']
      cwd: 'D:\Services'
    stopBy: ports
    stopPorts: [8080]
    logSources:
      - label: 服务日志
        dir: 'D:\Services\logs'
        pattern: '^service-.*\.log$'
```

合并和校验规则：

- 不填 `entries` 或填 `[]` 保留三个内置服务。内置 id 按原顺序覆盖，新 id 追加；新服务至少提供非空 `probes`，省略 `title` 时显示 id。每个 id 在配置数组中只能出现一次。
- 条目顶层按字段覆盖；`start` 按 `exec/args/cwd/env` 字段合并。数组（包括 `args/probes/stopPorts/stopNames/dependsOn/logSources`）整体替换，`start.env` 整体替换，不做递归合并；省略字段继承原值。
- `start: null` 移除启动命令，仍可监测和显式停止；`start.cwd: null`、`start.env: null` 清除继承的条目配置（不会删除宿主进程原有环境变量）。空日志数组关闭该条目的真实日志来源；清空 `stopNames` 可移除内置的按镜像名停止兜底。`start.args: []` 清空原参数。
- id 只允许小写字母、数字、下划线和连字符，首位必须是字母或数字，最长64字符；最多100条配置。未知字段、重复id、未知依赖id或类型错误均报错，新增合法id并不算错误。
- `start.exec/cwd` 和 `logSources.dir` 使用绝对路径，不展开 `%变量%`、`~`。`args` 是字符串数组，可使用相对脚本路径（按 cwd 解析）；`env` 是字符串键值表。`probes` 支持 `{kind: port, port: 8080}`、`{kind: http, url: 'http://localhost:8080/health'}`、`{kind: process, name: 'service.exe'}`；端口为1–65535。
- 日志 `pattern` 是 JavaScript 正则的**源字符串**，不写 `/.../` 分隔符或 flags；YAML用单引号保留反斜杠。`stopBy` 支持 `ports/name`；`stopNames` 为不含路径、通配符的镜像名数组。`dependsOn` 只展示，不编排启动。
- 任一条配置无效时，该插件实例的**整份清单停用**，状态返回 `configurationErrors`，面板显示字段级诊断。不会悄悄使用旧启动命令；修正配置并重启后恢复。存在性或文件/目录类型不符则仅该服务 `available/canStart=false`，启动也会拒绝。
- 配置在加载时为每个实例独立生成；status、日志、探测、巡检和启停均读取该清单。HTTP仍只按已登记id操作，不能传入或覆盖 exec、args、日志目录；新增服务同样受只监测和写开关约束。

这份配置可执行本地程序，也能读取指定日志，应仅由本机受信用户编辑。不要公开含真实凭据的 `start.env`。

### 内置路径和bridge

Ollama安装目录默认取 `%LOCALAPPDATA%\Programs\Ollama`，日志取 `%LOCALAPPDATA%\Ollama`；SnowLuma取 `%LOCALAPPDATA%\SnowLuma`。可用上方配置覆盖非标准安装。

**bridge默认没有启动命令**，只探测回环3100端口；`SURFCORE_HOME`仅用于默认 `state/bridge.log` 路径，不会拼接脚本入口。若需要手动启动，必须在 `entries` 中提供自己已验证的绝对exec、args和cwd。没有可启动入口时 `canStart=false`，不代表服务无法被其它插件启动。

### 安全边界

HTTP只允许回环地址、合法本地Host和同源Origin；HTTP只传id，不能指定命令或日志目录。HTTP健康探测只接受回环URL，不跟随重定向；2xx/3xx判为健康。端口探测仅证明监听，不能证明应用业务、唯一实例或账户登录正常。启动使用detached/windowsHide和落盘stdio；第三方程序的子进程窗口行为仍需单独验收。

`/status`返回有效items和 `configurationErrors`；`/logs?id=`返回服务真实日志sources及捕获stdout/stderr。日志内容可能含私人信息，不要把它们原样提交到公开仓库。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/dsh-external-guard/status` | 健康、可用性及配置诊断 |
| GET | `/dsh-external-guard/logs?id=` | 指定已登记服务的日志尾部 |
| POST | `/dsh-external-guard/start` | 仅接受已登记id，只监测时403 |
| POST | `/dsh-external-guard/stop` | 仅接受已登记id，只监测时403 |

## 故障排查

- 找不到侧栏或404：核对实际profile、bundle、Junction目标和宿主加载日志，确认加载的是新名；避免新旧包同时注册。不要先改凭据或执行启停。
- 状态有 `configurationErrors`：修正标明的字段；整份实例清单暂时停用，修正后安排重启。空列表不能当作“所有服务已停止”。
- `available=false`：看missing路径，确认exec是文件、cwd是目录、脚本相对cwd存在。只监测服务可设 `start: null`，不再依赖启动文件存在。
- 日志为空：确认 `logSources.dir`、正则和服务真实日志文件；外部工具启动的服务不一定有本插件捕获stdout。配置日志不自动创建服务日志。
- 启停403：检查两个开关，这是默认防护。停止后又启动：先核对其它保活机制，不要连续重复结束进程。
- 401或宿主未加载：属于宿主接入/鉴权问题，离线伪宿主测试不能证明该链路已通过。

## 卸载与回退（手动维护窗口）

先停止宿主加载本插件，从对应profile中移除本包dependency和bundle；若另有插件插入项，仅移除本包项。确认node_modules项确为本包Junction后，只移除该链接，**不递归删除其目标源码**。重启后核对本包路由/侧栏退出；这不会停止外部业务进程，也不删除它们的数据。

回退时恢复之前备份的profile片段和已记录链接目标，关闭新名加载并恢复旧名加载，再在维护窗口重启。升级后的配置字段不应不加核对地套给旧包。不要把发行预览目录当作长期编辑源。

## 公开预览与验证边界

公开文件包括运行源码、测试、LICENSE和脱敏DEVLOG；不包含原Git历史、私人开发流水、会话材料、真实配置或日志。DEVLOG公开版由 `docs/DEVLOG.public.md` 生成。

维护者可在本源码目录运行以下命令，输出必须是源码目录外尚不存在的绝对目录：

```powershell
node scripts/prepare-preview.mjs --out 'D:\Releases\guard-preview-new'
```

工具按允许清单生成文件、`RELEASE-MANIFEST.json`和 `SHA256SUMS`，扫描命中时只报文件/行号/类别，不打印值。它不创建Git仓库，不改原历史，也不推送。SHA256SUMS列出除自身外的所有候选文件；模式扫描不能证明绝无敏感信息。不要把私人原仓库直接推送公开。

离线测试覆盖配置合并/新增、实例隔离、错误诊断、统一清单、默认写防护、伪面板items和启动错误处理。

### 2026-11-20 · 正式 DSH Web 宿主验收

在 Windows 上使用正式 DSH CLI 0.2.2-rc.1，以独立 profile 加载本候选及官方 Web 组合包。保留默认只监测开关，关闭后台巡检。

| 检查 | 实测结果 |
| --- | --- |
| 服务清单 | 状态接口返回 200，包含三个内置服务和一个合成配置服务，配置错误为空。 |
| 日志 | 日志接口返回 200，读回的合成服务日志与测试文件逐字节一致。 |
| 写操作保护 | 启动、停止均返回 403 和 monitor-only。 |
| 面板资源 | 正常登录后首页返回 200，启动清单登记了插件，宿主给出的版本化脚本资源返回 200 并包含候选客户端代码。 |

本次验证覆盖真实 Web 宿主的加载、接口和面板资源交付。桌面端实际界面点击、业务服务启停与隐藏窗口、第二台机器和最低 Node 22 仍待验收。

## 许可

[MIT License](LICENSE)，Copyright (c) 2026 dsh-external-guard contributors。
