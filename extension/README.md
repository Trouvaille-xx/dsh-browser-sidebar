# DSH 浏览器侧边栏 · Chrome 扩展（extension/）

Chrome MV3 扩展：在浏览器侧边栏里内嵌 DeepSeek Harness 官方 Web UI（经 bridge 代理），并把**当前标签页**的正文、选中文本、页面元数据与视频字幕作为上下文同步给 DSH agent。用户在侧边栏直接问"总结这页 / 这个视频讲了什么"。

对应规格：[`docs/browser-sidebar-spec.md`](../docs/browser-sidebar-spec.md) §3。

- 纯原生 ES modules + CSS，**零构建、零依赖**，`chrome://extensions → 加载已解压的扩展程序` 即可用。
- 深色/浅色跟随系统；UI 针对窄侧边栏（约 320–500px）适配。

### v1.1.0 新增

1. **「当前页面」状态条**（工具条下方固定 30px）：一眼看出 agent 现在读到的是哪一页 —
   `已同步 · 12 秒前` / `尚未读取，点 ⟳` / 黄色警告 `当前页未同步，agent 看到的是：<旧标题>` + 一键「同步当前页」。
2. **B 站（bilibili）字幕**：页面态 `__INITIAL_STATE__.videoData.subtitle.list`（登录态零 API）→
   `player/v2`（带 cookie）→ `page-text` 三级降级，快照 `video.kind='bilibili'`，
   `transcriptSource` 为 `bilibili-page` / `bilibili-api` / `page-text`。
3. 未新增任何权限；`video.kind` / `transcriptSource` 枚举在 `lib/core.js` 同步扩展。

---

## 1. 目录结构

```
extension/
├── manifest.json          MV3 清单（sidePanel/tabs/scripting/storage/activeTab + <all_urls>）
├── sidepanel.html/css/js  顶部 40px 工具条 + iframe（DSH UI）
├── background.js          service worker：标签页事件 → 抽取 → POST /__bridge/context
├── content.js             content script：正文/选中/元数据/视频字幕抽取（只读，不传网络）
├── options.html/css/js    设置页：bridge 地址、自动同步、节流、采集上限、测试连接
├── lib/
│   ├── core.js            共享纯函数（文本清洗/截断、DOM 抽取、URL 判定、timedtext 解析、快照构建）
│   └── net.js             带超时 fetch / JSON 收发 / 失败重试 1 次
├── icons/                 16/32/48/128 PNG（generate-icons.mjs 可重新生成）
└── test/                  node --test 单测 + mock bridge + 联调脚本（不参与打包）
```

`lib/core.js` 是唯一的事实来源，被 4 种环境复用：content script（经典脚本）、service worker（`importScripts`）、sidepanel/options（`<script src>` 后接 ES module 页面逻辑）、`node --test`（CJS 加载）。所以它内部没有 import/export，只在末尾挂 `globalThis.DSHSidebarCore` + `module.exports`。

---

## 2. 安装与加载

1. 确认 DSH 侧就绪：DSH 已启动（桌面端，或 `dsh web --port 4064`），并安装了 `dsh-browser-sidecar` 插件（bridge 监听 `127.0.0.1:41789`）。
2. Chrome 打开 `chrome://extensions` → 右上角开 **开发者模式**。
3. 点 **加载已解压的扩展程序** → 选择本仓库的 `extension/` 目录。
4. 点工具栏图标（或 `chrome://extensions` 里的"侧边栏"）打开 side panel；首次安装会自动打开设置页，确认 bridge 地址。
5. 侧边栏顶部看到绿点 + DSH UI 即成功；点 **⟳ 读取当前页** 会把当前标签页推送到 bridge。

> 打包分发：`node scripts/pack-extension.mjs` → `dist/dsh-sidebar-<version>.zip`，解压后同样用"加载已解压"加载。

### 权限说明

| 权限 | 用途 |
| --- | --- |
| `sidePanel` | 打开/控制侧边栏 |
| `tabs` | 监听标签页切换、URL 变化、关闭；读取活动标签页的标题/URL |
| `scripting` | 兜底注入 content script；在 page world 读 YouTube `ytInitialPlayerResponse` |
| `storage` | 设置（local）+ 最近快照缓存（session） |
| `activeTab` | 用户主动点击时读取当前标签页 |
| `<all_urls>` | 在普通网页注入 content script；service worker 跨域取 YouTube timedtext |

没有 `cookies`、没有 `webRequest`、没有后台定时抓取。

---

## 3. 它怎么工作

