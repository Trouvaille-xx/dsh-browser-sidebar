# dsh-browser-sidecar 插件手册

> 交付物：`packages/dsh-browser-sidecar/`（Host-only 插件）+ `scripts/install-sidecar.mjs`（安装/备份/回滚脚本）。
> 对应规格：`docs/browser-sidebar-spec.md` §2。Chrome 扩展在 `extension/`（另一条工作流）。

---

## 1. 它解决什么问题

Chrome side panel 里的 iframe 想直接嵌 `http://127.0.0.1:4064/`（官方 DSH Web UI）会遇到两堵墙：

1. **鉴权**：DSH Web 用 `HttpOnly` + `SameSite=Strict` 的 cookie（名 `dsh-auth-<sha256(authority)>`），
   且 cookie 的 audience 绑定请求的 `Host` authority。iframe 的文档源是 `chrome-extension://<id>`，
   属于第三方上下文，浏览器既不会带这个 cookie，也不允许 `chrome-extension://` 的跨站请求。
2. **CSRF fence**：上游 `/api/*` 与 WebSocket 升级会检查 `Host` 必须是 loopback/受信 authority、
   `sec-fetch-site: cross-site` 直接 403、带 `Origin` 时其 host 必须等于 `Host`。

`dsh-browser-sidecar` 的做法：**由 Host 插件自己起一个 loopback 反向代理**，让 iframe 的文档源变成
`http://127.0.0.1:41789`，代理在服务端把 launch token 换成 cookie 并注入每个转发请求。
浏览器侧不需要任何 cookie 技巧、不需要 `cookies` 权限、不依赖 DSH 内核改动。

```
Chrome (用户浏览器)
├─ Side Panel (chrome-extension://<id>/sidepanel.html)
│   └─ iframe → http://127.0.0.1:41789/        ← 文档源 = sidecar 源（同源，无第三方 cookie 问题）
├─ Content Script / Service Worker
│   └─ POST http://127.0.0.1:41789/__bridge/context   ← CORS 允许 chrome-extension://*
│
DSH Host 进程（desktop / web profile）
└─ dsh-browser-sidecar 插件
    ├─ node:http 服务器 127.0.0.1:41789（仅 loopback）
    │   ├─ /__bridge/*  → Bridge API（内存上下文仓库，CORS 白名单）
    │   └─ 其它路径     → 反向代理 → 127.0.0.1:4064（Host 保留 :41789，注入 Cookie）
    │                        └─ WebSocket upgrade → 手工握手 + 双向裸 socket pipe
    ├─ browser_page 工具（读内存快照，返回有界文本）
    └─ 系统提示片段（≤5 行，告诉 agent 何时读浏览器上下文）
```

---

## 2. 鉴权原理（实现依据）

源码事实（`@deepseek-ai/dsh-client-connection`）：

| 事实 | 出处 |
| --- | --- |
| cookie 名 = `dsh-auth-` + base64url(sha256(authority))，authority 来自请求 `Host` 头 | `lib/index.js` → `requestAuthority()` / `cookieName()` |
| `GET /?token=<launchToken>` → `303` + `Set-Cookie`，cookie 带 `HttpOnly; SameSite=Strict` | `BrowserAuth.authorizeIndex()` |
| `/api/*` 先 `isTrustedApiRequest()`（Host 必须 loopback/trustedHosts；`sec-fetch-site: cross-site` → 403；`Origin` 若存在其 host 必须等于 `Host`），再验 cookie | `HostConnectionService.requestRejection()` |
| 公开方法 `authenticatedUrl(baseUrl)` 返回带**进程级 launch token** 的根 URL | `HostConnectionService.authenticatedUrl()` |

插件的 token 交换流程（`proxy.js`）：

1. `ctx.inject(['connection'], …)` 拿到 `connection` 服务后，用
   `connection.authenticatedUrl('http://127.0.0.1:<实际端口>/')` 得到 `http://127.0.0.1:41789/?token=…`；
2. 用 `node:http` 直连上游 `127.0.0.1:4064` 请求该路径，**手动设置 `Host: 127.0.0.1:41789`**
   （这样上游签发的 cookie 名/audience 绑定的是 sidecar 的 authority，而不是 4064）；
