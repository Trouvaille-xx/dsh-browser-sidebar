/**
 * dsh-browser-sidecar — pure logic shared by the bridge API, the agent tool and
 * the tests.
 *
 * Everything here is side-effect free: no HTTP, no timers, no filesystem. The
 * snapshot sanitizer is the single trust boundary for data pushed by the Chrome
 * extension, and the formatters produce the bounded, model-facing text of the
 * `browser_page` tool.
 */

import { randomUUID } from 'node:crypto';

/** Plugin/package version reported by /__bridge/health and the manifest. */
export const VERSION = '1.0.0';

/** Default sidecar port (the iframe origin the Chrome side panel loads). */
export const DEFAULT_PORT = 41789;

/** Default DSH Web UI port the sidecar proxies to. */
export const DEFAULT_UPSTREAM_PORT = 4064;

/** Loopback host the sidecar binds to. The reverse proxy never listens elsewhere. */
export const SIDECAR_HOST = '127.0.0.1';

/** Hard limits. The bridge degrades (truncates) instead of failing on oversize data. */
export const LIMITS = Object.freeze({
  /** POST /__bridge/context body cap (8 MB). */
  maxBodyBytes: 8 * 1024 * 1024,
  /** tabId -> snapshot map cap; oldest tab is evicted first. */
  maxTabs: 50,
  /** Body text kept per snapshot. */
  maxContentChars: 60000,
  /** Transcript cue count kept per snapshot. */
  maxTranscriptEntries: 5000,
  /** Transcript cue text kept per snapshot (chars). */
  maxTranscriptChars: 80000,
  /** Selected-text kept per snapshot. */
  maxSelectionChars: 20000,
  /** Per metadata string (description/ogImage/author/...). */
  maxMetaChars: 4000,
  /** browser_page defaults. */
  pageMaxChars: 20000,
  transcriptMaxChars: 30000,
  videoPreviewCues: 40,
  /** browser_page clamp: `maxChars` may not exceed this. */
  toolHardMaxChars: 60000,
  toolMinMaxChars: 500,
});