```
tabs.onActivated / onUpdated / onRemoved
content 报「页面变了」(SPA 路由 / 内容变化 / 滚动 / 选中)
侧边栏点「读取当前页」
        │
        ▼
background  ──sendMessage(EXTRACT)──▶  content script
        │                                  ├─ 正文：article/main → 退化 body（去导航/页脚）
        │                                  ├─ 选中：window.getSelection()
        │                                  ├─ 元数据：description/og:image/author/publishedAt/lang
        │                                  └─ 视频：YouTube 字幕 / <video> textTracks / page-text
        │  ◀── draft ───────────────────────┘
        ▼
buildSnapshot（统一按规格截断：正文 60000 字、字幕 5000 条 / 80000 字）
        │
        ▼
POST http://127.0.0.1:<port>/__bridge/context（3s 超时，失败重试 1 次）
        │
        ├─ 成功：缓存到 chrome.storage.session，广播状态给 side panel
        └─ 失败：标红状态点 + 保留本地快照 + 提示
```

**YouTube 字幕链路**：`chrome.scripting.executeScript({world:'MAIN'})` 读 `ytInitialPlayerResponse` → 取 `captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl`（优先人工字幕，其次中文/英文）→ service worker 跨域 fetch timedtext（`fmt=json3`，失败退回 XML）→ `core.parseTimedtextAuto` 解析成 `[{start,end,text}]`。任何一步失败都退化成 `transcriptSource='page-text'`（标题/简介/首屏评论）。

**B 站字幕链路（v1.1.0）**：三级降级，全部失败也会退化而不是报错。

```
content  ──BILI_PROBE──▶ SW ──executeScript({world:'MAIN'})──▶ 页面
                                 └─ window.__INITIAL_STATE__.videoData
                                    bvid / aid / cid(当前分P) / title / duration / owner.name
                                    pages[].cid、pageNo（分 P）
                                    subtitle.list[] ← 登录态下自带 subtitle_url（零 API）
        ◀── probe ────────────────┘
   ① 页面态：subtitle.list 有 subtitle_url
        → BILI_SUBTITLES{subtitleUrl} → SW 白名单 fetch → {body:[{from,to,content}]}
        → transcriptSource = 'bilibili-page'
   ② API 兜底：BILI_SUBTITLES{bvid,aid,cid,durationSec,credentials:'include'}
        → https://api.bilibili.com/x/player/v2 → data.subtitle.subtitles[]
        → 选轨（zh-Hans > zh-CN > zh > ai-zh > 其它 zh*）→ 拉 subtitle_url
        → transcriptSource = 'bilibili-api'
   ③ 以上都失败（未登录 / 无字幕 / CORS / 风控 / 超时）→ page-text（标题/简介/UP 主/首屏文字）
        → transcriptSource = 'page-text'，video.kind 仍是 'bilibili'
```

- 网络优先在 **service worker**（`host_permissions:<all_urls>` 可跨域）发出；SW 失败/为空时，content script 用页面自身 cookie 再试一次（`fetch` + `credentials:'include'`，5s 超时）。
- SW 侧 host 白名单：只允许 `api.bilibili.com`、`*.hdslb.com`、`*.bilivideo.com`（http 会被升级为 https），其它 URL 一律拒绝；YouTube timedtext 仍走独立的 `FETCH_TEXT` 分支，两套白名单互不混用。
- 字幕时间戳两种格式都容错：正常是「秒（浮点）」，若检测到毫秒（结合视频时长 / 数值量级）会统一除以 1000。

**「当前页面」状态条（v1.1.0）**：`background.buildState()` 额外返回
`snapshotTabId / snapshotTitle / snapshotUrl / syncedAt`（快照属于哪个标签页），side panel 用纯函数
`core.computePageStatus({activeTabId, activeTabTitle/Url, snapshotTabId, snapshotTitle/Url, syncedAt, now})`
算出三态文案：

| tone | 条件 | 展示 |
| --- | --- | --- |
| `ok` | 活动标签页 == 快照所属 tab 且 URL 相同 | 绿点 `🌐 当前页面：<标题> · <host>` + `● 已同步 · 12 秒前` |
| `idle` | 还没有任何快照 / 受限页面 | 灰字 `尚未读取，点 ⟳` / `无法读取` |
| `warn` | 切到了别的标签页，或同 tab 但 URL 已变（SPA 未同步） | 黄色 `⚠ 当前页未同步，agent 看到的是：<旧标题>` + `[同步当前页]` |

每次 `STATE_CHANGED`（切页 / 同步成功 / 失败）都会刷新；相对时间每 10s 自走一次。

**SPA**：`popstate`/`hashchange` + 1s 低频 URL 轮询（隔离世界拦不到页面自己的 `history.pushState`）+ service worker 的 `tabs.onUpdated.changeInfo.url` 三重兜底；内容变化用 `MutationObserver` + trailing debounce（默认 1.5s）。

### 隐私 / 防御性边界