3. 从 `303` 的 `Set-Cookie` 里取出 `名称=值`，缓存在内存，之后所有转发请求注入 `Cookie`；
4. 失败时按指数退避重试（默认 1s / 2s / 5s / 10s / 峰值 30s），成功后标记 `authReady`；
5. 上游返回 `401`（cookie 过期/密钥轮换）时**重新交换一次并重放该请求**（请求体 ≤1 MB 会缓冲以保证可重放）。

请求头改写规则（转发到上游时）：

| 头 | 处理 |
| --- | --- |
| `Host` | 固定为 `127.0.0.1:<sidecar 端口>`（cookie 绑定它；客户端用 localhost 访问也能工作） |
| `Cookie` | 注入 token 交换得到的 cookie（覆盖客户端自带的） |
| `sec-fetch-site` | 改写为 `same-origin`（否则 iframe 首次导航是 `cross-site`，上游 403） |
| `Origin` | 改写成 `http://127.0.0.1:<sidecar 端口>`（浏览器同源时本来就相等；跨源时保证 fence 通过） |
| `Referer` | 保留；host 不匹配时改写到 sidecar 源，无法解析则丢弃 |
| `accept-encoding` | 原样透传；响应 gzip **不解压**，`content-encoding` 原样回传 |
| `connection` / `keep-alive` / `transfer-encoding` / `upgrade` 等逐跳头 | 普通 HTTP 转发时丢弃（由 node 重新分块）；WS 升级时保留 |

流式与长连接：请求体/响应体全程 `pipe`，不整体缓冲；`requestTimeout=0`、`keepAliveTimeout=65s`，
SSE 逐条下发；上游响应写入后 `flushHeaders()`。WebSocket：`server.on('upgrade')` → `net.connect`
手工写 upgrade 请求（注入 `Host`/`Cookie`/改写后的 `Origin`，保留 `Sec-WebSocket-*`）→ 先把上游的
`101` 响应原样 pipe 给客户端，之后双向裸 socket pipe；`head` 先行字节也会补发。

为什么 iframe 同源方案成立（读源码确认，不是假设）：

- 客户端 bundle 的 URL 是**相对路径**（`dsh-client-modules` 生成 `/plugins/??…&rev=…`），
  浏览器按 iframe 文档源（`127.0.0.1:41789`）解析 → 全部经代理；
- WebSocket 地址由 `dsh-api-gateway` 的 `remoteStreamUrl()` 从 **`location.origin`** 推导
  （`ws(s)://<当前 origin>/api/remote.mux`）→ 也指向代理；
- 因此 DSH 前端里没有任何硬编码的 `127.0.0.1:4064`，只要代理源稳定即可。

---

## 3. 配置项

`packages/dsh-browser-sidecar/cordis.patch.yml`（安装后位于 profile 的 bundle 层）：

```yaml
- insert:
    - id: browser-sidecar
      name: dsh-browser-sidecar
      config:
        port: 41789          # sidecar 监听端口，仅绑定 127.0.0.1；0 = 随机端口（测试用）
        # upstreamPort: 0    # 省略/0 = 自动从宿主 ctx.webServer.port 发现（推荐）
        #                    # 非 0 数字 = 钉死上游端口，不再自动发现
        # upstreamHost: 127.0.0.1   # 可选，默认 127.0.0.1
```

> **上游端口为什么必须自动发现**：DSH 桌面应用启动 Web UI 时硬编码 `--port 0`（端口由 OS 每次随机分配），所以 `upstreamPort: 4064` 只在手动 `dsh web --port 4064` 时成立。插件用 `ctx.inject(['webServer'])` 读取真实端口，发现后自动重新做一次 token 交换；配置里写大于 0 的数字才会钉死。

- 端口只绑 `127.0.0.1`，不监听 `0.0.0.0`，不对局域网暴露。
- 改端口后扩展设置页（`extension/options.html`）里的 bridge 地址要一起改。
- 配置不导出 schemastery `Config`（零依赖约定），loader 把 `config:` 原样传入，插件内部兜底。

---

## 4. Bridge API

全部 JSON、`Cache-Control: no-store`。CORS：`Access-Control-Allow-Origin` 回显请求 `Origin`，
仅当它是 `chrome-extension://<id>` 或 `http://127.0.0.1[:port]` / `http://localhost[:port]`；
其它浏览器 Origin 返回 `403 {error:{code:'forbidden-origin'}}`。无 `Origin` 的本机客户端（curl/node）放行。
预检 `OPTIONS` 允许 `GET, POST, OPTIONS` + `content-type`，`Access-Control-Max-Age: 600`。