/** Error with a stable machine code, used for bridge JSON error payloads. */
export class BridgeError extends Error {
  /**
   * @param {string} code - stable error code, e.g. 'invalid-context'
   * @param {string} message - human readable message
   * @param {number} [status] - HTTP status to answer with
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}

/** Coerce a value to a string safely (never throws on symbols/proxies). */
function asString(value) {
  return typeof value === 'string' ? value : '';
}

/** Clamp a string to maxChars, reporting whether truncation happened. */
export function clampText(value, maxChars) {
  const text = asString(value);
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars <= 0) {
    return { text, truncated: false, originalLength: text.length };
  }
  if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
  return { text: text.slice(0, maxChars), truncated: true, originalLength: text.length };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function optionalFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeMeta(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const meta = {};
  for (const key of ['description', 'ogImage', 'author', 'publishedAt', 'lang']) {
    const text = asString(source[key]);
    meta[key] = text.length > LIMITS.maxMetaChars ? text.slice(0, LIMITS.maxMetaChars) : text;
  }
  return meta;
}

function sanitizeContent(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const { text, truncated, originalLength } = clampText(source.text, LIMITS.maxContentChars);
  return {
    text,
    // `charCount` is the length of the stored text (what the side panel's
    // validateSnapshot invariant requires); `originalCharCount` keeps the
    // pre-truncation size for diagnostics/tool output.
    charCount: text.length,
    originalCharCount: Number.isSafeInteger(source.charCount) && source.charCount >= originalLength
      ? source.charCount
      : originalLength,
    truncated: truncated || source.truncated === true,
  };
}

/** Allowed video kinds / transcript sources (spec §2 enums). */
const VIDEO_KINDS = ['youtube', 'html5', 'bilibili', 'none'];
const TRANSCRIPT_SOURCES = [
  'youtube-captions',
  'track',
  'page-text',
  'bilibili-page',  // B 站：登录态页面态 __INITIAL_STATE__.videoData.subtitle.list 直取
  'bilibili-api',   // B 站：player/v2 接口（带登录 cookie）
  'none',
];

function sanitizeVideo(raw) {
  if (!isPlainObject(raw)) return undefined;
  const rawKind = asString(raw.kind);
  const rawSource = asString(raw.transcriptSource);
  const kind = VIDEO_KINDS.includes(rawKind) ? rawKind : 'none';
  const transcriptSource = TRANSCRIPT_SOURCES.includes(rawSource) ? rawSource : (kind === 'none' ? 'none' : 'track');
  const cues = [];
  let transcriptChars = 0;
  let transcriptTruncated = false;
  const sourceCues = Array.isArray(raw.transcript) ? raw.transcript : [];
  for (const cue of sourceCues) {
    if (cues.length >= LIMITS.maxTranscriptEntries) {
      transcriptTruncated = true;
      break;
    }
    if (!isPlainObject(cue)) continue;
    const text = asString(cue.text);
    if (text === '') continue;
    const budget = LIMITS.maxTranscriptChars - transcriptChars;
    if (budget <= 0) {
      transcriptTruncated = true;
      break;
    }
    const kept = text.length <= budget ? text : text.slice(0, budget);
    if (kept.length < text.length) transcriptTruncated = true;
    transcriptChars += kept.length;
    cues.push({
      start: optionalFinite(cue.start) ?? 0,
      end: optionalFinite(cue.end) ?? optionalFinite(cue.start) ?? 0,
      text: kept,
    });
  }
  if (raw.transcriptTruncated === true || raw.truncated === true) transcriptTruncated = true;
  return {
    kind,
    title: clampText(raw.title, LIMITS.maxMetaChars).text,
    author: clampText(raw.author, LIMITS.maxMetaChars).text,
    durationSec: optionalFinite(raw.durationSec) ?? 0,
    currentTimeSec: optionalFinite(raw.currentTimeSec) ?? 0,
    transcriptSource,
    transcript: cues,
    transcriptTruncated,
  };
}

/**
 * Validate and normalize one snapshot pushed by the extension.
 *
 * Required: `url` (non-empty string), `title` (string), `capturedAt` (ISO/RFC3339
 * string), `tabId` (safe integer). Unknown fields are dropped, oversized data is
 * truncated and flagged instead of rejected.
 *
 * @param {unknown} raw - request body from POST /__bridge/context
 * @param {{ now?: () => number }} [options] - injectable clock for deterministic tests
 * @returns {object} normalized snapshot (a brand-new object; the input is never mutated)
 * @throws {BridgeError} when a required field is missing/invalid
 */
export function sanitizeSnapshot(raw, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  if (!isPlainObject(raw)) throw new BridgeError('invalid-context', '请求体必须是 JSON 对象');
  const url = asString(raw.url).trim();
  if (url === '') throw new BridgeError('invalid-context', '缺少必填字段 url（当前页面 URL）');
  if (typeof raw.title !== 'string') throw new BridgeError('invalid-context', '缺少必填字段 title（页面标题，可为空字符串）');
  const capturedAt = asString(raw.capturedAt).trim();
  if (capturedAt === '') throw new BridgeError('invalid-context', '缺少必填字段 capturedAt（抓取时间 ISO 字符串）');
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) throw new BridgeError('invalid-context', 'capturedAt 不是可解析的时间字符串：' + capturedAt);
  const tabId = optionalInteger(raw.tabId);
  if (tabId === undefined) throw new BridgeError('invalid-context', '缺少必填字段 tabId（整数标签页 id）');

  const selectionSource = asString(raw.selection);
  const selection = clampText(selectionSource, LIMITS.maxSelectionChars);
  const timestamp = now();
  const snapshot = {
    id: typeof raw.id === 'string' && raw.id !== '' && raw.id.length <= 160 ? raw.id : (options.id ?? randomUUID()),
    tabId,
    // -1 matches the extension's "unknown window" convention and keeps the key
    // present for consumers that validate the spec §2 snapshot shape.
    windowId: optionalInteger(raw.windowId) ?? -1,
    active: raw.active === true,
    url,
    title: raw.title.length > LIMITS.maxMetaChars ? raw.title.slice(0, LIMITS.maxMetaChars) : raw.title,
    siteName: clampText(raw.siteName, LIMITS.maxMetaChars).text,
    capturedAt: new Date(capturedMs).toISOString(),
    receivedAt: new Date(timestamp).toISOString(),
    selection: selection.text,
    selectionTruncated: selection.truncated,
    meta: sanitizeMeta(raw.meta),
    content: sanitizeContent(raw.content),
    // Always present: a page without a video still carries the spec's shape.
    video: sanitizeVideo(raw.video) ?? {
      kind: 'none',
      title: '',
      author: '',
      durationSec: 0,
      currentTimeSec: 0,
      transcriptSource: 'none',
      transcript: [],
      transcriptTruncated: false,
    },
  };
  return snapshot;
}