- 只处理**当前活动标签页**；后台标签页的内容不会抽取、不会推送（`sender.tab.active` 校验）。
- 只跑顶层文档（`all_frames: false`），**跨域 iframe 不读**；`chrome://`、`chrome-extension://`、`devtools://`、`data:`、`blob:` 等直接跳过。
- 不读取 `input`/`textarea`/`select`/`button` 的值或文本（`lib/core.js` 的 `SKIP_TAGS`），不碰密码框。
- 跨域取文本只走两套独立白名单：`FETCH_TEXT` 仅 YouTube timedtext；`BILI_SUBTITLES` 仅 `api.bilibili.com` / `*.hdslb.com` / `*.bilivideo.com`，扩展不会被当成通用 CORS 代理。
- B 站字幕请求会带**用户自己的登录 cookie**（`credentials: 'include'`）发往 bilibili 官方接口，仅用于取字幕；不写入任何日志、不发往第三方。
- 数据只发往用户配置的本机 bridge；除 bridge 与上述字幕接口外没有任何外部请求，无第三方上报。
- 自动同步失败时不会无限重试：每次变化最多 2 次尝试（1 次重试），失败后等下次变化。

---

## 4. 设置页

| 项 | 默认 | 说明 |
| --- | --- | --- |
| Bridge 地址 | `http://127.0.0.1:41789` | 只填 `host:port` 会自动补 `http://` 与端口 |
| 自动同步 | 开 | 切页 / SPA 路由 / 内容变化 / 滚动 / 选中后自动推送 |
| 节流间隔 | 1.5s | 内容变化后的 debounce 窗口 |
| 正文上限 | 60000 字符 | 可降到 30000 或升到 120000 |
| 字幕条数上限 | 5000 条 | 可降到 2000 或升到 10000 |
| 字幕字符上限 | 80000 字符 | 可降到 40000 或升到 160000 |
| 测试连接 | — | 直接 GET `/__bridge/health`，显示 version/upstream/耗时/排错建议 |

上限只能在上表档位内调整；规格上限（60000/5000/80000）是硬上限，`normalizeSettings` 会夹紧，bridge 侧也会二次校验。

---

## 5. 自动化测试

### 5.1 单元测试

```bash
# 标准命令（要求全绿）
node --test extension/test/*.test.mjs
# 受限沙箱/终端（禁止 runner spawn 子进程）用同进程模式：
node --test --test-isolation=none extension/test/*.test.mjs
```

本机结果：**133 / 133 通过**（Node v24.19.0，约 1.1s）。覆盖：

| 文件 | 覆盖内容 |
| --- | --- |
| `core-text.test.mjs` | 空白规范化、噪音行过滤、60000 字符截断（含换行处断句）、哈希稳定性 |
| `core-urls.test.mjs` | `chrome://` 等受限 URL 判定、YouTube URL 各种形态、站点名、bridge 地址规范化、同源判断 |
| `core-youtube.test.mjs` | playerResponse/探针提取、字幕轨优先级、timedtext XML(srv1/srv3) 与 JSON3 解析、实体解码、滚动字幕合并、5000 条 / 80000 字符截断 |
| `core-bilibili.test.mjs` ⭐ | B 站 URL/分 P、`__INITIAL_STATE__`（含 `subtitle.list`）、字幕轨优先级（zh-Hans>zh-CN>zh>ai-zh>其它 zh*）、player/v2（正常/空/`-352` 风控/BOM）、subtitle_url 协议相对、`{body:[{from,to,content}]}` 秒/毫秒/BOM、白名单（含钓鱼域 `api.bilibili.com.evil.com`）、5000 条 / 80000 字符截断、`kind=bilibili` 快照枚举 |
| `core-dom.test.mjs` | 正文容器选择与噪音剔除、表单不读、元数据、选中文本、`<video>` textTracks、page-text 兜底 |
| `core-snapshot.test.mjs` | 快照字段与规格逐项一致、各类截断与 `truncated`、`validateSnapshot` 反例、去重签名、设置夹紧 |
| `core-pagebar.test.mjs` ⭐ | 「当前页面」状态条三态（已同步 / 未同步 / 不匹配警告含旧标题）、受限页、同 tab URL 变化、标题截断、host 规范化、相对时间 |
| `bridge-contract.test.mjs` | 起真实 HTTP mock bridge，验证 4 个端点、CORS 预检、400/404 错误、3s 超时、失败重试、端到端推送（文章 / B 站 / page-text） |
| `package-integrity.test.mjs` | manifest 权限/字段/图标尺寸、HTML 引用不断链、iframe `referrerpolicy`、UI 约束、状态条结构与 30px 高度、B 站链路接线、SW 事件注册 |

> **受限终端说明**：某些沙箱/受限 shell 会禁止 Node 测试 runner 用管道 spawn 子进程（报 `spawn EPERM`）。
> 这不是用例失败（同一个文件用下面任一方式都是 133/133 通过），可改用：
>
> ```bash
> node --test --test-isolation=none extension/test/*.test.mjs   # 同进程 runner
> node extension/test/run-all.mjs                               # 单进程直接 import 全部测试
> ```