### 4.1 `GET /__bridge/health`

```json
{
  "ok": true,
  "version": "1.0.0",
  "uptimeMs": 12345,
  "upstream": { "ok": true, "host": "127.0.0.1", "port": 4064, "authReady": true,
                "lastAuthError": null, "lastAuthAt": "2026-11-10T12:00:00.000Z", "attempts": 1 },
  "context": { "tabs": 2, "activeTabId": 123, "updatedAt": "2026-11-10T12:00:01.000Z" },
  "listen": { "host": "127.0.0.1", "port": 41789, "startError": null }
}
```

`upstream.ok` 与 `upstream.authReady` 目前同义（token 交换成功即 true）；扩展侧边栏/设置页用 `upstream.ok`
判断「连接正常 / 上游未就绪」（与 `extension/test/mock-bridge.mjs` 的契约一致）。

### 4.2 `POST /__bridge/context`

请求体 = 规格 §2 的快照（必填 `url` / `title` / `capturedAt` / `tabId`；未知字段忽略）。
正文 ≤60000 字、字幕 ≤5000 条且 ≤80000 字、选中文本 ≤20000 字，超限截断并置 `truncated: true`；
整个 body 上限 **8 MB**（超过 → `413 {error:{code:'payload-too-large'}}`）。
每个 `tabId` 只保留最新快照，最多 50 个标签，LRU 淘汰。

服务端会补全/规范化：`windowId` 缺省 `-1`（与扩展的「未知窗口」约定一致）、
`video` 永远存在（无视频时为 `{kind:'none',…,transcript:[]}`）、`meta`/`content` 缺省为空对象、
`receivedAt` 由服务端打时间戳、`id` 由服务端生成（客户端传的 `id` 会被忽略）。

响应：`{ok:true, id, tabId, updatedAt, activeTabId}`。客户端自带的 `id`（非空字符串）会被保留并回显，
与扩展侧「POST 返回 id 与推送一致」的契约一致；没带才由服务端生成。
`content.charCount` 是**实际保存下来的**正文字符数（扩展侧 `validateSnapshot` 要求 `charCount === text.length`），
超限截断时原长度保存在额外的 `content.originalCharCount` 里。`active === true` 的快照会成为活动标签；
若从未有 active 标记，则首个快照兜底为活动标签。

### 4.3 `GET /__bridge/context/latest?tabId=&windowId=`

缺省返回活动标签的快照；**响应体就是快照本身**（规格 §2「→ 最新快照」，扩展可直接 `validateSnapshot()`）。
没有则 `404 {ok:false,error:{code:'no-context',message:...}}`；带 `windowId` 且与快照的 `windowId` 不符时同样 404。

### 4.4 `GET /__bridge/context/list`

`{ok:true,count,activeTabId,tabs:[...]}`，每行同时给出扁平字段与扩展契约用的嵌套字段：

```json
{ "id": "…", "tabId": 123, "windowId": 1, "active": true,
  "url": "…", "title": "…", "siteName": "…",
  "capturedAt": "…", "updatedAt": "…", "receivedAt": "…",
  "contentChars": 12000, "contentTruncated": false, "selectionChars": 0,
  "videoKind": "youtube", "transcriptCount": 120,
  "video": { "kind": "youtube", "transcriptCount": 120 } }
```

### 4.5 `POST /__bridge/active`

切换「当前标签页」而不重发整页内容（扩展在内容未变时会去重，只发这个）：

```json
→ { "tabId": 123 }
← { "ok": true, "tabId": 123, "activeTabId": 123 }
← { "ok": false, "tabId": 999, "activeTabId": 123, "error": { "code": "no-context", … } }  // 该标签还没有快照
```

`tabId` 必须是整数（否则 400）；只接受 `POST`（否则 405）。作用：`browser_page` 的默认目标与
`context/latest` 始终跟随用户当前看的标签页；同时会把其它快照的 `active` 标记清掉，`context/list`
里永远只有一个 `active:true`。扩展在 `tabs.onActivated`/`windows.onFocusChanged` 时调用（快照去重分支也会调用）。

### 4.6 安全边界

- 只绑 loopback；不提供**任何**文件读/写、命令执行、导航类接口；
- 快照只存内存（v1 不落盘），插件卸载/进程退出即消失；
- CORS 白名单保证用户随便访问的网页读不到同步内容（浏览器侧）；
- 本机其它进程（curl 等）仍可访问 —— 与 DSH 自身 launch token 的本地信任模型一致；
  不要在共享机器上把 sidecar 端口转发出去。

