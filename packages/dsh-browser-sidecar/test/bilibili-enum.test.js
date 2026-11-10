/**
 * B 站快照枚举：sidecar 必须接受 video.kind='bilibili' 与
 * transcriptSource='bilibili-page'|'bilibili-api'，否则扩展辛苦抓到的字幕
 * 会被服务端静默归一化成 kind='none'（v1.0 的真实 bug）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeSnapshot, summarizeSnapshot } from '../core.js';
import { ContextStore } from '../context-store.js';

function biliSnapshot(transcriptSource, cues) {
  return {
    tabId: 4242,
    windowId: 1,
    active: true,
    url: 'https://www.bilibili.com/video/BV1MEW46JEYB/',
    title: 'B 站视频',
    siteName: '哔哩哔哩',
    capturedAt: '2026-11-10T15:00:00.000Z',
    content: { text: '页面文字', charCount: 4, truncated: false },
    video: {
      kind: 'bilibili',
      title: 'B 站视频',
      author: 'UP 主',
      durationSec: 951,
      currentTimeSec: 12,
      transcriptSource,
      transcript: cues,
    },
  };
}

describe('bilibili snapshot enums', () => {
  it('keeps kind=bilibili and both bilibili transcript sources', () => {
    for (const source of ['bilibili-page', 'bilibili-api']) {
      const snapshot = sanitizeSnapshot(biliSnapshot(source, [
        { start: 0, end: 3.2, text: '第一句' },
        { start: 3.2, end: 6.8, text: '第二句' },
      ]));
      assert.equal(snapshot.video.kind, 'bilibili');
      assert.equal(snapshot.video.transcriptSource, source);
      assert.equal(snapshot.video.transcript.length, 2);
      assert.equal(summarizeSnapshot(snapshot).videoKind, 'bilibili');
    }
  });

  it('stores bilibili snapshots in the context store and summarizes the transcript', () => {
    const store = new ContextStore();
    store.upsert(biliSnapshot('bilibili-api', [{ start: 0, end: 2, text: '字幕' }]));
    const latest = store.latest();
    assert.equal(latest.video.kind, 'bilibili');
    assert.equal(latest.video.transcriptSource, 'bilibili-api');
    const row = store.list()[0];
    assert.equal(row.videoKind, 'bilibili');
    assert.equal(row.transcriptCount, 1);
  });
});