### 5.2 Mock bridge 联调（本机实测）

mock bridge 实现了规格 §2 的 4 个端点，内存态、零依赖：

```bash
# 终端 A：起 mock bridge（默认 41789；端口被占用时换一个）
node extension/test/mock-bridge.mjs --port 41800

# 终端 B：模拟扩展推送 + 回读校验（11 项断言）
node extension/test/verify-bridge.mjs --bridge http://127.0.0.1:41800 --tab-id 777 --write snapshot.json
```

实测输出：

```
[verify] bridge: http://127.0.0.1:41800
[verify] 本地快照：id=1f9b7c20-… tab=777 chars=230 cues=4
✅ 本地快照符合规格结构 — 12 个顶层字段
✅ 快照体积在规格上限内
✅ GET /__bridge/health 可达 — version=mock-bridge-1.0.0 upstream={"ok":true,"port":4064}
✅ POST /__bridge/context 成功 — id=1f9b7c20-… updatedAt=2026-11-10T12:19:44.525Z
✅ POST 返回可用的 id/updatedAt — 与客户端 id 一致（mock 行为）
✅ GET /__bridge/context/latest 能取回快照 — title=用 Chrome 侧边栏接管你的浏览器上下文
✅ 回读结构与规格一致
✅ 回读 tabId/active 正确
✅ 回读 content.text 与推送一致
✅ 回读字幕条数一致
✅ GET /__bridge/context/list 可用 — tabs=1
[verify] 11/11 项通过
```

同一轮用 curl 交叉验证的原始响应：

```console
$ curl -s http://127.0.0.1:41800/__bridge/health
{"ok":true,"version":"mock-bridge-1.0.0","upstream":{"ok":true,"port":4064},"context":{"tabs":0,"updatedAt":null}}

$ curl -s -X POST -H "content-type: application/json" --data-binary @snapshot.json \
    http://127.0.0.1:41800/__bridge/context
{"ok":true,"id":"1f9b7c20-e47e-48fe-ac1e-f8e24268edca","updatedAt":"2026-11-10T12:19:44.581Z"}

$ curl -s "http://127.0.0.1:41800/__bridge/context/latest?tabId=777"   # 关键字段
{ "id": "1f9b7c20-…", "tabId": 777, "windowId": 1, "active": true,
  "title": "用 Chrome 侧边栏接管你的浏览器上下文", "siteName": "YouTube",
  "content": { "charCount": 230, "truncated": false },
  "video": { "kind": "youtube", "transcriptSource": "youtube-captions",
             "transcriptCount": 4,
             "firstCue": { "start": 0, "end": 2.5, "text": "大家好，欢迎收看" } } }

$ curl -s http://127.0.0.1:41800/__bridge/context/list
{"ok":true,"tabs":[{"tabId":777,"windowId":1,"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title":"用 Chrome 侧边栏接管你的浏览器上下文","updatedAt":"2026-11-10T12:19:44.495Z","video":{"kind":"youtube"}}]}

$ curl -s -i -X OPTIONS -H "Origin: chrome-extension://abcdef…" \
    -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type" \
    http://127.0.0.1:41800/__bridge/context
HTTP/1.1 204 No Content
access-control-allow-origin: chrome-extension://abcdef…
access-control-allow-methods: GET, POST, OPTIONS
access-control-allow-headers: content-type
access-control-max-age: 600
```

> **本轮联调**：mock bridge 只实现规格的 4 个端点与 CORS；真实 `dsh-browser-sidecar` 会额外做 token 交换、
> WebSocket 代理，并**由服务端生成快照 id**（忽略客户端 `id`）、补充 `receivedAt` 等字段，扩展侧不依赖这些差异
> （`verify-bridge.mjs` 对 id 一致/不一致都判通过，能区分 mock 与真实行为）。
>
> 本轮联调用的端口是 41800：本机 41789 已被一个运行中的 DSH 实例占用（`/__bridge/health` 返回 404，说明该实例没有挂 sidecar 插件）。
> 等真实 `dsh-browser-sidecar` 起来后，把 `--bridge` 换成 `http://127.0.0.1:41789` 再跑同一条命令即可验证真实 bridge。

推送体（`snapshot.json`）关键字段与规格 §2 完全一致：

