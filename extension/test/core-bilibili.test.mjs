/**
 * B 站（bilibili）字幕链路 的单元测试（全部离线，网络/DOM 打桩）
 * 覆盖：URL 解析、__INITIAL_STATE__ 归一化、字幕轨优先级、player/v2 解析、
 *      subtitle_url 协议相对、{body:[{from,to,content}]} 解析（秒/毫秒/BOM）、截断、快照枚举。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.mjs';

const {
  LIMITS,
  parseBilibiliUrl,
  extractBiliInitialState,
  buildBiliPlayerV2Url,
  normalizeProtocolRelativeUrl,
  isAllowedBiliFetchUrl,
  parseBiliPlayerv2Response,
  parseBiliPlayerv2Text,
  pickBiliSubtitleTrack,
  detectBiliTimeUnit,
  biliCueTimesToSeconds,
  parseBiliSubtitleResponse,
  parseBiliSubtitleText,
  trimTranscript,
  buildSnapshot,
  validateSnapshot,
  snapshotSummary,
} = core;

const PROBE = {
  hasInitialState: true,
  bvid: 'BV1MEW46JEYB',
  aid: 117584796260038,
  cid: 43455155073,
  title: '【测试】用 10 分钟讲清楚浏览器扩展',
  durationSec: 634,
  author: '示例 UP 主',
  pageCount: 2,
  pageIndex: 2,
  pageNo: 2,
  subtitleTracks: [
    { lan: 'zh-Hans', lanDoc: '中文（简体）', url: '//aisubtitle.hdslb.com/bfs/subtitle/cc.json', isAi: false, isLock: false },
    { lan: 'ai-zh', lanDoc: '中文（自动生成）', url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/ai.json', isAi: true, isLock: false },
  ],
};

const RAW_STATE = {
  bvid: 'BV1MEW46JEYB',
  aid: 117584796260038,
  videoData: {
    bvid: 'BV1MEW46JEYB',
    aid: 117584796260038,
    cid: 111,
    title: '【测试】分 P 视频',
    duration: 300,
    owner: { name: '某 UP' },
    pageNo: 2,
    pages: [
      { cid: 111, part: 'P1' },
      { cid: 222, part: 'P2' },
    ],
    subtitle: {
      allow_submit: false,
      list: [
        { lan: 'zh-Hans', lan_doc: '中文（简体）', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/p2.json', is_lock: false },
        { lan: 'en-US', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/en.json', is_lock: true },
      ],
    },
  },
};

test('parseBilibiliUrl：BV / av / 分 P / 非视频页', () => {
  const bv = parseBilibiliUrl('https://www.bilibili.com/video/BV1MEW46JEYB/?p=2&t=30');
  assert.equal(bv.isBilibili, true);
  assert.equal(bv.isVideoPage, true);
  assert.equal(bv.bvid, 'BV1MEW46JEYB');
  assert.equal(bv.pageIndex, 2);

  const av = parseBilibiliUrl('https://www.bilibili.com/video/av123456');
  assert.equal(av.isVideoPage, true);
  assert.equal(av.aid, 123456);

  const space = parseBilibiliUrl('https://space.bilibili.com/123456');
  assert.equal(space.isBilibili, true);
  assert.equal(space.isVideoPage, false);

  const read = parseBilibiliUrl('https://www.bilibili.com/read/cv123456');
  assert.equal(read.isBilibili, true);
  assert.equal(read.isVideoPage, false);

  assert.equal(parseBilibiliUrl('https://www.youtube.com/watch?v=x').isBilibili, false);
  assert.equal(parseBilibiliUrl('chrome://settings').isBilibili, false);
  assert.equal(parseBilibiliUrl('').isBilibili, false);
});

test('extractBiliInitialState：探针结果（bvid/aid/cid/分P/字幕轨）', () => {
  const state = extractBiliInitialState({ probe: PROBE });
  assert.equal(state.bvid, 'BV1MEW46JEYB');
  assert.equal(state.aid, 117584796260038);
  assert.equal(state.cid, 43455155073);
  assert.equal(state.title, '【测试】用 10 分钟讲清楚浏览器扩展');
  assert.equal(state.durationSec, 634);
  assert.equal(state.author, '示例 UP 主');
  assert.equal(state.pageCount, 2);
  assert.equal(state.pageIndex, 2);
  assert.equal(state.subtitleTracks.length, 2);
  assert.equal(state.subtitleTracks[0].lanDoc, '中文（简体）');
  assert.equal(state.subtitleTracks[1].isAi, true);
});

test('extractBiliInitialState：原始 __INITIAL_STATE__（videoData.subtitle.list）', () => {
  const state = extractBiliInitialState({ __INITIAL_STATE__: RAW_STATE });
  assert.ok(state);
  assert.equal(state.bvid, 'BV1MEW46JEYB');
  assert.equal(state.title, '【测试】分 P 视频');
  assert.equal(state.author, '某 UP');
  assert.equal(state.pageIndex, 2);
  // 分 P 的 cid 必须取当前页（pages[1].cid=222），而不是 videoData.cid=111
  assert.equal(state.cid, 222);
  assert.equal(state.subtitleTracks.length, 2);
  assert.equal(state.subtitleTracks[0].url, '//aisubtitle.hdslb.com/bfs/subtitle/p2.json');
  assert.equal(state.subtitleTracks[1].isLock, true);
});

test('extractBiliInitialState：空输入/无意义输入返回 null', () => {
  assert.equal(extractBiliInitialState(null), null);
  assert.equal(extractBiliInitialState({}), null);
  assert.equal(extractBiliInitialState({ probe: {} }), null);
  // 只有标题也保留（至少能当 page-text 的标题）
  const onlyTitle = extractBiliInitialState({ probe: { title: '只有标题' } });
  assert.equal(onlyTitle.title, '只有标题');
  assert.deepEqual(onlyTitle.subtitleTracks, []);
});

test('buildBiliPlayerV2Url：bvid 优先，aid 兜底，缺 cid 返回空串', () => {
  const byBv = buildBiliPlayerV2Url({ bvid: 'BV1MEW46JEYB', cid: 43455155073 });
  assert.ok(byBv.startsWith('https://api.bilibili.com/x/player/v2?'));
  assert.ok(byBv.includes('cid=43455155073'));
  assert.ok(byBv.includes('bvid=BV1MEW46JEYB'));

  const byAid = buildBiliPlayerV2Url({ aid: 123456, cid: 789 });
  assert.ok(byAid.includes('aid=123456'));

  assert.equal(buildBiliPlayerV2Url({ bvid: 'BV1', cid: 0 }), '');
  assert.equal(buildBiliPlayerV2Url({ cid: 5 }), '');
});

test('normalizeProtocolRelativeUrl / isAllowedBiliFetchUrl：白名单', () => {
  assert.equal(
    normalizeProtocolRelativeUrl('//aisubtitle.hdslb.com/bfs/ai_subtitle/x.json'),
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/x.json',
  );
  assert.equal(normalizeProtocolRelativeUrl('http://api.bilibili.com/x'), 'https://api.bilibili.com/x');
  assert.equal(normalizeProtocolRelativeUrl('https://api.bilibili.com/x'), 'https://api.bilibili.com/x');
  assert.equal(normalizeProtocolRelativeUrl(''), '');

  assert.equal(isAllowedBiliFetchUrl('https://api.bilibili.com/x/player/v2?cid=1'), true);
  assert.equal(isAllowedBiliFetchUrl('//aisubtitle.hdslb.com/bfs/x.json'), true);
  assert.equal(isAllowedBiliFetchUrl('https://i0.hdslb.com/bfs/x.jpg'), true);
  assert.equal(isAllowedBiliFetchUrl('https://upos-sz-mirrorbilivideo.bilivideo.com/x'), true);
  assert.equal(isAllowedBiliFetchUrl('https://api.bilibili.com.evil.com/x'), false);
  // http 会被静默升级成 https（浏览器侧安全上下文），所以仍属于允许的主机
  assert.equal(isAllowedBiliFetchUrl('http://api.bilibili.com/x'), true);
  assert.equal(isAllowedBiliFetchUrl('http://evil.com/x'), false);
  assert.equal(isAllowedBiliFetchUrl('https://evil.com/x'), false);
  assert.equal(isAllowedBiliFetchUrl(''), false);
});

test('parseBiliPlayerv2Response：正常字幕轨 / 空列表 / 非零 code / 非法输入', () => {
  const ok = parseBiliPlayerv2Response({
    code: 0,
    message: '0',
    data: {
      login_mid: 0,
      subtitle: {
        allow_submit: false,
        subtitles: [
          { lan: 'zh-Hans', lan_doc: '中文（简体）', subtitle_url: '//aisubtitle.hdslb.com/cc.json', is_lock: false },
          { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/ai.json', is_lock: false },
          { lan: 'en-US', lan_doc: 'English' }, // 没有 url → 丢弃
        ],
      },
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  assert.equal(ok.subtitles.length, 2);
  assert.equal(ok.subtitles[1].isAi, true);

  // 未登录：subtitles 为空数组，但请求本身是成功的
  const empty = parseBiliPlayerv2Response({ code: 0, data: { login_mid: 0, subtitle: { subtitles: [] } } });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.subtitles, []);

  // 风控/未登录错误码
  const denied = parseBiliPlayerv2Response({ code: -352, message: '风控校验失败' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, -352);
  assert.ok(denied.message.includes('风控'));

  assert.equal(parseBiliPlayerv2Response(null).ok, false);
  assert.equal(parseBiliPlayerv2Response({ code: 0 }).subtitles.length, 0);
});

test('parseBiliPlayerv2Text：容错 BOM 与坏 JSON', () => {
  const text = `\uFEFF${JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-Hans', subtitle_url: '//aisubtitle.hdslb.com/a.json' }] } } })}`;
  const parsed = parseBiliPlayerv2Text(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.subtitles.length, 1);

  const broken = parseBiliPlayerv2Text('<html>not json</html>');
  assert.equal(broken.ok, false);
  assert.ok(broken.message.includes('解析失败'));
  assert.equal(parseBiliPlayerv2Text('').ok, false);
});

test('pickBiliSubtitleTrack：zh-Hans/zh-CN > ai-zh > 其它 zh* > 其它', () => {
  const tracks = [
    { lan: 'en-US', url: 'https://aisubtitle.hdslb.com/en.json' },
    { lan: 'zh-Hant', url: 'https://aisubtitle.hdslb.com/hant.json' },
    { lan: 'ai-zh', url: 'https://aisubtitle.hdslb.com/ai.json', isAi: true },
    { lan: 'zh-CN', url: 'https://aisubtitle.hdslb.com/cn.json' },
    { lan: 'zh-Hans', url: 'https://aisubtitle.hdslb.com/hans.json' },
  ];
  const best = pickBiliSubtitleTrack(tracks);
  assert.equal(best.lan, 'zh-Hans');

  const noHans = tracks.filter((track) => track.lan !== 'zh-Hans');
  assert.equal(pickBiliSubtitleTrack(noHans).lan, 'zh-CN');

  // 去掉 zh-Hans/zh-CN 后，ai-zh 优先于其它 zh*（符合「官方 CC > AI 字幕」的取舍）
  const onlyAi = tracks.filter((track) => track.lan !== 'zh-Hans' && track.lan !== 'zh-CN');
  assert.equal(pickBiliSubtitleTrack(onlyAi).lan, 'ai-zh');

  // 没有中文时，其它 zh* 优先于英文
  const noHansCnAi = tracks.filter((track) => ['zh-Hans', 'zh-CN', 'ai-zh'].indexOf(track.lan) < 0);
  assert.equal(pickBiliSubtitleTrack(noHansCnAi).lan, 'zh-Hant');

  const onlyEn = tracks.filter((track) => track.lan === 'en-US');
  assert.equal(pickBiliSubtitleTrack(onlyEn).lan, 'en-US');

  assert.equal(pickBiliSubtitleTrack([]), null);
  assert.equal(pickBiliSubtitleTrack([{ lan: 'zh', subtitle_url: '' }]), null);
});

test('detectBiliTimeUnit：时长提示 / 显式单位 / 大数兜底', () => {
  // 明确秒：最大值远小于时长
  assert.equal(detectBiliTimeUnit([{ start: 0, end: 120 }], { durationSec: 600 }), 1);
  // 毫秒：最大值超过「时长*2+30」
  assert.equal(detectBiliTimeUnit([{ start: 0, end: 120000 }], { durationSec: 600 }), 1000);
  // 短毫秒视频（4 秒）也能识别
  assert.equal(detectBiliTimeUnit([{ start: 2500, end: 4100 }], { durationSec: 4 }), 1000);
  // 无时长兜底阈值
  assert.equal(detectBiliTimeUnit([{ start: 125000, end: 127000 }]), 1000);
  assert.equal(detectBiliTimeUnit([{ start: 0, end: 40 }]), 1);
  // 显式覆盖
  assert.equal(detectBiliTimeUnit([{ start: 0, end: 2000 }], { assumeUnit: 'ms' }), 1000);
  assert.equal(detectBiliTimeUnit([{ start: 0, end: 2000 }], { assumeUnit: 's' }), 1);
});

test('biliCueTimesToSeconds：秒/毫秒两种格式', () => {
  assert.deepEqual(biliCueTimesToSeconds(2.5, 4.1), { start: 2.5, end: 4.1 });
  assert.deepEqual(biliCueTimesToSeconds(2500, 4100, { assumeUnit: 'ms' }), { start: 2.5, end: 4.1 });
  assert.deepEqual(biliCueTimesToSeconds(0, 2000, { durationSec: 4 }), { start: 0, end: 2 });
});

test('parseBiliSubtitleResponse：正常 CC 字幕（秒）', () => {
  const cues = parseBiliSubtitleResponse({
    body: [
      { from: 0, to: 2.53, content: '大家好，欢迎收看' },
      { from: 2.53, to: 5.1, content: '这期视频聊聊浏览器扩展' },
      { from: 5.1, to: 7.8, content: '' }, // 空文本跳过
    ],
  }, { durationSec: 634 });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '大家好，欢迎收看');
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 2.53);
  assert.equal(cues[1].start, 2.53);
});

test('parseBiliSubtitleResponse：AI 字幕（毫秒）+ 时长提示', () => {
  const cues = parseBiliSubtitleResponse({
    body: [
      { from: 0, to: 2500, content: '第一句' },
      { from: 2500, to: 5100, content: '第二句' },
    ],
  }, { durationSec: 6 });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].end, 2.5);
  assert.equal(cues[1].start, 2.5);
  assert.equal(cues[1].end, 5.1);
});

test('parseBiliSubtitleResponse：无时长时的大数毫秒兜底', () => {
  const cues = parseBiliSubtitleResponse({
    body: [{ from: 125000, to: 127000, content: '半小时处的一句' }],
  });
  assert.equal(cues[0].start, 125);
  assert.equal(cues[0].end, 127);
});

test('parseBiliSubtitleResponse：数组直接传入 / 空 body / 非法输入', () => {
  const fromArray = parseBiliSubtitleResponse([{ from: 0, to: 1, content: 'x' }], { durationSec: 60 });
  assert.equal(fromArray.length, 1);
  assert.deepEqual(parseBiliSubtitleResponse({ body: [] }), []);
  assert.deepEqual(parseBiliSubtitleResponse({}), []);
  assert.deepEqual(parseBiliSubtitleResponse(null), []);
});

test('parseBiliSubtitleText：容错 BOM、保留换行、坏 JSON 返回空', () => {
  const json = JSON.stringify({ body: [{ from: 0, to: 2, content: '第一行\n第二行' }] });
  const cues = parseBiliSubtitleText(`\uFEFF${json}`, { durationSec: 300 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, '第一行\n第二行');

  assert.deepEqual(parseBiliSubtitleText('not json'), []);
  assert.deepEqual(parseBiliSubtitleText(''), []);
  assert.deepEqual(parseBiliSubtitleText(null), []);
});

test('B 站字幕同样受 5000 条 / 80000 字符上限约束', () => {
  const body = Array.from({ length: 6000 }, (_, i) => ({
    from: i,
    to: i + 1,
    content: `第${String(i).padStart(4, '0')}句字幕`, // 每条 8 字，互不相同
  }));
  const cues = parseBiliSubtitleResponse({ body }, { durationSec: 6001 });
  assert.equal(cues.length, 6000);
  const trimmed = trimTranscript(cues, { maxItems: LIMITS.transcriptItems, maxChars: LIMITS.transcriptChars });
  assert.equal(trimmed.itemCount, 5000);
  assert.equal(trimmed.truncated, true);

  const charsBody = Array.from({ length: 10000 }, (_, i) => ({ from: i, to: i + 1, content: String(i).padStart(10, '0') }));
  const charsCues = parseBiliSubtitleResponse({ body: charsBody }, { durationSec: 10001 });
  const charTrimmed = trimTranscript(charsCues, { maxItems: 10000, maxChars: 80000 });
  assert.equal(charTrimmed.charCount, 80000);
  assert.equal(charTrimmed.truncated, true);
});

test('快照枚举：kind=bilibili + bilibili-page/bilibili-api 合法，非法值被拒', () => {
  const makeVideo = (kind, source) => ({
    kind,
    title: 'B 站视频',
    author: 'UP 主',
    durationSec: 634,
    currentTimeSec: 30,
    transcriptSource: source,
    cues: [{ start: 0, end: 2.5, text: '第一句' }],
  });

  const pageSnap = buildSnapshot({
    tabId: 1,
    windowId: 1,
    active: true,
    url: 'https://www.bilibili.com/video/BV1MEW46JEYB/',
    title: 'B 站视频',
    content: { text: '页面正文' },
    video: makeVideo('bilibili', 'bilibili-page'),
  });
  assert.equal(validateSnapshot(pageSnap).ok, true);
  assert.equal(pageSnap.video.kind, 'bilibili');
  assert.equal(pageSnap.video.transcriptSource, 'bilibili-page');

  const apiSnap = buildSnapshot({
    tabId: 1,
    windowId: 1,
    url: 'https://www.bilibili.com/video/BV1MEW46JEYB/',
    title: 'B 站视频',
    content: { text: '页面正文' },
    video: makeVideo('bilibili', 'bilibili-api'),
  });
  assert.equal(validateSnapshot(apiSnap).ok, true);

  const badSource = buildSnapshot({
    tabId: 1,
    windowId: 1,
    url: 'https://www.bilibili.com/video/BV1',
    content: { text: 'x' },
    video: makeVideo('bilibili', 'bilibili-cc'),
  });
  assert.equal(validateSnapshot(badSource).ok, false);

  const badKind = buildSnapshot({
    tabId: 1,
    windowId: 1,
    url: 'https://www.bilibili.com/video/BV1',
    content: { text: 'x' },
    video: makeVideo('mp4', 'page-text'),
  });
  assert.equal(validateSnapshot(badKind).ok, false);
});

test('snapshotSummary：B 站快照的摘要文案', () => {
  const snap = buildSnapshot({
    tabId: 1,
    windowId: 1,
    url: 'https://www.bilibili.com/video/BV1MEW46JEYB/',
    title: 'B 站视频',
    content: { text: '页面正文' },
    video: {
      kind: 'bilibili',
      title: 'B 站视频',
      transcriptSource: 'bilibili-page',
      cues: [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }],
    },
  });
  const summary = snapshotSummary(snap);
  assert.ok(summary.label.includes('B 站'), summary.label);
  assert.ok(summary.label.includes('2 条字幕'), summary.label);
});
