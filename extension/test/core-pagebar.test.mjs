/**
 * 侧边栏「当前页面」状态条 的单元测试
 * 覆盖：已同步 / 未同步 / 不匹配警告 / 受限页 / 相对时间 / 标题截断 / host 规范化。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.mjs';

const {
  formatRelativeTime,
  normalizeHostLabel,
  truncateLabel,
  computePageStatus,
} = core;

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0); // 固定基准时间，避免 flaky

test('formatRelativeTime：刚刚 / 秒 / 分 / 时 / 天', () => {
  assert.equal(formatRelativeTime(0, NOW), '');
  assert.equal(formatRelativeTime(null, NOW), '');
  assert.equal(formatRelativeTime(NOW - 800, NOW), '刚刚');
  assert.equal(formatRelativeTime(NOW - 12000, NOW), '12 秒前');
  assert.equal(formatRelativeTime(NOW - 3 * 60 * 1000, NOW), '3 分钟前');
  assert.equal(formatRelativeTime(NOW - 2 * 3600 * 1000, NOW), '2 小时前');
  assert.equal(formatRelativeTime(NOW - 2 * 86400 * 1000, NOW), '2 天前');
  // 未来时间（时钟漂移）按「刚刚」处理，不出现负数
  assert.equal(formatRelativeTime(NOW + 5000, NOW), '刚刚');
});

test('normalizeHostLabel：URL → host，去 www/端口，小写', () => {
  assert.equal(normalizeHostLabel('https://www.bilibili.com/video/BV1MEW46JEYB/?p=2'), 'bilibili.com');
  assert.equal(normalizeHostLabel('https://m.bilibili.com:443/x'), 'm.bilibili.com');
  assert.equal(normalizeHostLabel('www.example.com:8080'), 'example.com');
  assert.equal(normalizeHostLabel('example.com'), 'example.com');
  assert.equal(normalizeHostLabel(''), '');
  assert.equal(normalizeHostLabel(null), '');
});

test('truncateLabel：超长标题按上限截断并加省略号', () => {
  const long = '这是一个非常非常长的网页标题'.repeat(10);
  const out = truncateLabel(long, 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('…'));
  assert.equal(truncateLabel('短标题', 60), '短标题');
});

test('computePageStatus：活动页 == 快照页 → 已同步（含时间）', () => {
  const view = computePageStatus({
    activeTabId: 5,
    activeTabTitle: '示例文章标题',
    activeTabUrl: 'https://example.com/post/1',
    snapshotTabId: 5,
    snapshotTitle: '示例文章标题',
    snapshotUrl: 'https://example.com/post/1',
    syncedAt: NOW - 12000,
    now: NOW,
  });
  assert.equal(view.tone, 'ok');
  assert.equal(view.statusText, '已同步');
  assert.equal(view.timeText, '12 秒前');
  assert.equal(view.warning, '');
  assert.equal(view.action, 'none');
  assert.equal(view.title, '示例文章标题');
  assert.equal(view.host, 'example.com');
  assert.equal(view.siteLabel, '', '未知站点没有可读名，回落 host');
});

test('computePageStatus：有站点映射时用可读站点名（B 站/YouTube）', () => {
  const view = computePageStatus({
    activeTabId: 5,
    activeTabTitle: '【测试】视频',
    activeTabUrl: 'https://www.bilibili.com/video/BV1MEW46JEYB/',
    snapshotTabId: 5,
    snapshotTitle: '【测试】视频',
    snapshotUrl: 'https://www.bilibili.com/video/BV1MEW46JEYB/',
    syncedAt: NOW - 1000,
    now: NOW,
  });
  assert.equal(view.host, 'bilibili.com');
  assert.equal(view.siteLabel, '哔哩哔哩');

  const yt = computePageStatus({
    activeTabId: 6,
    activeTabTitle: 'Some video',
    activeTabUrl: 'https://www.youtube.com/watch?v=abc',
    snapshotTabId: 6,
    snapshotTitle: 'Some video',
    snapshotUrl: 'https://www.youtube.com/watch?v=abc',
    syncedAt: NOW - 1000,
    now: NOW,
  });
  assert.equal(yt.siteLabel, 'YouTube');
});

test('computePageStatus：活动页 != 快照页 → 黄色警告且文案含旧标题', () => {
  const view = computePageStatus({
    activeTabId: 6,
    activeTabTitle: '新打开的页面',
    activeTabUrl: 'https://example.com/new',
    snapshotTabId: 5,
    snapshotTitle: '上一篇文章',
    snapshotUrl: 'https://example.com/post/1',
    syncedAt: NOW - 5000,
    now: NOW,
  });
  assert.equal(view.tone, 'warn');
  assert.equal(view.statusText, '未同步');
  assert.equal(view.action, 'sync');
  assert.equal(view.actionLabel, '同步当前页');
  assert.ok(view.warning.includes('当前页未同步'), view.warning);
  assert.ok(view.warning.includes('上一篇文章'), view.warning);
  assert.ok(view.tooltip.includes('上一篇文章'), view.tooltip);
  assert.equal(view.title, '新打开的页面');
});

test('computePageStatus：同标签页但 URL 已变（SPA 跳转未同步）→ 黄色警告', () => {
  const view = computePageStatus({
    activeTabId: 5,
    activeTabTitle: '视频 B',
    activeTabUrl: 'https://www.bilibili.com/video/BV2',
    snapshotTabId: 5,
    snapshotTitle: '视频 A',
    snapshotUrl: 'https://www.bilibili.com/video/BV1',
    syncedAt: NOW - 60000,
    now: NOW,
  });
  assert.equal(view.tone, 'warn');
  assert.equal(view.action, 'sync');
  assert.ok(view.warning.includes('视频 A'), view.warning);
  assert.ok(view.warning.includes('尚未同步'), view.warning);
  assert.equal(view.statusText, '待同步');
});

test('computePageStatus：没有任何快照 → 未同步文案 + 一键同步', () => {
  const view = computePageStatus({
    activeTabId: 5,
    activeTabTitle: '某篇文章',
    activeTabUrl: 'https://example.com/post/1',
    snapshotTabId: null,
    snapshotTitle: '',
    snapshotUrl: '',
    syncedAt: 0,
    now: NOW,
  });
  assert.equal(view.tone, 'idle');
  assert.equal(view.action, 'sync');
  assert.equal(view.statusText, '尚未读取');
  assert.ok(view.warning.includes('尚未读取'), view.warning);
  assert.ok(view.warning.includes('点 ⟳'), view.warning);
  assert.equal(view.timeText, '');
});

test('computePageStatus：受限页面（chrome://）→ 无法读取、不提示同步', () => {
  const view = computePageStatus({
    activeTabId: 9,
    activeTabTitle: '设置',
    activeTabUrl: 'chrome://settings',
    restricted: true,
    snapshotTabId: 5,
    snapshotTitle: '旧页面',
    snapshotUrl: 'https://example.com',
    syncedAt: NOW - 1000,
    now: NOW,
  });
  assert.equal(view.tone, 'idle');
  assert.equal(view.title, '受限页面');
  assert.equal(view.statusText, '无法读取');
  assert.equal(view.action, 'none');
});

test('computePageStatus：超长活动标题和旧标题都会截断', () => {
  const longTitle = '超长网页标题'.repeat(30);
  const view = computePageStatus({
    activeTabId: 6,
    activeTabTitle: longTitle,
    activeTabUrl: 'https://example.com/a',
    snapshotTabId: 5,
    snapshotTitle: longTitle,
    snapshotUrl: 'https://example.com/b',
    syncedAt: NOW - 1000,
    now: NOW,
    titleMax: 24,
  });
  assert.equal(view.title.length, 24);
  assert.ok(view.title.endsWith('…'));
  // 警告里的旧标题也应被截断（不会撑爆状态条）
  assert.ok(view.warning.length < 80, view.warning);
});

test('computePageStatus：没有标题时退回 host 展示', () => {
  const view = computePageStatus({
    activeTabId: 5,
    activeTabTitle: '',
    activeTabUrl: 'https://www.zhihu.com/question/1',
    snapshotTabId: 5,
    snapshotTitle: '知乎问题',
    snapshotUrl: 'https://www.zhihu.com/question/1',
    syncedAt: NOW - 1000,
    now: NOW,
  });
  assert.equal(view.tone, 'ok');
  assert.equal(view.title, 'zhihu.com');
  assert.equal(view.host, 'zhihu.com');
});

test('computePageStatus：快照属于本 tab 但缺 snapshotTabId 时按 URL 判断', () => {
  const same = computePageStatus({
    activeTabId: 5,
    activeTabTitle: '文章',
    activeTabUrl: 'https://example.com/post/1',
    snapshotTabId: null,
    snapshotTitle: '文章',
    snapshotUrl: 'https://example.com/post/1',
    syncedAt: NOW - 2000,
    now: NOW,
  });
  // 无法确定 tab 归属但有快照 → 视为不匹配并提示同步（宁可提示，不让 agent 读旧页）
  assert.equal(same.tone, 'warn');
  assert.equal(same.action, 'sync');
});