```json
{
  "id": "1f9b7c20-e47e-48fe-ac1e-f8e24268edca",
  "tabId": 777, "windowId": 1, "active": true,
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "用 Chrome 侧边栏接管你的浏览器上下文",
  "siteName": "YouTube",
  "capturedAt": "2026-11-10T12:19:44.495Z",
  "selection": "把当前网页正文、选中文本与视频字幕同步给 DSH agent",
  "meta": { "description": "…", "ogImage": "…", "author": "示例频道", "publishedAt": "…", "lang": "zh" },
  "content": { "text": "…", "charCount": 230, "truncated": false },
  "video": {
    "kind": "youtube", "title": "…", "author": "示例频道", "durationSec": 642, "currentTimeSec": 128.5,
    "transcriptSource": "youtube-captions",
    "transcript": [{ "start": 0, "end": 2.5, "text": "大家好，欢迎收看" }, "…"]
  }
}
```

---

## 6. 手动验证清单（真实 Chrome）

前置：DSH + `dsh-browser-sidecar` 已启动；`curl http://127.0.0.1:41789/__bridge/health` 返回 `ok:true`。

### A. 加载与基础 UI

- [ ] `chrome://extensions` 无报错、无「清单无效」；service worker 显示"已激活"。
- [ ] 点扩展图标 → 侧边栏打开；工具条高度约 40px，包含状态点、`⟳ 读取当前页`、自动同步开关、`↗`、`⚙`。
- [ ] 状态点为绿、显示"已连接"；iframe 内出现 DSH UI 且可正常对话。
- [ ] 把侧边栏拖到最窄（≈320px）：按钮降级为图标、不出现横向滚动条。
- [ ] 系统切到深色模式（Windows 设置 → 颜色 → 深色）：侧边栏与设置页跟随变深；切回浅色同样生效。
- [ ] `↗` 在新标签页打开 bridge 地址；`⚙` 打开设置页。

### A2. 「当前页面」状态条（v1.1.0）

- [ ] 从未同步过（可先清空快照/重启浏览器）：状态条灰色 `🌐 当前页面：<标题> · <host>` + `尚未读取，点 ⟳`。
- [ ] 点 `⟳ 读取当前页` 后：变绿 `● 已同步 · 刚刚`，10s 后自动变成 `● 已同步 · N 秒前`。
- [ ] **切到另一个标签页**（B 站/新闻页）：状态条立刻变黄，文案包含上一页标题，
      例：`⚠ 当前页未同步，agent 看到的是：<上一页标题>`，右侧出现「同步当前页」按钮。
- [ ] 点「同步当前页」：变成绿色已同步，警告消失，`latest.tabId` 与新标签页一致。
- [ ] 同一个标签页内点进另一个视频/文章（SPA 且未自动同步前）：出现黄色"当前页已变化，尚未同步（agent 看到的是：…）"。
- [ ] 打开 `chrome://settings` 再点这个标签页：状态条灰色 `无法读取`（不显示"点 ⟳"）。
- [ ] 打开超长标题页面：标题单行省略号，状态条高度不变（30px），iframe 高度不被挤压。
- [ ] 深色模式下状态条背景/文字对比正常；最窄侧栏下 host 隐藏、按钮仍可点。

### B. bridge 不可达的降级

- [ ] 停掉 bridge（或把设置里的端口改成 `http://127.0.0.1:41999`）→ 点 `↗`/重开侧边栏：状态点变红，iframe 区显示引导卡片（启动命令、健康检查地址）。
- [ ] 点「重试连接」：仍不可达时提示失败；把端口改回来后重试 → 卡片消失、DSH UI 自动加载。
- [ ] 冷启动场景：bridge 正常但 DSH UI 很慢时，6s 后出现"加载超时/可先在新标签页验证"的引导（不会把已加载好的 UI 换掉）。

### C. 正文 / 选中文本同步

- [ ] 打开一篇长文（如 MDN 文章），点 `⟳ 读取当前页`：出现绿色 toast，`GET /__bridge/context/latest` 的 `content.charCount > 0`、`meta.description/author/lang` 有值。
- [ ] 在页面上选中一段文字 → 等 1~2s（自动同步开启）→ `latest.selection` 出现该文本。
- [ ] 打开 `chrome://settings` 后点 `⟳ 读取当前页`：提示"受限页面不读取"，不产生新快照。
- [ ] 正文超过 60000 字符的页面：`content.truncated=true` 且 `charCount<=60000`。
- [ ] 打开含输入框的页面（如登录页）：API 返回结果里**没有**输入框内容。

### D. YouTube 视频与字幕

- [ ] 打开一个有中文字幕的 YouTube 视频：等待自动同步后 `latest.video.kind='youtube'`、`transcriptSource='youtube-captions'`、`video.transcript` 有条目且 `title/author/durationSec` 正确。
- [ ] 在侧边栏问"这个视频讲了什么"：agent 调 `browser_page` 后总结内容与字幕一致。
- [ ] 打开无字幕视频：`transcriptSource='page-text'`，`transcript` 是标题/简介等页面文字。
- [ ] 打开普通 `<video>` 页面（有 WebVTT 字幕轨）：`kind='html5'`、`transcriptSource='track'`。