---

## 5. `browser_page` 工具

单工具、`mode` 切换（原始 ToolDefinition，`output.schema` 只含 `{ok:boolean,text:string}`）：

| mode | 内容 | 默认上限 |
| --- | --- | --- |
| `summary` | 标题 / URL / 站点 / 抓取时间 / 正文字数 / 是否选中 / 视频与字幕概况 | 20000 |
| `page` | 正文纯文本 | 20000 |
| `selection` | 选中文本（无则说明） | 20000 |
| `video` | 视频元信息 + 前 40 条字幕预览 | 20000 |
| `transcript` | 完整字幕（`[mm:ss] 文本` 逐行） | 30000 |

可选 `tabId`（缺省活动标签）、`maxChars`（clamp 到 500–60000）。
每个输出都以「来源页面 / URL / 站点 / 抓取时间（相对时间）/ 标签页」开头，方便模型引用；
无快照时返回固定提示：让用户点侧边栏「读取当前页」。

注册方式（零 `@deepseek-ai` import）：

```js
ctx.effect(() => ctx.tools.register(createBrowserPageTool({ store })), 'browser-sidecar: browser_page tool');
```

---

## 6. 系统提示片段

`ctx.inject(['systemPrompt'], c => c.effect(() => c.systemPrompt.section({ name:'browser-sidecar:browser-context', order:700, text })))`

内容 4 行（`index.js` 的 `SYSTEM_PROMPT_SECTION`），只说明：用户可能在侧边栏问当前网页/视频、
先 `browser_page(mode="summary")` 判断有无上下文、按需取 page/selection/video/transcript、
没有上下文时让用户点「读取当前页」、数据有延迟要说明抓取时间。不会改动工具列表以外的行为。

---

## 7. 测试

```powershell
# 标准命令（在普通 shell 里）
node --test packages/dsh-browser-sidecar/test/*.test.js

# 在 DSH 文件沙箱里：node --test 默认按文件 spawn 子进程（piped stdio 被沙箱拒绝，报 spawn EPERM），
# 改成同进程运行即可（结果等价）：
$env:NODE_OPTIONS = '--experimental-test-isolation=none'
node --test packages/dsh-browser-sidecar/test/*.test.js
Remove-Item Env:\NODE_OPTIONS
```

当前结果：**45 tests / 45 pass / 0 fail**（约 0.6s）。

覆盖矩阵：

| 文件 | 覆盖 |
| --- | --- |
| `test/proxy.test.js` | mock upstream（303+Set-Cookie、cookie/Host/fence 校验、POST 回显、SSE、WS echo、gzip）→ 无 cookie 401 / 代理后 200 / Host+Cookie+sec-fetch-site+Origin 改写 / body 重放 / SSE 逐条到达 / WS 双向通信 / 401 自愈重放 / token 交换退避重试 / 降级 HTML / 上游不可达 / 端口占用 / close 清理 |
| `test/bridge.test.js` | CORS 预检与拒绝、snapshot upsert、latest/list、活动标签、未知字段忽略、正文与字幕截断、必填校验、非法 JSON、8 MB 上限 413、50 个标签 LRU、404/405 |
| `test/tool.test.js` | summary/page/selection/video/transcript 输出结构、`maxChars` 截断与 clamp、无上下文提示、tabId 选择 |
| `test/plugin.test.js` | `apply()` 端到端（fake ctx + mock upstream）：服务注册、工具注册、提示段、代理 UI、bridge 落地、无 `connection` 降级、无 `tools` 服务、端口占用不崩 |

跨端联调（不装插件、不起 DSH 也能验 bridge 契约）：

```powershell
# 1) 用真实 sidecar 代码起一个 bridge-only dev server
node packages/dsh-browser-sidecar/test/support/dev-bridge.mjs --port 41889
# 2) 跑扩展自带的契约检查（extension/ 队友提供）
node extension/test/verify-bridge.mjs --bridge http://127.0.0.1:41889 --tab-id 99
# 预期：11/11 项通过（health/POST/latest/list/CORS/回读结构）
```

测试不启动真实 DSH、不读写 `$DSH_HOME`、不安装插件。

---

## 8. 安装

前置：DSH 桌面应用**完全退出**（托盘「退出」，不是关窗口）——desktop profile 由 Electron 应用独占管理，
应用运行时改它会有写锁竞争/热重载抖动（详见 `docs/install.md` §5）。

