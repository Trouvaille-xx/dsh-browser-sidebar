# Chrome 侧边栏 DSH 浏览器助手 — 规格 v1

目标：Chrome 侧边栏内嵌 DeepSeek Harness 官方 Web UI，并把用户当前网页（正文/选中文本/元数据）与视频内容（字幕转写、视频页文字）作为上下文送入 DSH agent，让用户在侧边栏直接问"总结这页/这个视频讲了什么"。

用户已确认：形态 A（iframe 官方 UI）；视频 = 字幕/转写文本 + 视频页文字信息（不做抽帧、不做音频转写）；交付 = 可打包分发的扩展（zip/crx 脚本 + 文档）。

## 1. 架构

```
Chrome (用户浏览器)
├─ Side Panel (chrome-extension://<id>/sidepanel.html)
│   ├─ 顶部工具条（扩展 UI，40px）：连接状态 / 同步开关 / 读取当前页 / 在新标签打开 / 设置
│   └─ iframe → http://127.0.0.1:<BRIDGE_PORT>/        ← 官方 DSH Web UI（经代理）
├─ Content Script（按需注入，<all_urls>）：抽取正文/选中/元数据/视频
└─ Service Worker：标签页事件 → 触发抽取 → POST 到 bridge

DSH Host 进程（用户现有 desktop profile）
└─ dsh-browser-sidecar 插件
    ├─ 反向代理 :<BRIDGE_PORT> → DSH Web UI（端口自动发现；HTTP + WebSocket，服务端注入鉴权 cookie）
    ├─ Bridge API /__bridge/*（CORS 允许 chrome-extension://*）
    ├─ 上下文仓库（内存 + 可选落盘 $DSH_HOME/browser-sidecar/latest.json）
    └─ 工具 browser_page + 系统提示片段（告诉 agent 何时读取浏览器上下文）
```

关键点：iframe 的文档源是 bridge 代理源（`http://127.0.0.1:<PORT>`），所有 DSH UI 的 `/api/*` 请求、WebSocket 都同源发往代理，由代理转发到上游并注入鉴权。**浏览器侧无需任何 cookie 技巧**，绕开 SameSite=Strict + 第三方 cookie 限制。

## 2. Bridge 插件（packages/dsh-browser-sidecar）

- 独立 `node:http` 服务器，默认端口 **41789**，仅绑定 `127.0.0.1`。端口可配置（`config.port`）。
- **上游端口自动发现**：DSH 桌面应用以 `--port 0` 启动 Web UI（端口每次随机），插件用
  `ctx.inject(['webServer'])` 读取真实 `webServer.port`；配置里写 `upstreamPort > 0` 才钉死。
- **鉴权**：通过 `ctx.get('connection').authenticatedUrl('http://127.0.0.1:<PORT>/')` 取得带 token 的启动 URL，代理启动时向上游做一次 token 交换拿到 `Set-Cookie`（authority 绑定 `<PORT>`，因此转发上游时必须保留原始 `Host` 头），此后所有转发请求注入 `Cookie`。若取不到 token，代理仍启动但返回可诊断页面（提示重启 dsh web）。
- **代理**：
  - HTTP：保留 method/path/query/body 流；透传响应头；SSE/流式响应要边读边写（不可整体缓冲）。
  - WebSocket：监听 `upgrade`，向 `127.0.0.1:4064` 建连并手工注入 `Host`/`Cookie`，双向裸 socket 管道。
  - 转发请求头：保留 `Host`（原 authority）、`Origin`（原样）；`/__bridge/*` 不转发。
- **Bridge API**（均为 JSON）：
  - `GET /__bridge/health` → `{ok, version, upstream:{ok,port}, context:{tabs,updatedAt}}`
  - `POST /__bridge/context` ← 扩展推送快照，返回 `{ok, id, updatedAt}`
  - `GET /__bridge/context/latest?tabId=&windowId=` → 最新快照（缺省返回"当前活动标签"）
  - `POST /__bridge/active` `{tabId}` → 只切换活动标签（内容去重时仍让 `browser_page` 跟随用户）；返回 `{ok,tabId,activeTabId}`；未知标签 `ok:false`
  - `GET /__bridge/context/list` → 各标签摘要（url/title/updatedAt/video.kind）
  - CORS：`Access-Control-Allow-Origin: <请求 Origin 若为 chrome-extension:// 则回显>`，允许 GET/POST/OPTIONS、`content-type`，`Access-Control-Max-Age: 600`。
- **上下文模型**（快照）：
  ```json
  {
    "id": "uuid", "tabId": 123, "windowId": 1, "active": true,
    "url": "...", "title": "...", "siteName": "...", "capturedAt": "ISO",
    "selection": "选中文本",
    "meta": {"description": "", "ogImage": "", "author": "", "publishedAt": "", "lang": "zh"},
    "content": {"text": "正文纯文本", "charCount": 12000, "truncated": false},
    "video": {
      "kind": "youtube|html5|bilibili|none", "title": "", "author": "", "durationSec": 0,
      "currentTimeSec": 0, "transcriptSource": "youtube-captions|track|page-text|bilibili-page|bilibili-api|none",
      "transcript": [{"start": 0.0, "end": 3.2, "text": "..."}]
    }
  }
  ```
  限制：正文 ≤ 60000 字符；transcript ≤ 5000 条且总长 ≤ 80000 字符；超限截断并标记 `truncated`。