### D2. B 站（bilibili）字幕（v1.1.0）

> 验收方测试 Chrome **没有 B 站登录态**，所以「登录后 CC/AI 字幕」必须由用户真机确认；
> 未登录时应稳定退化，不报错。详见 §8「已知限制」。

- [ ] **未登录**打开视频页（如 `https://www.bilibili.com/video/BV1MEW46JEYB/`）：同步后
      `latest.video.kind='bilibili'`、`title/author/durationSec` 正确，`transcriptSource='page-text'`
      （或页面态字幕存在时为 `bilibili-page`），`transcript` 至少有标题/简介/UP 主文字，**没有异常报错**。
- [ ] SW console 里能看到 `player/v2` 返回 `code:0` 且 `subtitle.subtitles=[]`、`login_mid=0`（未登录的预期结果）。
- [ ] **登录后**再同步：`transcriptSource` 变成 `bilibili-page` 或 `bilibili-api`，`transcript` 条数与页面字幕一致；
      在侧边栏问"这个视频讲了什么"，agent 的总结与字幕内容一致。
- [ ] 多分 P 视频：切到 P2 后同步，`cid` 应取当前分 P（`videoData.pages[curPage].cid`，`pageNo` 为 1-based），字幕与 P2 一致。
- [ ] 无字幕视频（UP 主没开 CC/AI）：稳定退化为 `page-text`，agent 仍能基于标题/简介作答。
- [ ] 打开 `https://space.bilibili.com/xxx` 等非视频页：`video.kind='none'`，不影响正文同步。
- [ ] 断网/代理断开时点同步：状态条不改绿，toast 提示失败，页面不卡死（字幕请求 5s 超时）。

### E. SPA / 自动同步 / 节流

- [ ] 在 YouTube 内点另一个视频（SPA 跳转，不刷新页面）：1~3s 后 `latest.url`/`title` 自动更新。
- [ ] 关闭自动同步开关：切换标签页/滚动不再产生新快照（手动 `⟳` 仍可用）。
- [ ] 节流间隔改为 5s：连续滚动时不会每滚一下就推送一次。
- [ ] 关闭标签页：`chrome.storage.session` 里对应 `snap:<tabId>` 被清掉（可在 SW DevTools 里看），bridge 侧 `context/list` 条数随之减少（取决于 bridge 实现）。

### F. 设置页

- [ ] 改 bridge 地址为 `127.0.0.1:41789`（不带协议）→ 保存后自动变成 `http://127.0.0.1:41789`。
- [ ] 「测试连接」：bridge 正常时显示 "连接正常（xx ms）" + version/upstream/context 详情；停掉 bridge 后显示失败与排错建议。
- [ ] 正文/字幕上限改成最小档并保存 → 之后推送的快照按新上限截断。

---

## 7. 打包与 CRX

```bash
# zip（零依赖，内置 zip 写入 + 自检）；版本号取自 manifest.json，现在应为 1.1.0
node scripts/pack-extension.mjs
# → dist/dsh-sidebar-1.1.0.zip

# CRX（可选）
node scripts/sign-crx.mjs --gen-key                 # 生成 dist/extension-key.pem（私钥，别提交）
node scripts/sign-crx.mjs                          # auto：有 Chrome/Edge 用官方打包器，否则 native
node scripts/sign-crx.mjs --method native --verify  # 纯 node 实现 CRX3 并自检
node scripts/sign-crx.mjs --verify-only dist/dsh-sidebar-1.1.0.crx
```

> v1.1.0 只改了 `extension/**` 源码，**`dist/` 没有重新打包**（由 lead 统一打包）；`dist/` 里现有的
> `dsh-sidebar-1.0.0.zip/.crx` 是上一版的产物，打包脚本会自动用 manifest 的 `1.1.0` 生成新文件名。

- `pack-extension.mjs`：手写 ZIP 容器（deflateRaw + CRC32，Node 内置 zlib），打包后**重新解析产物**逐条 inflate 校验；默认排除 `test/`、`icons/generate-icons.mjs` 等开发文件（`--include-dev` 可全打包）。
- `sign-crx.mjs`：
  - `--method chrome` 调用 Chrome/Edge 的 `--pack-extension`（官方实现，推荐）；
  - `--method native` 按 CRX3 规范手写容器（`Cr24` + uint32(3) + header_size + CrxFileHeader(protobuf) + zip；RSA-SHA256 签名 `"CRX3 SignedData\0" + len + signed_header_data + zip`；`crx_id = SHA256(SPKI) 前 16 字节`）。
  - **交叉验证结果**：用 Edge 官方打包器产出的 .crx 与本脚本 native 产物对比，二者 `crx_id` 完全一致（`17271c118ea8a8f95930bb255cf30e87`）、header 大小一致（581B），且官方产物能被 `--verify-only` 校验通过（签名 + crx_id + 内嵌 zip 全部 OK）。
