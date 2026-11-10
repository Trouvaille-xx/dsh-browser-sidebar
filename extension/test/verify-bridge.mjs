#!/usr/bin/env node
/**
 * Bridge 联调脚本：模拟扩展的推送路径，验证快照 JSON 结构与 mock/真实 bridge 的契约。
 * ---------------------------------------------------------------------------
 * 用法：
 *   # 1) 先起 mock bridge（或真实 DSH bridge）
 *   node extension/test/mock-bridge.mjs
 *   # 2) 另开一个终端跑联调
 *   node extension/test/verify-bridge.mjs
 *   node extension/test/verify-bridge.mjs --bridge http://127.0.0.1:41800 --tab-id 99
 *   node extension/test/verify-bridge.mjs --dump        # 额外打印完整快照 JSON
 *
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */

import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import '../lib/core.js';
import '../lib/net.js';

const core = globalThis.DSHSidebarCore;
const net = globalThis.DSHNet;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { bridge: 'http://127.0.0.1:41789', tabId: 424242, dump: false, youtube: true, write: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bridge') args.bridge = argv[++i];
    else if (arg.startsWith('--bridge=')) args.bridge = arg.slice('--bridge='.length);
    else if (arg === '--tab-id') args.tabId = Number(argv[++i]);
    else if (arg.startsWith('--tab-id=')) args.tabId = Number(arg.slice('--tab-id='.length));
    else if (arg === '--dump') args.dump = true;
    else if (arg === '--write') args.write = argv[++i];
    else if (arg.startsWith('--write=')) args.write = arg.slice('--write='.length);
    else if (arg === '--no-youtube') args.youtube = false;
  }
  return args;
}

// ---------------------------------------------------------------------------
// 构造「和真实扩展一致」的快照
// ---------------------------------------------------------------------------

const TIMEDTEXT_JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: '大家' }, { utf8: '好，' }, { utf8: '欢迎收看' }] },
    { tStartMs: 2500, dDurationMs: 3000, segs: [{ utf8: '这期视频' }, { utf8: '我们聊聊 ' }, { utf8: '浏览器扩展' }] },
    { tStartMs: 5500, dDurationMs: 2800, segs: [{ utf8: '首先' }, { utf8: '看一下 ' }, { utf8: '架构图' }] },
    { tStartMs: 8300, dDurationMs: 2200, segs: [{ utf8: '然后' }, { utf8: '进入 ' }, { utf8: '实现细节' }] },
  ],
});

const PLAYER_RESPONSE = {
  playabilityStatus: { status: 'OK' },
  videoDetails: {
    videoId: 'dQw4w9WgXcQ',
    title: '用 Chrome 侧边栏接管你的浏览器上下文',
    author: '示例频道',
    lengthSeconds: '642',
    isLiveContent: false,
    defaultAudioLanguage: 'zh-Hans',
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-Hans', languageCode: 'zh-Hans', name: { simpleText: '中文（中国）' } },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr', languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } },
      ],
    },
  },
};

