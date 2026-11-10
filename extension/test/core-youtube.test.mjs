/**
 * YouTube 字幕链路 的单元测试
 * 覆盖：playerResponse/probe 提取 → captionTracks 挑选 → timedtext XML(srv1/srv3) 与 JSON3 解析
 *       → normalizeCues（滚动字幕合并）→ trimTranscript（5000 条 / 80000 字符上限）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.mjs';

const {
  LIMITS,
  decodeXmlEntities,
  normalizeCaptionTracks,
  absolutizeTimedtextUrl,
  withJson3Format,
  pickCaptionTrack,
  extractYtPlayerSnapshot,
  parseTimedtextXml,
  parseTimedtextJson3,
  parseTimedtextAuto,
  normalizeCues,
  trimTranscript,
  transcriptStats,
  cuesToPlainText,
} = core;

const RAW_PLAYER_RESPONSE = {
  playabilityStatus: { status: 'OK' },
  videoDetails: {
    videoId: 'dQw4w9WgXcQ',
    title: '测试视频标题',
    author: '测试频道',
    lengthSeconds: '212',
    isLiveContent: false,
    defaultAudioLanguage: 'en',
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr',
          languageCode: 'en',
          kind: 'asr',
          name: { simpleText: 'English (auto-generated)' },
        },
        {
          baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-Hans',
          languageCode: 'zh-Hans',
          name: { runs: [{ text: '中文' }, { text: '（中国）' }] },
        },
      ],
    },
  },
};

test('extractYtPlayerSnapshot：从原始 playerResponse 取标题/频道/时长/最佳字幕', () => {
  const snap = extractYtPlayerSnapshot({ playerResponse: RAW_PLAYER_RESPONSE });
  assert.ok(snap);
  assert.equal(snap.title, '测试视频标题');
  assert.equal(snap.author, '测试频道');
  assert.equal(snap.durationSec, 212);
  assert.equal(snap.videoId, 'dQw4w9WgXcQ');
  assert.equal(snap.trackCount, 2);
  // 人工中文字幕应优先于自动英文
  assert.equal(snap.captionLang, 'zh-Hans');
  assert.ok(snap.captionsUrl.includes('timedtext'));
  assert.equal(snap.playability, 'OK');
});

test('extractYtPlayerSnapshot：从 page world 探针结果（已归一化 tracks）提取', () => {
  const probe = {
    hasPlayerResponse: true,
    title: '探针标题',
    author: '频道A',
    durationSec: 360,
    videoId: 'abc12345678',
    playability: 'OK',
    tracks: [
      { lang: 'en', name: 'English', kind: 'asr', baseUrl: '/api/timedtext?v=abc&lang=en' },
    ],
  };
  const snap = extractYtPlayerSnapshot({ probe, preferredLang: 'en' });
  assert.equal(snap.title, '探针标题');
  assert.equal(snap.durationSec, 360);
  assert.equal(snap.captionLang, 'en');
  assert.ok(snap.captionsUrl.startsWith('https://www.youtube.com/api/timedtext'));
});

test('extractYtPlayerSnapshot：无字幕/非法输入返回安全结果', () => {
  const noCaptions = extractYtPlayerSnapshot({
    probe: { title: '无字幕视频', tracks: [] },
  });
  assert.equal(noCaptions.captionsUrl, '');
  assert.equal(noCaptions.trackCount, 0);

  assert.equal(extractYtPlayerSnapshot(null), null);
  assert.equal(extractYtPlayerSnapshot({}), null);
});

test('pickCaptionTrack：人工字幕 > 自动字幕；中文优先，其次英文', () => {
  const tracks = normalizeCaptionTracks([
    { languageCode: 'ja', baseUrl: 'https://x/ja' },
    { languageCode: 'en', baseUrl: 'https://x/en' },
    { languageCode: 'zh', baseUrl: 'https://x/zh' },
    { languageCode: 'en', kind: 'asr', baseUrl: 'https://x/en-asr' },
  ]);
  assert.equal(pickCaptionTrack(tracks).lang, 'zh');
  assert.equal(pickCaptionTrack(tracks, { preferredLang: 'ja' }).lang, 'ja');
  assert.equal(pickCaptionTrack([]), null);
});

test('normalizeCaptionTracks：兼容 name.simpleText / name.runs / 已归一化结构', () => {
  const tracks = normalizeCaptionTracks([
    { languageCode: 'ko', baseUrl: 'https://x/ko', name: { simpleText: '한국어' } },
    { lang: 'fr', name: 'Français', baseUrl: 'https://x/fr' },
    { languageCode: 'de' }, // 没有 baseUrl → 丢弃
  ]);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].name, '한국어');
  assert.equal(tracks[1].name, 'Français');
});

test('absolutizeTimedtextUrl / withJson3Format', () => {
  assert.equal(absolutizeTimedtextUrl('//www.youtube.com/api/timedtext?x=1'), 'https://www.youtube.com/api/timedtext?x=1');
  assert.equal(
    absolutizeTimedtextUrl('/api/timedtext?x=1'),
    'https://www.youtube.com/api/timedtext?x=1',
  );
  assert.equal(absolutizeTimedtextUrl(''), '');
  assert.equal(
    withJson3Format('https://www.youtube.com/api/timedtext?v=1&lang=en'),
    'https://www.youtube.com/api/timedtext?v=1&lang=en&fmt=json3',
  );
  assert.equal(
    withJson3Format('https://www.youtube.com/api/timedtext?v=1&fmt=srv3'),
    'https://www.youtube.com/api/timedtext?v=1&fmt=json3',
  );
  assert.equal(withJson3Format(''), '');
});

test('decodeXmlEntities：常见实体与数字实体', () => {
  assert.equal(decodeXmlEntities('a &amp; b'), 'a & b');
  assert.equal(decodeXmlEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeXmlEntities('&#39;'), "'");
  assert.equal(decodeXmlEntities('&#x27;'), "'");
  assert.equal(decodeXmlEntities('&quot;x&quot;'), '"x"');
  assert.equal(decodeXmlEntities('&unknown;'), '&unknown;');
});

test('parseTimedtextXml：srv1 <text start/dur>', () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8" ?><transcript>',
    '<text start="0" dur="2.5">Hello &amp; welcome</text>',
    '<text start="2.5" dur="3">第二句</text>',
    '</transcript>',
  ].join('');
  const cues = parseTimedtextXml(xml);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello & welcome');
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 2.5);
  assert.equal(cues[1].start, 2.5);
  assert.equal(cues[1].end, 5.5);
});

test('parseTimedtextXml：srv3 <p t/d> + <s> 片段 + <br/>', () => {
  const xml = [
    '<timedtext format="3"><body>',
    '<p t="1200" d="3000" ac="0"><s>hello</s><s> world</s></p>',
    '<p t="4200" d="1000">second<br/>line</p>',
    '</body></timedtext>',
  ].join('');
  const cues = parseTimedtextXml(xml);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'hello world');
  assert.equal(cues[0].start, 1.2);
  assert.equal(cues[0].end, 4.2);
  assert.equal(cues[1].text, 'second\nline');
});

test('parseTimedtextXml：空/非法输入返回空数组', () => {
  assert.deepEqual(parseTimedtextXml(''), []);
  assert.deepEqual(parseTimedtextXml('<html><body>nope</body></html>'), []);
});

test('parseTimedtextJson3：segs 拼接、跳过无 segs 事件、保留换行', () => {
  const json = {
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: '第二' }, { utf8: '行' }] },
      { tStartMs: 3500, dDurationMs: 1000, segs: [{ utf8: 'line one\nline two' }] },
      { tStartMs: 4500, dDurationMs: 500 }, // 无 segs → 跳过
      { tStartMs: 5000, dDurationMs: 500, segs: [{ utf8: '   ' }] }, // 空白 → 跳过
    ],
  };
  const cues = parseTimedtextJson3(json);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, 'Hello world');
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 2);
  assert.equal(cues[2].text, 'line one\nline two');
});

test('parseTimedtextJson3：接受字符串输入，非法 JSON 返回空', () => {
  const cues = parseTimedtextJson3(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'x' }] }] }));
  assert.equal(cues.length, 1);
  assert.deepEqual(parseTimedtextJson3('{oops'), []);
  assert.deepEqual(parseTimedtextJson3(null), []);
});

test('parseTimedtextAuto：JSON 与 XML 都能自动判别', () => {
  const jsonBody = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'json3' }] }] });
  assert.equal(parseTimedtextAuto(jsonBody)[0].text, 'json3');

  const xmlBody = '<transcript><text start="0" dur="1">xml cue</text></transcript>';
  assert.equal(parseTimedtextAuto(xmlBody)[0].text, 'xml cue');

  assert.deepEqual(parseTimedtextAuto(''), []);
});

test('normalizeCues：乱序排序、合并重复、合并 YouTube 滚动累积字幕', () => {
  const cues = normalizeCues([
    { start: 2, end: 4, text: '第二句' },
    { start: 0, end: 2, text: '第一句' },
    { start: 0, end: 2, text: '第一句' },
    { start: 10, end: 13, text: 'hello' },
    { start: 10.5, end: 14, text: 'hello world' },
  ]);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map((c) => c.text), ['第一句', '第二句', 'hello world']);
  assert.equal(cues[2].start, 10);
  assert.equal(cues[2].end, 14);
});

test('normalizeCues：相同文本但间隔很远的字幕不会被误合并', () => {
  const cues = normalizeCues([
    { start: 0, end: 1, text: 'Yeah' },
    { start: 300, end: 301, text: 'Yeah' },
  ]);
  assert.equal(cues.length, 2);
});

test('normalizeCues：非法条目被丢弃', () => {
  assert.deepEqual(normalizeCues(null), []);
  assert.deepEqual(normalizeCues([{ start: 0, end: 1, text: '   ' }, null]), []);
});

test('trimTranscript：条数上限（5000 条）', () => {
  const cues = Array.from({ length: LIMITS.transcriptItems + 1000 }, (_, i) => ({
    start: i,
    end: i + 1,
    text: `第${i}条`,
  }));
  const out = trimTranscript(cues, { maxItems: LIMITS.transcriptItems, maxChars: LIMITS.transcriptChars });
  assert.equal(out.itemCount, 5000);
  assert.equal(out.transcript.length, 5000);
  assert.equal(out.truncated, true);
  assert.equal(out.transcript[0].text, '第0条');
});

test('trimTranscript：字符上限（80000 字符），放不下就截断', () => {
  // 每条 10 字符、文本互不相同（避免被「同文本合并」逻辑折叠）
  const cues = Array.from({ length: 10000 }, (_, i) => ({
    start: i,
    end: i + 1,
    text: String(i).padStart(10, '0'),
  }));
  // maxItems 给足，单独验证字符上限
  const out = trimTranscript(cues, { maxItems: 10000, maxChars: 80000 });
  assert.equal(out.itemCount, 8000);
  assert.equal(out.charCount, 80000);
  assert.equal(out.truncated, true);
});

test('trimTranscript：未超限时 truncated=false', () => {
  const out = trimTranscript([{ start: 0, end: 1, text: 'hi' }], { maxItems: 5000, maxChars: 80000 });
  assert.equal(out.itemCount, 1);
  assert.equal(out.truncated, false);
});

test('cuesToPlainText / transcriptStats', () => {
  const cues = [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2.5, text: 'b' }];
  assert.equal(cuesToPlainText(cues), 'a\nb');
  const stats = transcriptStats(cues, { maxItems: 5000, maxChars: 80000 });
  assert.equal(stats.itemCount, 2);
  assert.equal(stats.charCount, 2);
  assert.equal(stats.durationSec, 2.5);
  assert.equal(stats.truncated, false);
});
