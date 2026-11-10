/**
 * 单进程跑全部测试（受限 shell 的兜底入口）
 * ---------------------------------------------------------------------------
 * 为什么需要它：某些沙箱/CI 环境禁止 `node --test` 用管道 spawn 子进程
 * （报 `spawn EPERM`）。这个入口把全部 *.test.mjs 直接 import 进同一个进程，
 * 不 spawn、不开管道，任何环境都能跑。
 *
 * 用法：
 *   node extension/test/run-all.mjs
 *
 * 标准方式仍然是：
 *   node --test extension/test/*.test.mjs
 */

import './core-text.test.mjs';
import './core-urls.test.mjs';
import './core-youtube.test.mjs';
import './core-bilibili.test.mjs';
import './core-dom.test.mjs';
import './core-snapshot.test.mjs';
import './core-pagebar.test.mjs';
import './package-integrity.test.mjs';
import './bridge-contract.test.mjs';