### 8.1 脚本（推荐：自动备份 + 校验 + 打印回滚）

```powershell
# 先看计划（不写任何文件）
node scripts/install-sidecar.mjs --dry-run

# 真装（默认 profile=desktop）
node scripts/install-sidecar.mjs

# 隔离 profile（不动 desktop；会按模板初始化 profile）
node scripts/install-sidecar.mjs --profile sidebar-test --init-template web
```

脚本做的事：

1. 校验包契约（`package.json` 的 `dsh.bundle.patch`）；
2. 备份 `<profile>/package.json` 与 `<profile>/cordis.patch.yml` 到
   `<profile>/.sidecar-backup-<yyyyMMdd-HHmmss>/`，并写一份 `RESTORE.md`（内含精确回滚命令）；
3. 执行 `dsh plugin --profile <profile> add "<包绝对路径>"`（该子命令是 pnpm 薄封装，
   会把本地目录装成 `link:` 依赖，并把声明了 `dsh.bundle` 的包自动追加进 `dsh.profile.bundles`）；
4. 校验 `dependencies` / `dsh.profile.bundles` / `node_modules` 链接；
5. 打印健康检查、重启步骤与回滚命令。

### 8.2 手工等价步骤

```powershell
$cli  = "<DSH 应用目录>\resources\runtime\cli\bin\dsh.cmd"
$pkg  = "<本仓库目录>\packages\dsh-browser-sidecar"
$prof = "desktop"

# 0) 先完全退出桌面应用
# 1) 备份（手工时也别省）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\profiles\$prof\.sidecar-backup-$stamp" | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\profiles\$prof\package.json"       "$env:USERPROFILE\.dsh\profiles\$prof\.sidecar-backup-$stamp\"
Copy-Item "$env:USERPROFILE\.dsh\profiles\$prof\cordis.patch.yml"   "$env:USERPROFILE\.dsh\profiles\$prof\.sidecar-backup-$stamp\"

# 2) 安装
& $cli plugin --profile $prof add $pkg

# 3) 校验（desktop 不允许 --dump-config，用这三条等价判据）
$pj = Get-Content "$env:USERPROFILE\.dsh\profiles\$prof\package.json" -Raw | ConvertFrom-Json
$pj.dependencies.PSObject.Properties | Where-Object Name -eq 'dsh-browser-sidecar'
$pj.dsh.profile.bundles | Select-String 'dsh-browser-sidecar'
(Get-Item "$env:USERPROFILE\.dsh\profiles\$prof\node_modules\dsh-browser-sidecar").LinkTarget
```

### 8.3 重启后验收

1. 完全退出桌面应用 → 重新启动（host 半可能热重载，但客户端/连接状态要重启才稳）；
2. `curl.exe -s http://127.0.0.1:41789/__bridge/health` → `"ok":true`，`upstream.authReady` 最终为 `true`；
3. 浏览器打开 `http://127.0.0.1:41789/` → 应是 DSH Web UI（不是 401、不是可诊断 HTML）；
4. Chrome `加载已解压扩展` 指向 `extension/` → 侧边栏 iframe 同一地址可用；
5. `读取当前页` 后 `curl.exe -s http://127.0.0.1:41789/__bridge/context/latest` 有快照；
6. 会话里问「总结这个页面」→ 模型应调用 `browser_page`。

隔离 profile 做 UI 验证（不动桌面应用）：

```powershell
& $cli --profile sidebar-test --from-default-profile web --dump-config *> $null   # 仅当 profile 不存在
node scripts/install-sidecar.mjs --profile sidebar-test
& $cli --profile sidebar-test --no-open --port 9820    # 端口避开 Windows 保留段
# sidecar 仍是 41789；若 41789 被桌面应用占用，先退出桌面应用或在 profile 的
# cordis.patch.yml 里覆盖 config.port（见 §3）
```

---

## 9. 升级 / 卸载 / 回滚

- **升级**：源码改动后重跑 `node scripts/install-sidecar.mjs`（`link:` 安装，改完重启 DSH 即生效；
  host 半由 `dsh-hmr` 监听，客户端无关，因为本插件没有 client 半）。
