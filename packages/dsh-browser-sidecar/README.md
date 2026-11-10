# dsh-browser-sidecar

Chrome 侧边栏 DSH 助手的三件套 Host 端实现（Host-only 插件，无 client 半）：

1. **反向代理**：在 `127.0.0.1:41789` 上把官方 DSH Web UI（默认上游 `127.0.0.1:4064`）
   镜像成同源站点，由服务端注入 launch-token 换来的 `HttpOnly` cookie，
   因此 `chrome-extension://` 的 side panel iframe 不需要任何第三方 cookie 技巧就能加载 UI；
   HTTP、SSE/流式响应（gzip 原样透传）与 WebSocket（`/api/remote.mux`）全部支持。
2. **Bridge API** `/__bridge/*`：Chrome 扩展推送「当前网页快照」（标题/URL/正文/选中文本/视频字幕），
   CORS 只允许 `chrome-extension://*` 与 loopback http origin。
3. **`browser_page` 工具 + 系统提示片段**：让 DSH agent 在用户问「总结这页/这个视频」时读取同步过来的上下文。

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: browser-sidecar
      name: dsh-browser-sidecar
      config:
        port: 41789          # 代理监听端口（仅 127.0.0.1）
        upstreamPort: 4064   # DSH Web UI 端口
        # upstreamHost: 127.0.0.1
```

## HTTP 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 代理到 DSH Web UI；鉴权未就绪时返回可诊断 HTML（200） |
| any | `/api/*`、`/assets/*` … | 原样流式代理到上游 |
| GET | `/__bridge/health` | `{ok, version, uptimeMs, upstream:{ok,port,authReady,lastAuthError}, context:{tabs,activeTabId,updatedAt}}` |
| POST | `/__bridge/context` | 推送快照，body ≤ 8 MB；返回 `{ok,id,updatedAt,activeTabId}` |
| GET | `/__bridge/context/latest?tabId=&windowId=` | 最新快照（响应体就是 snapshot），缺省活动标签；无则 404 `{error:{code:'no-context'}}` |
| GET | `/__bridge/context/list` | 摘要数组（最多 50 个标签，LRU；含 `video.kind`/`updatedAt`） |
| OPTIONS | `/__bridge/*` | CORS 预检（`Max-Age: 600`） |

不提供任何文件读写 / 命令执行接口。

快照规范化：保留客户端 `id`（未带则服务端生成）、补全 `windowId`/`video`；
`content.charCount` 等于实际保存的字数（原长在 `content.originalCharCount`），超限截断并置 `truncated`。

## `browser_page` 工具

`{ mode: 'summary' | 'page' | 'selection' | 'video' | 'transcript', tabId?, maxChars? }`

- `summary`：标题/URL/站点/抓取时间/正文字数/有无选中/视频与字幕概况（先看有什么）
- `page`：正文，默认 20000 字符上限
- `selection`：选中文本
- `video`：视频元信息 + 前 40 条字幕预览
- `transcript`：完整字幕，默认 30000 字符上限

所有输出都以来源 URL / 标题 / 抓取时间开头（硬上限 60000 字符）。无快照时返回可操作提示。

## 测试

```powershell
# 交付验收命令
node --test packages/dsh-browser-sidecar/test/*.test.js

# DSH 文件沙箱里 node --test 默认会 spawn 子进程（会被 EPERM 拦），改成进程内跑：
$env:NODE_OPTIONS='--experimental-test-isolation=none'
node --test packages/dsh-browser-sidecar/test/*.test.js
```

测试全部使用**进程内 mock upstream**（`node:http` + 手工 WS handshake），不依赖真实 DSH 进程。

## 安装

见 `docs/browser-sidecar-plugin.md` 与 `scripts/install-sidecar.mjs`。