/** Compact per-tab summary returned by GET /__bridge/context/list. */
export function summarizeSnapshot(snapshot) {
  const video = snapshot.video;
  const kind = video !== undefined ? video.kind : 'none';
  const transcriptCount = video !== undefined ? video.transcript.length : 0;
  return {
    id: snapshot.id,
    tabId: snapshot.tabId,
    ...(snapshot.windowId !== undefined ? { windowId: snapshot.windowId } : {}),
    active: snapshot.active,
    url: snapshot.url,
    title: snapshot.title,
    siteName: snapshot.siteName,
    capturedAt: snapshot.capturedAt,
    /** `updatedAt` mirrors capturedAt for consumers that read the spec §2 summary shape. */
    updatedAt: snapshot.capturedAt,
    receivedAt: snapshot.receivedAt,
    contentChars: snapshot.content.charCount,
    contentTruncated: snapshot.content.truncated,
    selectionChars: snapshot.selection.length,
    videoKind: kind,
    transcriptCount,
    /** Nested form (spec/extension summary shape): [{video:{kind}}]. */
    video: { kind, transcriptCount },
  };
}

/** Human clock for a transcript offset: 12 -> "0:12", 3725 -> "1:02:05". */
export function formatClock(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  return minutes + ':' + String(secs).padStart(2, '0');
}

/** "刚刚" / "3 分钟前" / "2026-11-10T12:00:00.000Z" for old timestamps. */
export function formatAge(capturedAt, nowMs = Date.now()) {
  const capturedMs = Date.parse(asString(capturedAt));
  if (!Number.isFinite(capturedMs)) return '未知时间';
  const delta = nowMs - capturedMs;
  if (delta < 0) return '刚刚';
  if (delta < 60000) return '刚刚';
  if (delta < 3600000) return Math.floor(delta / 60000) + ' 分钟前';
  if (delta < 86400000) return Math.floor(delta / 3600000) + ' 小时前';
  if (delta < 7 * 86400000) return Math.floor(delta / 86400000) + ' 天前';
  return capturedAt;
}

/** Bounded source header shared by every browser_page mode. */
export function formatSourceHeader(snapshot, nowMs = Date.now()) {
  const lines = [
    '来源页面：' + (snapshot.title || '(无标题)'),
    'URL：' + snapshot.url,
  ];
  if (snapshot.siteName) lines.push('站点：' + snapshot.siteName);
  lines.push('抓取时间：' + snapshot.capturedAt + '（' + formatAge(snapshot.capturedAt, nowMs) + '）');
  lines.push('标签页：tabId=' + snapshot.tabId +
    (Number.isSafeInteger(snapshot.windowId) && snapshot.windowId >= 0 ? ' windowId=' + snapshot.windowId : ''));
  return lines.join('\n');
}

/** Prompt the model sees when nothing has been synced yet. */
export const NO_CONTEXT_TEXT = [
  '没有可用的浏览器页面上下文：用户还没有把当前网页同步过来。',
  '请让用户在 Chrome 侧边栏点击「读取当前页」（或打开自动同步）后重试；同步成功后可以再调用 browser_page。',
  '可同步的内容包括：页面标题/URL/正文、选中文本、视频信息与字幕（YouTube 字幕轨道、哔哩哔哩 CC/AI 字幕，或页面文字兜底）。',
].join('\n');

function applyMaxChars(text, maxChars) {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars <= 0) return text;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n…（已截断：共 ' + text.length + ' 字，只返回前 ' + maxChars + ' 字）';
}

/** Clamp a user/agent supplied `maxChars` into the supported range. */
export function resolveMaxChars(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), LIMITS.toolMinMaxChars), LIMITS.toolHardMaxChars);
}

function videoSummaryLine(video) {
  if (video === undefined || video.kind === 'none') return '视频：无（页面没有可识别的视频）';
  const duration = video.durationSec > 0 ? '，时长 ' + formatClock(video.durationSec) : '';
  const position = video.currentTimeSec > 0 ? '，当前 ' + formatClock(video.currentTimeSec) : '';
  return '视频：' + video.kind + (video.title ? '《' + video.title + '》' : '') + duration + position +
    '，字幕 ' + video.transcript.length + ' 条（来源 ' + video.transcriptSource + '）';
}