- **卸载**：
  ```powershell
  & $cli plugin --profile desktop remove dsh-browser-sidecar
  & $cli plugin --profile desktop install
  ```
  （`plugin` 是 pnpm 薄封装，`remove` 即 `pnpm remove`；成功后 reconcile 会自动把它从
  `dsh.profile.bundles` 移除。若该子命令在你的 CLI 版本不可用，手工删 `dependencies` 项与
  `dsh.profile.bundles` 项，再跑 `plugin install`。）
- **回滚**（安装后出问题）：
  ```powershell
  # 用脚本备份（推荐）
  Copy-Item -LiteralPath "<profile>\.sidecar-backup-<stamp>\package.json"     -Destination "<profile>\package.json" -Force
  Copy-Item -LiteralPath "<profile>\.sidecar-backup-<stamp>\cordis.patch.yml" -Destination "<profile>\cordis.patch.yml" -Force
  Remove-Item -LiteralPath "<profile>\node_modules\dsh-browser-sidecar" -Recurse -Force -ErrorAction SilentlyContinue
  & $cli plugin --profile desktop install
  ```
  应用自己也会留 `package.json.bak-*` 快照，可用同法还原。
  还原后**完全重启应用**，确认 `http://127.0.0.1:41789/` 已不可访问。

---

## 10. 排错

| 症状 | 可能原因 | 处理 |
| --- | --- | --- |
| `/` 返回「等待鉴权」诊断页 | `connection` 服务还没就绪（插件比它先加载）；或上游不在 4064 | 页面里有 `最近错误`/`自动重试`；等 1–10s 刷新；确认 DSH 在运行、`upstreamPort` 正确 |
| `/` 返回 401 或 JSON `unauthorized` | token 交换失败且请求不可重放（>1 MB 或 chunked body），或重新鉴权也失败 | 看 `/__bridge/health` 的 `upstream.lastAuthError`；重启 DSH 让 launch token 重新签发 |
| `/api/*` 返回 403 | 上游 fence 拒绝：`Host` 不是 loopback、`sec-fetch-site: cross-site`、`Origin` 与 `Host` 不同源 | 必须经 sidecar 访问（`http://127.0.0.1:41789/`），不要直接开 4064；不要把 sidecar 放到反代后面改 Host |
| WebSocket 失败（UI 能显示但实时会话不动） | 升级被 401/403（cookie 失效）、或中间层（公司代理/杀软）截断 upgrade | `/__bridge/health` 看 `authReady`；日志里搜 `WebSocket 升级被上游拒绝`；重试一次即触发重新交换 |
| 健康检查 `lastAuthError: connection 服务尚未就绪` | 插件 apply 早于 `client-connection` | 等待自动重试；若持续 >30s，确认 profile 里 `client-connection` 没被禁用 |
| `listen.startError: EADDRINUSE` | 41789 被占用（桌面应用已占？旧实例残留？其它插件？） | `Get-NetTCPConnection -LocalPort 41789` 找到进程；改 `config.port` 并同步扩展设置 |
| 提示「代理无法监听…bridge 与 browser_page 仍可用」 | 同上，插件降级不崩 | 端口释放后重启 DSH |
| 扩展 `测试连接` 失败 | 端口/地址不一致、或 DSH 没运行 | 扩展设置页把地址改成 `http://127.0.0.1:41789` |
| `node --test` 报 `spawn EPERM` | DSH 文件沙箱不允许 `node --test` 的 piped stdio 子进程 | `$env:NODE_OPTIONS='--experimental-test-isolation=none'` 后再跑（见 §7） |

日志前缀统一为 `browser-sidecar:`，可在 DSH 日志/终端里过滤。

---

## 11. 已知风险 / 尚未在真实 DSH 实测的点

> **2026-11-10 真机验证**：插件已装进真实 DSH **0.2.2-rc.1** 宿主（隔离 profile `sidebar-test`，`dsh.cmd --profile sidebar-test --port 48700 --no-open`），已验证：
> `ctx.inject(['connection'])` 可用、`authenticatedUrl()` token 交换成功（`/__bridge/health` → `authReady:true`）、
> `/` 经代理由 401 变 **200**、真实 `/api/remote.mux` WebSocket 通（UI 会话列表/插件/模型选择全部渲染、可发消息并流式回复）、
> `browser_page` 工具被模型真实调用、扩展 CORS 预检/同步/切页均通过。
> 尚未覆盖的只有「装进 **desktop** profile 后重启」这一步（本机当前会话就跑在桌面应用里，重启会中断会话，留给用户按 §8.3 验收）。