- **工具 `browser_page`**：单工具，参数 `{mode: 'summary'|'page'|'selection'|'video'|'transcript', tabId?: number, maxChars?: number}`。
  - `summary`：返回标题/URL/站点/字数/视频有无/是否已选中（便宜，先看有什么）。
  - `page`：返回正文（默认 20000 字符上限）。
  - `video`：视频元信息 + 字幕统计 + 前 40 条字幕预览。
  - `transcript`：完整字幕文本（默认 30000 字符上限）。
  - 无快照时返回明确提示（"用户尚未同步浏览器页面，请让用户点击侧边栏的『读取当前页』"）。
- **系统提示片段**：注入一段简短说明（当用户问"当前页面/这个视频/我屏幕上"时先调 `browser_page`，并说明数据是用户主动同步的）。注意不要大段污染所有会话，≤ 5 行。
- 插件入口：`apply(ctx, config)`，不 import 任何 `@deepseek-ai/*`（link: 安装约束），只用 ctx 服务 + node builtins。
- 打包/安装：`dsh plugin --profile desktop add <abs path>` + 重启 DSH；另提供隔离测试 profile 脚本（`--profile sidebar-test` 用独立端口起 `dsh web`）。

## 3. Chrome 扩展（extension/）

- MV3 manifest：
  - permissions: `sidePanel`, `tabs`, `scripting`, `storage`, `activeTab`（如需 `cookies` 只用于可选的健康检查，不用它鉴权）
  - host_permissions: `<all_urls>`（内容脚本注入 + 读取页面）
  - `side_panel.default_path: sidepanel.html`
  - `action` 点击打开 side panel（`chrome.sidePanel.open`）
- **side panel**：顶部 40px 工具条 + 下方 iframe 填满（iframe `allow` 按需，`referrerpolicy="no-referrer"`）。
  - 工具条：连接点（绿/黄/红）、`读取当前页` 按钮、自动同步开关、`↗` 在新标签页打开 DSH、`⚙` 设置。
  - bridge 不可达时：工具条显示红点 + iframe 区显示引导卡片（启动命令/安装步骤），可重试。
- **content script**：
  - 正文抽取：优先 `article`/`main`/`[role=main]`，退化到全页文本；去导航/脚注噪音；保留标题/摘要/作者/发布时间/语言。
  - 选中文本：`window.getSelection()`。
  - 视频：
    - YouTube：从 page world 读取 `ytInitialPlayerResponse` 的 captions `baseUrl`（通过 `chrome.scripting.executeScript({world:'MAIN'})` 注入提取函数），fetch timedtext（XML/JSON3）解析成 `[{start,end,text}]`；同时取标题/频道/时长。
    - 通用：`document.querySelectorAll('video')` + `video.textTracks` cues（若可用）；否则用视频页文字（标题/简介/评论首屏）并把 `transcriptSource='page-text'`。
  - SPA 路由变化（history.pushState/popstate）与滚动节流后重新上报（自动同步开启时，debounce 1.5s，同一 URL 内容未变不重复上报）。
- **service worker**：`tabs.onActivated/onUpdated/onRemoved`；向 content script 发送抽取指令；POST 快照到 bridge（超时/重试 1 次）；缓存最近快照到 `chrome.storage.session`。
- **设置页**（options.html）：bridge 端口/地址（默认 `http://127.0.0.1:41789`）、自动同步开关与节流间隔、正文/字幕上限档位、`测试连接` 按钮。
- **UI 风格**：深色跟随系统（`prefers-color-scheme`），与 DSH 视觉协调；字体系统栈；不引入构建工具（纯 ES modules + CSS），保证 `加载已解压扩展` 即可用。
- **打包**：`scripts/pack-extension.mjs` 生成 `dist/dsh-sidebar-<ver>.zip`；`scripts/sign-crx.mjs` 用本地 key 生成 `.crx`（可选，文档说明）。

## 4. 验收标准

1. `node --test packages/dsh-browser-sidecar/test/*.test.js` 全绿（代理路径判定/上下文存取/工具参数校验/截断逻辑）。
2. 起隔离实例 `dsh --profile sidebar-test web --port 4065`（装插件）：`curl http://127.0.0.1:41789/__bridge/health` 返回 ok；`curl http://127.0.0.1:41789/` 返回 DSH UI HTML（代理鉴权成功，非 401）。
3. 扩展在真实 Chrome（加载已解压）中：侧边栏 iframe 显示 DSH UI 且可正常对话；`读取当前页` 后 `GET /__bridge/context/latest` 有内容。
4. 端到端：浏览器打开 YouTube 视频页 → 侧边栏同步 → 在 DSH 侧边栏提问"这个视频讲了什么" → agent 调用 `browser_page` 并基于字幕给出正确总结。
5. 打包脚本产出 zip；`docs/browser-sidebar-usage.md` 含安装、启动、排错、卸载步骤。

## 5. 非目标（v1）

- 不抽帧、不做音频转写；不做多浏览器（Firefox/Edge 暂不管，MV3 同源可后续）；不做云端分发/商店上架流程；不改 DSH 内核。