function buildFixtureSnapshot(tabId, options) {
  const opts = options || {};
  const yt = core.extractYtPlayerSnapshot({ playerResponse: PLAYER_RESPONSE });
  const cues = opts.youtube === false ? [] : core.parseTimedtextJson3(TIMEDTEXT_JSON3);
  const contentText = [
    '用 Chrome 侧边栏接管你的浏览器上下文',
    '这篇页面讲的是如何把当前网页正文、选中文本与视频字幕同步给 DSH agent，让用户在侧边栏直接提问。',
    '侧边栏宽度只有 320–500px，所以 UI 必须适配窄屏；iframe 指向 bridge 代理源，避免第三方 cookie 与 SameSite 限制。',
    '内容抽取要防御性：正文截断到 60000 字符、字幕 5000 条 / 80000 字符，跨域 iframe 不读，chrome:// 跳过。',
  ].join('\n\n');

  return core.buildSnapshot({
    tabId,
    windowId: 1,
    active: true,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: yt ? yt.title : '示例视频页',
    siteName: 'YouTube',
    selection: '把当前网页正文、选中文本与视频字幕同步给 DSH agent',
    meta: {
      description: '演示快照：YouTube 视频页 + 中文字幕。',
      ogImage: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      author: yt ? yt.author : '示例频道',
      publishedAt: '2026-01-02T03:04:05Z',
      lang: 'zh',
    },
    content: { text: contentText },
    video: {
      kind: 'youtube',
      title: yt ? yt.title : '',
      author: yt ? yt.author : '',
      durationSec: yt ? yt.durationSec : 0,
      currentTimeSec: 128.5,
      transcriptSource: cues.length ? 'youtube-captions' : 'page-text',
      cues,
    },
    limits: core.settingsToLimits(core.normalizeSettings({})),
  });
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoints = core.buildBridgeEndpoints(args.bridge);
  const snapshot = buildFixtureSnapshot(args.tabId, { youtube: args.youtube });
  if (args.write) {
    writeFileSync(args.write, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`[verify] 已写出快照 JSON：${args.write}`);
  }
  console.log(`\n[verify] bridge: ${endpoints.base}`);
  console.log(`[verify] 本地快照：id=${snapshot.id} tab=${snapshot.tabId} chars=${snapshot.content.charCount} cues=${snapshot.video.transcript.length}\n`);

  return (async () => {
    const validation = core.validateSnapshot(snapshot);
    check('本地快照符合规格结构', validation.ok, validation.ok ? `${Object.keys(snapshot).length} 个顶层字段` : validation.errors.join('; '));
    check('快照体积在规格上限内', snapshot.content.charCount <= 60000 && snapshot.video.transcript.length <= 5000);

    const health = await net.getJson(endpoints.health, { timeoutMs: 3000 });
    check('GET /__bridge/health 可达', health.ok, health.ok ? `version=${health.data && health.data.version} upstream=${JSON.stringify(health.data && health.data.upstream)}` : health.error);

    const post = await net.postJson(endpoints.context, snapshot, { timeoutMs: 3000 });
    check('POST /__bridge/context 成功', post.ok, post.ok ? `id=${post.data.id} updatedAt=${post.data.updatedAt}` : post.error);
    if (post.ok) {
      // mock bridge 会回显客户端 id；真实 sidecar 由服务端生成 id（扩展不依赖这一点）
      const sameId = post.data.id === snapshot.id;
      check('POST 返回可用的 id/updatedAt', typeof post.data.id === 'string' && post.data.id.length > 0
        && !Number.isNaN(Date.parse(post.data.updatedAt)),
      sameId ? '与客户端 id 一致（mock 行为）' : '服务端生成了新 id（真实 bridge 行为，符合预期）');
    }

    const latest = await net.getJson(`${endpoints.latest}?tabId=${args.tabId}&windowId=1`, { timeoutMs: 3000 });
    check('GET /__bridge/context/latest 能取回快照', latest.ok, latest.ok ? `title=${latest.data.title}` : latest.error);
    if (latest.ok) {
      const received = latest.data;
      check('回读结构与规格一致', core.validateSnapshot(received).ok);
      check('回读 tabId/active 正确', received.tabId === args.tabId && received.active === true);
      check('回读 content.text 与推送一致', received.content.text === snapshot.content.text);
      check('回读字幕条数一致', received.video.transcript.length === snapshot.video.transcript.length);
      if (args.dump) {
        console.log('\n[verify] 回读的完整快照 JSON：');
        console.log(JSON.stringify(received, null, 2));
      }
    }

    const list = await net.getJson(endpoints.list, { timeoutMs: 3000 });
    check('GET /__bridge/context/list 可用', list.ok, list.ok ? `tabs=${(list.data.tabs || []).length}` : list.error);

    const failed = results.filter((item) => !item.ok);
    console.log(`\n[verify] ${results.length - failed.length}/${results.length} 项通过`);
    process.exitCode = failed.length ? 1 : 0;
  })().catch((error) => {
    console.error(`\n[verify] 异常：${(error && error.stack) || error}`);
    process.exitCode = 1;
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