下列项原本需要在真实环境逐条确认，现状如下：

| # | 待验证 | 风险 | 怎么验 |
| --- | --- | --- | --- |
| 1 | `ctx.inject(['connection'])` 在 desktop 真实加载顺序下能拿到 `connection` 服务 | 中。拿不到会一直降级（但不会崩） | `/__bridge/health` 的 `upstream.authReady` 应在几秒内变 true；否则看日志 `lastAuthError` |
| 2 | `connection.authenticatedUrl()` 返回值可直接用于 token 交换（我们只取 `token` 参数并请求 `/`） | 低。已读源码确认语义 | 同上 |
| 3 | 真实上游 cookie 的 `Set-Cookie` 解析（我们取第一段 `name=value`） | 低 | API 返回 200 即说明 cookie 生效 |
| 4 | 真实 `/api/remote.mux` WebSocket 经代理后可用（会话流式消息） | 中。WS 握手头已对照源码实现，但未接真实 DSH | 打开 UI 发一条消息，看是否流式返回；不行就抓 sidecar 日志 |
| 5 | iframe 里 DSH UI 的完整加载（静态资源、`<base href="/">`、文件上传/下载） | 中 | 打开 `http://127.0.0.1:41789/` 手动点一遍 |
| 6 | 桌面应用重启后 launch token 变化 → 需要重新交换 | 低（每次启动都会交换） | 重启后 health 的 `lastAuthAt` 更新 |
| 7 | 长 SSE（>15s 无数据）不会被代理掐断 | 中。连接阶段有 15s 超时，拿到响应头后清零 | 挂一个长任务的会话观察 |
| 8 | 真实扩展的 CORS 预检（MV3 service worker / side panel 的 Origin） | 低 | 扩展 `测试连接` + `读取当前页` |
| 9 | 端口冲突时的降级体验 | 低 | 先占用 41789 再重启 DSH，看诊断页与日志 |

其它已知限制：

- **本地信任模型**：sidecar 端口对**本机任意进程**开放（与 DSH Web 本身一致），任何本机程序都可借它
  访问 UI 或读已同步的页面快照。不要把它转发到局域网/公网。
- **不落盘**：v1 快照只在内存，DSH 重启后为空；扩展会重新同步（规格允许可选落盘，本版未做）。
- **不读凭据文件**：产品实现不使用 `$DSH_HOME/.credentials.yaml` 派生 cookie（那是 lead 原型里仅为验证的
  临时手段）。若真实环境拿不到 `connection` 服务，再评估「凭据派生」兜底方案（需单独评审）。
- **单实例**：同一端口只能一个 sidecar；多 profile 同时跑要给不同 `config.port`，并各自在扩展里配置。

---

## 12. 文件清单

```
packages/dsh-browser-sidecar/
├─ package.json          # bundle 契约：dsh.bundle.patch，无 dsh.client（无 client 半）
├─ cordis.patch.yml      # 一行 host 插入 + 默认 config
├─ index.js              # apply(): 生命周期、服务注册、工具、系统提示、connection 接线
├─ proxy.js              # 反向代理：token 交换/退避重试、HTTP 流式、WS 隧道、降级页、401 自愈
├─ bridge.js             # /__bridge/* 路由、CORS、body 读取与 8MB 上限
├─ context-store.js      # tabId → snapshot（50 个 LRU、activeTabId、health）
├─ core.js               # 快照校验/截断、工具输出格式化（纯函数，无 IO）
├─ tools.js              # browser_page raw ToolDefinition
├─ README.md
└─ test/
   ├─ proxy.test.js      # 代理 + mock upstream（鉴权、SSE、WS、gzip、401、降级、端口占用）
   ├─ bridge.test.js     # Bridge API / CORS / 校验 / 截断 / LRU
   ├─ tool.test.js       # 工具输出纯逻辑
   ├─ plugin.test.js     # apply() 端到端 + 降级场景
   └─ support/
      ├─ mock-upstream.js   # 进程内 DSH Web 上游模拟（含 WS upgrade、fence、cookie 签发）
      ├─ http-client.js     # HTTP / SSE / raw WS 测试客户端 + waitFor
      └─ dev-bridge.mjs     # bridge-only 联调服务（配合 extension/test/verify-bridge.mjs）

scripts/install-sidecar.mjs   # 安装 + 时间戳备份 + 校验 + 打印回滚（--profile/--dry-run/--init-template）
```
