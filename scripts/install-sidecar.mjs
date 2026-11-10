#!/usr/bin/env node
/**
 * scripts/install-sidecar.mjs — install packages/dsh-browser-sidecar into a DSH
 * profile, with timestamped backups of the files the install mutates.
 *
 * What it does (in order):
 *   1. resolve the package + profile + dsh CLI, and validate the bundle contract
 *      (`package.json` must declare `dsh.bundle.patch`),
 *   2. back up `<profile>/package.json` and `<profile>/cordis.patch.yml` into
 *      `<profile>/.sidecar-backup-<stamp>/` (dry-run only prints these paths),
 *   3. run `dsh plugin --profile <profile> add <abs package dir>` (this is a thin
 *      pnpm forwarder; it appends the bundle to `dsh.profile.bundles`),
 *   4. verify the dependency, the bundle list and the `node_modules` link,
 *   5. print the health check + restart steps + exact rollback commands.
 *
 * Why a script instead of a one-liner: `dsh plugin ... add` rewrites the profile
 * manifest. On the desktop profile the Electron app owns that file, so a restore
 * path must exist before anything is written. The script never writes to the
 * profile itself — everything is delegated to the dsh CLI, exactly like the
 * plugin manager does.
 *
 * Usage:
 *   node scripts/install-sidecar.mjs                       # desktop profile, real install
 *   node scripts/install-sidecar.mjs --dry-run             # print plan, change nothing
 *   node scripts/install-sidecar.mjs --profile sidebar-test --init-template web
 *   node scripts/install-sidecar.mjs --dsh "C:\\path\\to\\dsh.cmd" --package-dir "D:\\...\\dsh-browser-sidecar"
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_PACKAGE_DIR = join(REPO_ROOT, 'packages', 'dsh-browser-sidecar');
const DEFAULT_DSH_CLI = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
const PACKAGE_NAME = 'dsh-browser-sidecar';
const SIDECAR_PORT = 41789;

function usage(exitCode = 0) {
  const text = [
    '用法: node scripts/install-sidecar.mjs [选项]',
    '',
    '选项:',
    '  --profile <name>        目标 profile（默认 desktop）',
    '  --package-dir <path>    插件包目录（默认 packages/dsh-browser-sidecar）',
    '  --dsh <path>            dsh CLI 路径（默认本机安装路径，可用 DSH_CLI 环境变量）',
    '  --dry-run               只打印计划与命令，不备份、不安装',
    '  --init-template <name>  profile 不存在时用该模板初始化（web|headless|acp|sdk）；',
    '                          desktop profile 永远不由本脚本创建',
    '  --skip-install          只备份 + 打印命令（等价于半自动安装）',
    '  -h, --help              显示本帮助',
    '',
    '说明: `dsh plugin --profile <p> add <dir>` 是 pnpm 的薄封装：它把本地目录装成',
    '      link: 依赖，并把声明了 dsh.bundle 的包自动追加到 dsh.profile.bundles。',
  ].join('\n');
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    profile: 'desktop',
    packageDir: DEFAULT_PACKAGE_DIR,
    dsh: process.env.DSH_CLI && process.env.DSH_CLI.trim() !== '' ? process.env.DSH_CLI.trim() : DEFAULT_DSH_CLI,
    dryRun: false,
    initTemplate: undefined,
    skipInstall: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(arg + ' 需要一个值');
      index += 1;
      return value;
    };
    switch (arg) {
      case '--profile': options.profile = next(); break;
      case '--package-dir': options.packageDir = next(); break;
      case '--dsh': options.dsh = next(); break;
      case '--init-template': options.initTemplate = next(); break;
      case '--dry-run': options.dryRun = true; break;
      case '--skip-install': options.skipInstall = true; break;
      case '-h':
      case '--help': usage(0); break;
      default: throw new Error('未知参数: ' + arg);
    }
  }
  return options;
}

function log(step, text) {
  console.log('==> ' + step + ': ' + text);
}

function ok(text) {
  console.log('    OK   ' + text);
}

function warn(text) {
  console.log('    WARN ' + text);
}

function fail(text, code = 1) {
  console.error('    FAIL ' + text);
  process.exit(code);
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
    pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
}

function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return join(homedir(), '.dsh');
}

/** Quote one argument for cmd.exe (paths in this repo contain spaces). */
function quoteWindows(value) {
  return '"' + String(value).replace(/"/g, '\\"') + '"';
}

/** Run one CLI invocation; Windows .cmd shims need a shell. */
function runCli(cli, args, options) {
  if (process.platform === 'win32') {
    const command = [quoteWindows(cli), ...args.map(quoteWindows)].join(' ');
    if (options.dryRun) return { status: 0, command };
    const result = spawnSync(command, { shell: true, stdio: 'inherit' });
    return { status: result.status ?? 1, command, error: result.error };
  }
  if (options.dryRun) return { status: 0, command: [cli, ...args].join(' ') };
  const result = spawnSync(cli, args, { stdio: 'inherit' });
  return { status: result.status ?? 1, command: [cli, ...args].join(' '), error: result.error };
}

async function readManifest(path) {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error('参数错误: ' + error.message);
    usage(2);
  }

  const dshHome = resolveDshHome();
  const profileDir = join(dshHome, 'profiles', options.profile);
  const packageDir = resolve(options.packageDir);
  const isDesktop = options.profile.toLowerCase() === 'desktop';

  log('环境', 'DSH_HOME=' + dshHome);
  log('环境', 'profile=' + options.profile + '  (' + profileDir + ')');
  log('环境', 'package=' + packageDir);
  log('环境', 'dsh=' + options.dsh);

  /* ---- 1. validate inputs ------------------------------------------------ */
  if (!existsSync(join(packageDir, 'package.json'))) fail('包目录里没有 package.json：' + packageDir);
  const pkg = await readManifest(join(packageDir, 'package.json'));
  if (pkg.name !== PACKAGE_NAME) fail('包名不是 ' + PACKAGE_NAME + '（实际 ' + String(pkg.name) + '）');
  const patchRel = pkg.dsh && pkg.dsh.bundle ? pkg.dsh.bundle.patch : undefined;
  if (typeof patchRel !== 'string' || patchRel === '') {
    fail('package.json 缺少 dsh.bundle.patch，装进去不会成为 profile 层');
  }
  if (!existsSync(join(packageDir, patchRel))) fail('dsh.bundle.patch 指向的文件不存在：' + join(packageDir, patchRel));
  ok('bundle 契约完整：' + pkg.name + '@' + String(pkg.version) + ' patch=' + patchRel);

  if (!existsSync(options.dsh) && !options.dryRun) {
    fail('找不到 dsh CLI：' + options.dsh + '（用 --dsh 指定 dsh.cmd 的绝对路径）', 2);
  }

  /* ---- 2. profile: never create desktop, optionally init others ---------- */
  const profileJson = join(profileDir, 'package.json');
  const profileExists = existsSync(profileJson);
  if (!profileExists) {
    if (isDesktop) {
      fail('desktop profile 不存在（' + profileDir + '）：它由桌面应用创建，请先启动一次 DSH 桌面应用' +
        '，或把 --profile 换成隔离 profile 并加 --init-template web', 3);
    }
    if (typeof options.initTemplate !== 'string') {
      fail('profile "' + options.profile + '" 不存在。先初始化：dsh --profile ' + options.profile +
        ' --from-default-profile web --dump-config，或本脚本加 --init-template web', 3);
    }
    if (options.dryRun) {
      warn('dry-run：将执行 dsh --profile ' + options.profile + ' --from-default-profile ' + options.initTemplate + ' --dump-config');
    } else {
      log('初始化 profile', options.initTemplate);
      const init = runCli(options.dsh, ['--profile', options.profile, '--from-default-profile', options.initTemplate, '--dump-config'], options);
      if (init.status !== 0) fail('profile 初始化失败（exit=' + init.status + '）', 3);
      ok('profile 已创建：' + profileDir);
    }
  } else {
    ok('profile 已存在');
  }

  /* ---- 3. backups -------------------------------------------------------- */
  const backupDir = join(profileDir, '.sidecar-backup-' + stamp());
  const backupFiles = ['package.json', 'cordis.patch.yml'];
  const existingBackupTargets = [];
  for (const name of backupFiles) {
    if (existsSync(join(profileDir, name))) existingBackupTargets.push(name);
  }
  if (options.dryRun) {
    console.log('    PLAN 备份目录（dry-run 不创建）：' + backupDir);
    for (const name of existingBackupTargets) console.log('    PLAN ' + name + ' -> ' + join(backupDir, name));
  } else {
    await mkdir(backupDir, { recursive: true });
    for (const name of existingBackupTargets) {
      await copyFile(join(profileDir, name), join(backupDir, name));
    }
    ok('已备份 ' + String(existingBackupTargets.length) + ' 个文件到 ' + backupDir);
  }

  /* ---- 4. install -------------------------------------------------------- */
  const addArgs = ['plugin', '--profile', options.profile, 'add', packageDir];
  log('安装', 'dsh ' + addArgs.join(' '));
  if (options.dryRun) {
    console.log('    PLAN 命令: ' + [options.dsh, ...addArgs].join(' '));
  } else if (options.skipInstall) {
    warn('--skip-install：已跳过执行，可手工运行上面的命令');
  } else {
    const result = runCli(options.dsh, addArgs, options);
    if (result.status !== 0) {
      if (result.error) console.error(String(result.error));
      fail('`dsh plugin add` 失败（exit=' + result.status + '）。若原因是版本兼容检查，' +
        '见 docs/install.md §6 的 allow-version 说明；若 pnpm 报缺少构建许可，见 §6 allowBuilds', 4);
    }
    ok('`dsh plugin add` 完成');
  }

  /* ---- 5. verify --------------------------------------------------------- */
  if (!options.dryRun && !options.skipInstall) {
    let manifest;
    try {
      manifest = await readManifest(profileJson);
    } catch (error) {
      fail('无法读取 profile 清单：' + error.message, 5);
    }
    const dependency = Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, PACKAGE_NAME);
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
    if (!dependency) fail('profile dependencies 里没有 ' + PACKAGE_NAME + '（pnpm add 未生效）', 5);
    ok('dependencies 已包含 ' + PACKAGE_NAME);
    if (!bundles.includes(PACKAGE_NAME)) {
      fail('dsh.profile.bundles 里没有 ' + PACKAGE_NAME + ' → 插件不会被加载。' +
        '把 "' + PACKAGE_NAME + '" 追加进 ' + profileJson + ' 的 dsh.profile.bundles 后重跑 `dsh plugin --profile ' +
        options.profile + ' install`', 5);
    }
    ok('dsh.profile.bundles 已包含 ' + PACKAGE_NAME + '（顺序 = 覆盖顺序）');

    const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);
    if (existsSync(linkPath)) {
      let target = '';
      try {
        target = await readlink(linkPath);
      } catch {
        target = '(普通目录)';
      }
      ok('node_modules 链接 -> ' + target);
    } else {
      warn('node_modules/' + PACKAGE_NAME + ' 不存在；执行 `dsh plugin --profile ' + options.profile + ' install` 收尾');
    }
  }

  /* ---- 6. next steps + rollback ----------------------------------------- */
  console.log('');
  console.log('下一步（必须重启 DSH 才生效）：');
  if (isDesktop) {
    console.log('  1) 完全退出桌面应用（托盘「退出」，不是关窗口），再重新启动；');
  } else {
    console.log('  1) 重启该 profile 的 DSH 进程；');
  }
  console.log('  2) 健康检查: curl.exe -s http://127.0.0.1:' + String(SIDECAR_PORT) + '/__bridge/health');
  console.log('  3) 浏览器打开 http://127.0.0.1:' + String(SIDECAR_PORT) + '/ 应看到 DSH Web UI（不是 401）。');
  console.log('  4) Chrome 加载 extension/ 后，侧边栏 iframe 指向同一地址。');
  console.log('');
  console.log('排错: 若 / 返回可诊断 HTML，看其中 upstream 端口与 lastAuthError；');
  console.log('      若健康检查 connection 报错，说明插件比 connection 服务先加载，等几秒或刷新。');
  console.log('');
  console.log('回滚（任一步失败都可用；Restore 后跑一次 install 同步 pnpm）：');
  if (existingBackupTargets.length === 0) {
    console.log('  （本次没有需要备份的既有文件：profile 是新建的）');
    console.log('  删除后重装: 从 ' + profileJson + ' 里移除 ' + PACKAGE_NAME + ' 依赖与 bundles 项，再执行');
    console.log('  dsh plugin --profile ' + options.profile + ' install');
  } else {
    for (const name of existingBackupTargets) {
      console.log('  Copy-Item -LiteralPath "' + join(backupDir, name) + '" -Destination "' + join(profileDir, name) + '" -Force');
    }
    console.log('  Remove-Item -LiteralPath "' + join(profileDir, 'node_modules', PACKAGE_NAME) + '" -Recurse -Force -ErrorAction SilentlyContinue');
    console.log('  ' + quoteWindows(options.dsh) + ' plugin --profile ' + options.profile + ' install');
    console.log('  （或应用内插件管理禁用/卸载该插件）');
  }
  console.log('');
  console.log('备份目录: ' + backupDir);

  if (!options.dryRun) {
    const restoreText = [
      '# 回滚 ' + PACKAGE_NAME + '（由 scripts/install-sidecar.mjs 生成）',
      '# 备份时间: ' + new Date().toISOString(),
      '# 1. 还原 profile 清单与用户层 patch:',
      ...existingBackupTargets.map((name) =>
        'Copy-Item -LiteralPath "' + join(backupDir, name) + '" -Destination "' + join(profileDir, name) + '" -Force'),
      '# 2. 清掉 link 并同步 pnpm:',
      'Remove-Item -LiteralPath "' + join(profileDir, 'node_modules', PACKAGE_NAME) + '" -Recurse -Force -ErrorAction SilentlyContinue',
      quoteWindows(options.dsh) + ' plugin --profile ' + options.profile + ' install',
      '',
    ].join('\n');
    await writeFile(join(backupDir, 'RESTORE.md'), restoreText, 'utf8');
  }

  console.log('完成。');
}

main().catch((error) => {
  console.error('安装脚本异常: ' + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
