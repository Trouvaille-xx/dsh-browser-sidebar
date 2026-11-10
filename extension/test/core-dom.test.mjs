/**
 * DOM 抽取 的单元测试（用 helpers.mjs 里的最小 DOM stub，不依赖 jsdom）
 * 覆盖：正文容器选择、噪音剔除、表单一律不读、元数据、选中文本、<video> 字幕轨、视频页文字兜底。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  core,
  h,
  p,
  meta,
  makeDocument,
  makeArticleDocument,
  makeVideo,
  makeWindow,
  SAMPLE_SELECTION,
} from './helpers.mjs';

const {
  LIMITS,
  extractMainContent,
  extractTitle,
  extractMeta,
  extractSelection,
  extractVideoInfo,
  collectPageTextLines,
  collectVisibleText,
  readVideoTracks,
  pickPrimaryVideo,
} = core;

test('extractMainContent：优先 article，剔除 nav/aside/footer/script/style', () => {
  const doc = makeArticleDocument();
  const out = extractMainContent(doc);
  assert.equal(out.source, 'article');
  assert.equal(out.selector, 'article');
  assert.ok(out.text.includes('这是正文第一段'));
  assert.ok(out.text.includes('引用内容也应该保留'));
  assert.ok(!out.text.includes('首页'), 'nav 链接不应进入正文');
  assert.ok(!out.text.includes('版权所有'), 'footer 不应进入正文');
  assert.ok(!out.text.includes('侧边栏广告'), 'aside 不应进入正文');
  assert.ok(!out.text.includes('shouldNotAppear'), 'script 不应进入正文');
  assert.ok(!out.text.includes('站点标题'), 'header 不应进入正文');
  assert.ok(out.charCount > 0);
  assert.equal(out.truncated, false);
});

test('extractMainContent：无 article/main 时退化到 body 并做噪音过滤', () => {
  const body = h('body', {},
    h('div', {}, p('这是全页退化模式下的一段正文，长度足够触发正文阈值判断，需要被完整保留下来。')),
    h('div', {}, p('这是第二段正文，同样需要被保留下来，用于验证噪音过滤不会误删正常内容。')),
    h('div', {}, p('广告')),
    h('div', {}, p('首页')),
    h('form', {}, h('textarea', {}, '表单里的秘密内容')));
  const doc = makeDocument({ title: '无正文容器页', body });
  const out = extractMainContent(doc);
  assert.equal(out.source, 'body');
  assert.ok(out.text.includes('这是全页退化模式下的一段正文'));
  assert.ok(!out.text.includes('广告'));
  assert.ok(!out.text.includes('首页'));
  assert.ok(!out.text.includes('表单里的秘密内容'), 'textarea 内容不应被读取');
});

test('extractMainContent：超长正文按 60000 字符截断并标记', () => {
  const huge = '超长正文段落。'.repeat(12000); // 84000 字符
  const body = h('body', {}, h('article', {}, p(huge)));
  const doc = makeDocument({ body });
  const out = extractMainContent(doc, { maxChars: LIMITS.contentChars });
  assert.equal(out.truncated, true);
  assert.ok(out.charCount <= LIMITS.contentChars, `charCount=${out.charCount}`);
});

test('extractMainContent：空文档/无内容返回 none', () => {
  assert.equal(extractMainContent(null).source, 'none');
  const doc = makeDocument({ body: h('body', {}) });
  assert.equal(extractMainContent(doc).source, 'none');
});

test('collectVisibleText：跳过隐藏节点与 aria-hidden 区域', () => {
  const root = h('div', {},
    p('可见内容'),
    h('div', { style: 'display: none' }, p('隐藏内容')),
    h('div', { 'aria-hidden': 'true' }, p('无障碍隐藏内容')));
  const text = collectVisibleText(root);
  assert.ok(text.includes('可见内容'));
  assert.ok(!text.includes('隐藏内容'));
  assert.ok(!text.includes('无障碍隐藏内容'));
});

test('extractTitle：og:title > twitter:title > title > h1', () => {
  const withOg = makeArticleDocument({ ogTitle: 'OG 标题', title: 'HTML 标题' });
  assert.equal(extractTitle(withOg), 'OG 标题');

  const noOg = makeDocument({
    title: 'HTML 标题',
    body: h('body', {}, h('h1', {}, 'H1 标题')),
  });
  assert.equal(extractTitle(noOg), 'HTML 标题');

  const onlyH1 = makeDocument({ body: h('body', {}, h('h1', {}, 'H1 标题')) });
  assert.equal(extractTitle(onlyH1), 'H1 标题');

  assert.equal(extractTitle(makeDocument({})), '');
});

test('extractMeta：description/ogImage(绝对化)/author/publishedAt/lang', () => {
  const doc = makeArticleDocument({ author: '张三', lang: 'zh-CN' });
  const metaOut = extractMeta(doc, 'https://example.com/post/1');
  assert.equal(metaOut.description, '这是一段用于测试的页面摘要描述。');
  assert.equal(metaOut.ogImage, 'https://example.com/cover.png');
  assert.equal(metaOut.author, '张三');
  assert.equal(metaOut.publishedAt, '2026-01-02T03:04:05Z');
  assert.equal(metaOut.lang, 'zh');
});

test('extractMeta：缺失字段一律空字符串（结构稳定）', () => {
  const doc = makeDocument({ body: h('body', {}) });
  const metaOut = extractMeta(doc, 'https://example.com');
  assert.deepEqual(metaOut, { description: '', ogImage: '', author: '', publishedAt: '', lang: '' });
});

test('extractSelection：读取 window.getSelection，超长截断', () => {
  assert.equal(extractSelection(makeWindow(SAMPLE_SELECTION)), SAMPLE_SELECTION);
  assert.equal(extractSelection(makeWindow('')), '');
  assert.equal(extractSelection(null), '');
  assert.equal(extractSelection({}), '');

  const long = 'x'.repeat(LIMITS.selectionChars + 500);
  const out = extractSelection(makeWindow(long));
  assert.equal(out.length, LIMITS.selectionChars);
});

test('readVideoTracks：读 subtitles/captions 轨的 cues，跳过其他 kind', () => {
  const video = makeVideo({
    tracks: [
      { kind: 'subtitles', cues: [{ start: 0, end: 2, text: '第一句' }, { start: 2, end: 4, text: '第二句' }] },
      { kind: 'chapters', cues: [{ start: 0, end: 1, text: '章节' }] },
    ],
  });
  const cues = readVideoTracks(video);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '第一句');
  assert.equal(video.textTracks[0].mode, 'hidden', 'disabled 轨应切到 hidden 以便取 cues');
});

test('extractVideoInfo：有字幕轨 → transcriptSource=track', () => {
  const video = makeVideo({
    duration: 754,
    currentTime: 12.5,
    attrs: { title: '视频标题' },
    tracks: [{ kind: 'subtitles', cues: [{ start: 0, end: 2.5, text: '字幕一' }] }],
  });
  const doc = makeDocument({ body: h('body', {}, video, p('视频简介文本')) });
  const info = extractVideoInfo(doc, 'https://example.com/video');
  assert.equal(info.kind, 'html5');
  assert.equal(info.title, '视频标题');
  assert.equal(info.durationSec, 754);
  assert.equal(info.currentTimeSec, 12.5);
  assert.equal(info.transcriptSource, 'track');
  assert.equal(info.cues.length, 1);
});

test('extractVideoInfo：有 <video> 无字幕轨 → transcriptSource=page-text', () => {
  const video = makeVideo({ duration: 60, currentTime: 0 });
  const doc = makeDocument({
    head: [meta('og:title', '兜底视频标题', 'property')],
    body: h('body', {}, video, p('这里是视频页面上的简介文字，长度够用。')),
  });
  const info = extractVideoInfo(doc, 'https://example.com/video');
  assert.equal(info.kind, 'html5');
  assert.equal(info.transcriptSource, 'page-text');
  assert.equal(info.cues.length, 0);
  assert.equal(info.title, '兜底视频标题');
});

test('extractVideoInfo：页面无 video → kind=none', () => {
  const doc = makeDocument({ body: h('body', {}, p('普通文章')) });
  const info = extractVideoInfo(doc, 'https://example.com');
  assert.equal(info.kind, 'none');
  assert.equal(info.transcriptSource, 'none');
  assert.equal(pickPrimaryVideo(doc), null);
});

test('collectPageTextLines：标题 + 摘要 + 首屏段落，去重且有上限', () => {
  const doc = makeDocument({
    title: '视频页标题',
    head: [
      meta('og:title', '视频页标题', 'property'),
      meta('description', '这是视频页的摘要描述，用于兜底。'),
    ],
    body: h('body', {},
      h('h1', {}, '视频页标题'),
      p('这是视频页的第一段文字内容，足够长以便进入兜底字幕。'),
      p('这是视频页的第二段文字内容，同样足够长。'),
      p('这是视频页的第一段文字内容，足够长以便进入兜底字幕。')), // 重复
  });
  const out = collectPageTextLines(doc, { pageUrl: 'https://example.com/v' });
  assert.ok(out.lines.length >= 3);
  assert.equal(out.lines[0], '视频页标题');
  assert.ok(out.lines.includes('这是视频页的摘要描述，用于兜底。'));
  // 重复行被去重
  assert.equal(out.lines.filter((l) => l.startsWith('这是视频页的第一段')).length, 1);
  assert.ok(out.charCount > 0);
  assert.equal(out.truncated, false);
});

test('collectPageTextLines：maxLines/maxChars 生效', () => {
  const paragraphs = Array.from({ length: 30 }, (_, i) => p(`第${i}段视频页文字，长度足够用于测试行数上限。`));
  const doc = makeDocument({ body: h('body', {}, ...paragraphs) });
  const out = collectPageTextLines(doc, { maxLines: 5, maxChars: 120 });
  assert.ok(out.lines.length <= 5, `lines=${out.lines.length}`);
  assert.ok(out.charCount <= 120);
});