- **分发建议**：用 zip + "加载已解压"。Chrome 已不支持双击安装第三方 .crx（企业策略/Policies 才能分发本地 crx）。

---

## 8. 已知限制

1. **iframe 能否显示取决于 bridge 代理**：DSH UI 若响应 `X-Frame-Options: DENY` 或 `frame-ancestors` 不含 `chrome-extension://*`，iframe 会是空白。规格里由 `dsh-browser-sidecar` 负责注入/改写，扩展侧无法绕过；此时可用 `↗` 在新标签页打开。
2. **DSH UI 首次加载慢**：side panel 会显示 6s 超时引导，但不会强行清掉已加载的界面。
3. **YouTube 依赖 `ytInitialPlayerResponse`**：如果页面结构改版、登录墙、地区限制或 consent 页，可能拿不到字幕 → 自动退化为 `page-text`；Shorts 同样适用。
4. **timedtext 跨域**：必须由 service worker 取（有 `<all_urls>` host 权限）。若浏览器策略禁止，或视频关闭了字幕，会退化为 `page-text`。
5. **自动字幕的滚动累积**：`normalizeCues` 用启发式（前缀包含 + 时间相邻 ≤2.5s）合并滚动字幕；极端情况下可能少一行或合并过度。
6. **SPA 的 pushState 无法被隔离世界拦截**：靠 `tabs.onUpdated.changeInfo.url` + 1s URL 轮询兜底，因此极端情况下 URL 变化到同步之间有 ≤1s 延迟。
7. **`file://` 页面**：需要在扩展详情里手动打开"允许访问文件网址"，否则注入失败（会提示"无法注入内容脚本"）。
8. **非 localhost 的 http bridge**（如局域网 IP）：扩展页是安全上下文，Chrome 可能按混合内容拦截 `http://` iframe。用 `127.0.0.1`/`localhost` 不受影响。
9. **PDF / Chrome 内置查看器、Web Store 页面、`view-source:`** 等无法注入，属于预期跳过。
10. **`v1` 不做**：抽帧、音频转写、多浏览器（Firefox/Edge 未适配）、商店上架、云端分发。
11. **`sign-crx.mjs --method native`** 未在真实 Chrome 上做过"安装并通过签名校验"的端到端验证（Linux/Windows 均不支持双击装第三方 crx）；建议用 `--method chrome`。native 与官方产物的结构/ID 已交叉核对。
12. **mock bridge 不等于真实 bridge**：mock 只实现规格 4 个端点与 CORS 行为，真实实现（鉴权 token 交换、WebSocket 代理、落盘）由 `packages/dsh-browser-sidecar` 负责，本扩展只依赖其 HTTP 契约。

### 8.1 B 站字幕的未验证项与假设（重要）

> 开发环境**无法联网**，B 站链路全部基于「接口结构文档 + lead 真机 curl 情报 + 构造样本」实现并单测（确定性），
> **未做真实 API 联调**。以下假设与降级路径都已在代码里做了安全兜底：

1. **页面态优先**：已登录浏览器里 `videoData.subtitle.list[]` 的条目应含 `lan` / `lan_doc` / `subtitle_url` / `is_lock`；
   我们只依赖 `subtitle_url`，其余字段缺失不影响（缺失时该条被跳过，转 API 路径）。
   若 B 站改版把 `subtitle` 放到别处（如 `videoData.subtitle.v2`），页面态路径会拿不到 → 自动走 `player/v2`。
2. **未登录时 `player/v2` 的 `subtitle.subtitles` 为空、`login_mid=0`**（lead curl 实测）。
   此时会稳定退化到 `page-text`，`transcriptSource='page-text'`，**不会报错**。
3. **真实「登录后 CC/AI 字幕」字体未验证**：验收方测试 Chrome 无 B 站登录态，最终需用户真机确认。
   若 SW 拿不到 cookie（第三方 cookie 限制 / SameSite），会用内容脚本的页面 cookie 再试一次；
   两条路径都失败 → `page-text`。
4. **风控 / Referer**：`Referer` 是浏览器禁止头，扩展无法伪造。若 `player/v2` 因缺 Referer 返回 `-352`/`-403`，
   我们只记录失败并退化 `page-text`（不会重试轰炸）。
5. **字幕时间戳单位**：正常是「秒（浮点）」。若实际返回毫秒，会用「视频时长 ×2 + 30s」与「≥100000」两条规则识别并统一换算；
   规则在 `detectBiliTimeUnit` 里，可被单测覆盖，必要时把 `assumeUnit` 写死。
6. **AI/CC 不区分**：受快照 schema 约束，`transcriptSource` 只区分来源（`bilibili-page` / `bilibili-api`），
   不区分人工 CC 与 AI 字幕；选轨时 AI 字幕优先级低于官方中文轨。