function previewCues(video, limit) {
  const lines = [];
  for (const cue of video.transcript.slice(0, limit)) {
    lines.push('[' + formatClock(cue.start) + '] ' + cue.text);
  }
  return lines;
}

/**
 * Render one `browser_page` mode into bounded, model-facing text.
 *
 * @param {'summary'|'page'|'selection'|'video'|'transcript'} mode
 * @param {object|undefined} snapshot - normalized snapshot, or undefined when nothing is synced
 * @param {{ maxChars?: number, now?: number }} [options]
 * @returns {string}
 */
export function formatSnapshotForTool(mode, snapshot, options = {}) {
  if (snapshot === undefined || snapshot === null) return NO_CONTEXT_TEXT;
  const nowMs = typeof options.now === 'number' ? options.now : Date.now();
  const header = formatSourceHeader(snapshot, nowMs);
  const maxChars = resolveMaxChars(options.maxChars, defaultMaxChars(mode));

  switch (mode) {
    case 'summary': {
      const lines = [
        '浏览器页面上下文（用户从 Chrome 侧边栏主动同步）',
        header,
        '正文：' + (snapshot.content.truncated && Number.isSafeInteger(snapshot.content.originalCharCount)
          ? snapshot.content.originalCharCount
          : snapshot.content.charCount) + ' 字' +
          (snapshot.content.truncated ? '（服务端只保留了前 ' + snapshot.content.charCount + ' 字）' : ''),
        '选中文本：' + (snapshot.selection.length > 0 ? '有（' + snapshot.selection.length + ' 字）' : '无'),
        videoSummaryLine(snapshot.video),
      ];
      if (snapshot.meta.description) lines.push('描述：' + snapshot.meta.description);
      if (snapshot.meta.author) lines.push('作者：' + snapshot.meta.author);
      if (snapshot.meta.publishedAt) lines.push('发布时间：' + snapshot.meta.publishedAt);
      lines.push('可用 mode：page(正文) / selection(选中文本) / video(视频信息) / transcript(完整字幕)');
      return applyMaxChars(lines.join('\n'), maxChars);
    }
    case 'page': {
      const body = snapshot.content.text !== '' ? snapshot.content.text : '(正文为空)';
      return applyMaxChars(header + '\n\n' + body, maxChars);
    }
    case 'selection': {
      if (snapshot.selection.length === 0) {
        return header + '\n\n当前页面没有选中文本。可以让用户选中一段文字后重新点击「读取当前页」。';
      }
      return applyMaxChars(header + '\n\n【选中文本】\n' + snapshot.selection, maxChars);
    }
    case 'video': {
      const video = snapshot.video;
      if (video === undefined || video.kind === 'none') {
        return header + '\n\n当前页面没有可用的视频信息。';
      }
      const lines = [header, '', videoSummaryLine(video)];
      if (video.transcript.length === 0) {
        lines.push('字幕：无可用字幕。若这是 YouTube/哔哩哔哩，请确认播放器里字幕已开启（B 站需要登录才能读到 CC/AI 字幕），或改用 mode=page 读取页面文字。');
      } else {
        lines.push('字幕预览（前 ' + Math.min(LIMITS.videoPreviewCues, video.transcript.length) + ' 条，完整字幕用 mode=transcript）：');
        lines.push(...previewCues(video, LIMITS.videoPreviewCues));
        if (video.transcript.length > LIMITS.videoPreviewCues) lines.push('…（还有 ' + (video.transcript.length - LIMITS.videoPreviewCues) + ' 条）');
      }
      return applyMaxChars(lines.join('\n'), maxChars);
    }
    case 'transcript': {
      const video = snapshot.video;
      if (video === undefined || video.kind === 'none' || video.transcript.length === 0) {
        return header + '\n\n当前页面没有可用的视频字幕。' +
          (video !== undefined && video.kind !== 'none'
            ? '（视频 ' + video.kind + '，字幕来源 ' + video.transcriptSource + '）'
            : '');
      }
      const lines = [header, '', videoSummaryLine(video), ''];
      lines.push(...previewCues(video, video.transcript.length));
      if (video.transcriptTruncated) lines.push('…（字幕在同步时已被截断）');
      return applyMaxChars(lines.join('\n'), maxChars);
    }
    default:
      throw new BridgeError('invalid-mode', '未知的 mode：' + String(mode));
  }
}

function defaultMaxChars(mode) {
  if (mode === 'transcript') return LIMITS.transcriptMaxChars;
  return LIMITS.pageMaxChars;
}
