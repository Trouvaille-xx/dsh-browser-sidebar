/**
 * `browser_page` tool handler: pure output shape, truncation, tab selection and
 * the no-context prompt. These tests never touch HTTP.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBrowserPageTool } from '../tools.js';
import { ContextStore } from '../context-store.js';
import { LIMITS, NO_CONTEXT_TEXT, resolveMaxChars } from '../core.js';

function snapshot(overrides = {}) {
  return {
    tabId: 11,
    windowId: 1,
    active: true,
    url: 'https://www.youtube.com/watch?v=abc123',
    title: '一个很有意思的视频',
    siteName: 'YouTube',
    capturedAt: new Date(Date.now() - 120000).toISOString(),
    selection: '',
    meta: { description: '视频简介', author: '某频道', publishedAt: '2026-01-01', lang: 'zh' },
    content: { text: '这是页面正文第一段。\n这是第二段。', charCount: 20 },
    ...overrides,
  };
}

function transcriptSnapshot() {
  const transcript = Array.from({ length: 120 }, (_, index) => ({
    start: index * 3,
    end: index * 3 + 3,
    text: '第' + (index + 1) + '句字幕内容',
  }));
  return snapshot({
    video: {
      kind: 'youtube',
      title: '视频标题',
      author: '频道名',
      durationSec: 600,
      currentTimeSec: 30,
      transcriptSource: 'youtube-captions',
      transcript,
    },
  });
}

function storeWith(...snapshots) {
  const store = new ContextStore();
  for (const entry of snapshots) store.upsert(entry);
  return store;
}

describe('browser_page tool', () => {
  const tool = createBrowserPageTool({ store: new ContextStore() });

  it('declares a valid raw ToolDefinition with a JSON-Schema parameter object', () => {
    assert.equal(tool.name, 'browser_page');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual([...tool.parameters.required], ['mode']);
    assert.deepEqual(tool.parameters.properties.mode.enum, ['summary', 'page', 'selection', 'video', 'transcript']);
    assert.equal(tool.output.schema.type, 'object');
    assert.deepEqual([...tool.output.schema.required], ['ok', 'text']);
    const blocks = tool.output.render({ mode: 'summary' }, { ok: true, text: 'hi' });
    assert.deepEqual(blocks, [{ type: 'text', text: 'hi' }]);
  });

  it('returns an actionable prompt and ok=false when nothing was synced', async () => {
    const empty = createBrowserPageTool({ store: new ContextStore() });
    for (const mode of ['summary', 'page', 'selection', 'video', 'transcript']) {
      const result = await empty.execute({ mode });
      assert.equal(result.ok, false);
      assert.equal(result.text, NO_CONTEXT_TEXT);
      assert.match(result.text, /读取当前页/);
    }
  });

  it('summary names the source, the content and the video state', async () => {
    const wired = createBrowserPageTool({ store: storeWith(transcriptSnapshot()) });
    const result = await wired.execute({ mode: 'summary' });
    assert.equal(result.ok, true);
    assert.match(result.text, /一个很有意思的视频/);
    assert.match(result.text, /youtube\.com\/watch\?v=abc123/);
    assert.match(result.text, /抓取时间/);
    assert.match(result.text, /正文：\d+ 字/);
    assert.match(result.text, /正文：17 字/);
    assert.match(result.text, /选中文本：无/);
    assert.match(result.text, /视频：youtube《视频标题》/);
    assert.match(result.text, /字幕 120 条/);
    assert.match(result.text, /可用 mode/);
  });

  it('page returns the body with the source header and honours maxChars', async () => {
    const longBody = '正文段落。'.repeat(400);
    const wired = createBrowserPageTool({ store: storeWith(snapshot({ content: { text: longBody, charCount: longBody.length } })) });
    const result = await wired.execute({ mode: 'page' });
    assert.match(result.text, /这是页面正文第一段|正文段落/);
    assert.match(result.text, /URL：https:\/\/www\.youtube\.com/);
    assert.ok(result.text.length < 5000, 'default page output is bounded');

    const tiny = await wired.execute({ mode: 'page', maxChars: 600 });
    assert.match(tiny.text, /已截断/);
    assert.ok(tiny.text.length <= 700, 'maxChars truncation must bound the output, got ' + tiny.text.length);
  });

  it('selection reports the selected text or explains there is none', async () => {
    const wired = createBrowserPageTool({ store: storeWith(snapshot(), snapshot({ tabId: 12, selection: '我选中的几句话' })) });
    const none = await wired.execute({ mode: 'selection', tabId: 11 });
    assert.match(none.text, /没有选中文本/);
    const selected = await wired.execute({ mode: 'selection', tabId: 12 });
    assert.match(selected.text, /我选中的几句话/);
  });

  it('video returns metadata plus a bounded transcript preview', async () => {
    const wired = createBrowserPageTool({ store: storeWith(transcriptSnapshot()) });
    const result = await wired.execute({ mode: 'video' });
    assert.match(result.text, /时长 10:00/);
    assert.match(result.text, /当前 0:30/);
    assert.match(result.text, /字幕预览（前 40 条/);
    assert.match(result.text, /\[0:00\] 第1句字幕内容/);
    assert.match(result.text, /\[1:57\] 第40句字幕内容/);
    assert.match(result.text, /还有 80 条/);
    assert.ok(!result.text.includes('第41句字幕内容'), 'preview must stop at 40 cues');
  });

  it('transcript returns every cue and respects its own default budget', async () => {
    const wired = createBrowserPageTool({ store: storeWith(transcriptSnapshot()) });
    const result = await wired.execute({ mode: 'transcript' });
    assert.match(result.text, /\[0:00\] 第1句字幕内容/);
    assert.match(result.text, /第120句字幕内容/);
    assert.match(result.text, /字幕 120 条/);
  });

  it('explains a missing video/transcript instead of inventing one', async () => {
    const wired = createBrowserPageTool({ store: storeWith(snapshot()) });
    const video = await wired.execute({ mode: 'video' });
    assert.match(video.text, /没有可用的视频信息/);
    const transcript = await wired.execute({ mode: 'transcript' });
    assert.match(transcript.text, /没有可用的视频字幕/);
  });

  it('reads the requested tab and falls back to the active one', async () => {
    const store = storeWith(
      snapshot({ tabId: 21, active: true, title: '活动标签页' }),
      snapshot({ tabId: 22, active: false, title: '后台标签页' }),
    );
    const wired = createBrowserPageTool({ store });
    const active = await wired.execute({ mode: 'summary' });
    assert.match(active.text, /活动标签页/);
    const other = await wired.execute({ mode: 'summary', tabId: 22 });
    assert.match(other.text, /后台标签页/);
    const missing = await wired.execute({ mode: 'summary', tabId: 999 });
    assert.equal(missing.ok, false);
    assert.match(missing.text, /读取当前页/);
  });

  it('rejects an unknown mode so the model gets a corrective error', async () => {
    await assert.rejects(() => tool.execute({ mode: 'raw-html' }), /mode/);
    await assert.rejects(() => tool.execute({}), /mode/);
  });

  it('clamps maxChars into the supported window', () => {
    assert.equal(resolveMaxChars(undefined, LIMITS.pageMaxChars), LIMITS.pageMaxChars);
    assert.equal(resolveMaxChars(10, LIMITS.pageMaxChars), LIMITS.toolMinMaxChars);
    assert.equal(resolveMaxChars(10 ** 9, LIMITS.pageMaxChars), LIMITS.toolHardMaxChars);
    assert.equal(resolveMaxChars(1234.7, LIMITS.pageMaxChars), 1234);
  });
});