7. **分 P**：`pageNo` / `pages[curPage].cid` 优先，URL `?p=` 兜底；若两者都不一致（B 站改版），可能取到 P1 的字幕。
8. **CORS**：内容脚本兜底 fetch 依赖 B 站对自身页面 origin 的 CORS 许可；被拦时只影响兜底路径（SW 路径通常已够用）。
9. **登录后字幕仍未在真实页面验证**（同上第 3 点）；`dist/` 也未按 1.1.0 重新打包（由 lead 统一打包）。

---

## 9. 排错

| 现象 | 排查 |
| --- | --- |
| 状态点红 / 引导卡片 | `curl http://127.0.0.1:41789/__bridge/health` 是否有 JSON；`netstat -ano \| findstr 41789` 看端口是否被别的进程占用；端口冲突就改设置或换 sidecar 端口 |
| 健康检查 ok 但发送失败 | 看 SW DevTools（`chrome://extensions` → service worker → 检查视图）的 console，通常是 4xx/5xx 或超时；`__bridge/context` 返回 400 时看响应里的 `errors`（规格校验失败） |
| iframe 空白 | 用 `↗` 在新标签页打开是否正常；正常则说明是 `X-Frame-Options`/CSP 问题（属 sidecar 侧）；检查 bridge 地址是否是 `127.0.0.1` |
| 「无法注入内容脚本」 | 页面是 `chrome://`/Web Store/PDF，或 `file://` 未开权限，或页面还没加载完（等加载完再点一次） |
| YouTube 拿不到字幕 | 看 SW console 是否有 `ytInitialPlayerResponse` 读取失败；确认视频有字幕轨；`video.transcriptSource` 会显示退化原因 |
| B 站拿不到字幕 | `latest.video.transcriptSource`：`page-text` = 降级了；SW console 看 `player/v2` 的 `code`（`-352` 风控 / `-403` / 空列表=未登录）；登录后仍空则看页面态 `subtitle.list` 是否为空（B 站可能未给该视频 CC） |
| B 站字幕时间轴错乱 | 可能是毫秒/秒误判：`detectBiliTimeUnit` 依赖 `videoData.duration`；若 duration 缺失且字幕数值 <100000 会按秒处理 |
| 「当前页面」状态条一直黄色 | 说明活动标签页与快照 tab 不一致：点「同步当前页」；若同步失败看 toast/状态点与 SW console |
| 状态条显示旧标题 | 预期行为（这是警告本身要传达的信息）；同步后自动变绿 |
| 选中文本没同步 | 自动同步是否开启；选中后要等 ~0.7s + 节流窗口；`latest.selection` 是否为空 |
| 快照里有 `truncated: true` | 正常行为，按规格上限截断；可在设置里调低/调高（不超过硬上限） |

调试小技巧：

- service worker 的 console：`chrome://extensions` → 本扩展 → "Service Worker" 检查视图。
- 快速看当前缓存：在 SW console 执行
  `const s = await chrome.storage.session.get(null); console.log(s)`
- 手动触发一次同步：side panel 里点 `⟳ 读取当前页`（等价于 `chrome.runtime.sendMessage({type:'dsh:sync-active'})`）。
- 看状态条的数据源：SW console 里 `await chrome.runtime.sendMessage({type:'dsh:get-state'})`，
  关注 `activeTabId / snapshotTabId / snapshotTitle / snapshotUrl / syncedAt`。
- B 站探针调试：SW console → Sources → 在 `biliProbeInPage` 打断点；或在页面 console 里
  `JSON.stringify(window.__INITIAL_STATE__.videoData.subtitle)` 看当前账号的字幕轨。

---

## 10. 变更记录

### v1.1.0（当前）

- 新增「当前页面」状态条（30px，固定高度）：已同步/未同步/不匹配警告三态 + 一键同步；
  数据源是 `buildState()` 扩展的 `snapshotTabId/snapshotTitle/snapshotUrl/syncedAt`；
  文案计算抽成 `core.computePageStatus`（纯函数，单测覆盖）。
- 新增 B 站视频字幕：page-world `__INITIAL_STATE__` 探针 → 页面态 `subtitle.list`（零 API）→
  `player/v2`（带 cookie，SW 优先、content 兜底）→ `page-text`；新增
  `video.kind='bilibili'` 与 `transcriptSource='bilibili-page'|'bilibili-api'`。
- content script 增加 `lib/net.js`（带超时 fetch 的页面内兜底）；未新增任何权限。
- 新增测试：`core-bilibili.test.mjs`、`core-pagebar.test.mjs`，bridge 契约增加 B 站快照往返；
  总计 133 个用例。

### v1.0.0

- 首个可用版本：侧边栏内嵌 DSH UI、正文/选中/元数据/YouTube 字幕同步、设置页、zip/crx 打包。
