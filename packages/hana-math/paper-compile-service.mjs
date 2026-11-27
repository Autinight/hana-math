// Math Settings LaTeX compiler configuration and hardened two-pass compilation service.
// Uses Host sdk.process.resolveExecutable (never scans external disks from AppHost)
// and runs pdflatex/pdftex in a private per-job directory under sdk.dataDir with
// -no-shell-escape, openin_any=p, openout_any=p, -recorder and strict output verification.
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildPaperCompilePlan, checkPaperCompileOutput } from './paper-compile-plan.mjs';

const execFileAsync = promisify(execFileCallback);

export const TEX_SETTINGS_KEY = 'settings.tex';
const ALLOWED_BASENAMES = new Set(['pdflatex', 'pdftex', 'pdflatex.exe', 'pdftex.exe']);
const DEFAULT_MAC_CANDIDATES = Object.freeze([
  '/Library/TeX/texbin/pdflatex',
  '/opt/homebrew/bin/pdflatex',
  '/usr/local/bin/pdflatex',
  'pdflatex',
  'pdftex',
]);
const DEFAULT_WIN_CANDIDATES = Object.freeze(['pdflatex.exe', 'pdftex.exe', 'pdflatex', 'pdftex']);
const DEFAULT_LINUX_CANDIDATES = Object.freeze(['/usr/bin/pdflatex', '/usr/local/bin/pdflatex', 'pdflatex', 'pdftex']);
const TEST_DOCUMENT = [
  '\\documentclass{article}',
  '\\usepackage{amsmath}',
  '\\begin{document}',
  'Hana Math TeX check: $1 + 1 = 2$.',
  '\\end{document}',
  '',
].join('\n');

const fail = (code, message, status = 400) => Object.assign(new Error(message || code), { code, status });
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function baseName(filePath) {
  return path.basename(filePath).toLowerCase();
}

export function normalizeTexCompilerPath(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw fail('PAPER_COMPILE_PATH_INVALID', 'TeX 编译器路径必须是文本或留空。', 400);
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw fail('PAPER_COMPILE_PATH_INVALID', 'TeX 编译器路径包含非法字符或超出长度限制。', 400);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 4096) {
    throw fail('PAPER_COMPILE_PATH_INVALID', 'TeX 编译器路径包含非法字符或超出长度限制。', 400);
  }
  if (!path.isAbsolute(trimmed)) {
    throw fail('PAPER_COMPILE_PATH_INVALID', '请填写绝对路径（例如 /Library/TeX/texbin/pdflatex），或留空自动查找。', 400);
  }
  const normalized = path.normalize(trimmed);
  if (normalized === path.parse(normalized).root || normalized.endsWith(path.sep)) {
    throw fail('PAPER_COMPILE_PATH_INVALID', '请指向 pdflatex 或 pdftex 可执行文件，而不是目录。', 400);
  }
  if (!ALLOWED_BASENAMES.has(baseName(normalized))) {
    throw fail('PAPER_COMPILE_PATH_INVALID', '仅允许配置 pdflatex 或 pdftex 可执行文件。', 400);
  }
  return normalized;
}

export function deriveTexReadRoots(resolvedPath, configuredPath = null) {
  const roots = new Set();
  const addRoot = candidate => {
    if (!candidate || typeof candidate !== 'string') return;
    const norm = path.normalize(candidate);
    if (!path.isAbsolute(norm) || norm === path.parse(norm).root) return;
    // Never grant overly broad top-level OS roots like /usr, /usr/local, /opt, /Library.
    const parts = norm.split(path.sep).filter(Boolean);
    if (parts.length < 2) return;
    if (norm === '/usr/local' || norm === '/opt/homebrew' || norm === '/Library/Application Support') return;
    roots.add(norm);
  };
  const binDir = path.dirname(resolvedPath);
  addRoot(binDir);
  const parent1 = path.dirname(binDir);
  const parent2 = path.dirname(parent1);
  // Typical TeX Live layout: /usr/local/texlive/2026/bin/universal-darwin/pdftex -> /usr/local/texlive/2026
  if (path.basename(parent1).toLowerCase() === 'bin') {
    addRoot(parent1);
    addRoot(parent2);
    const parent3 = path.dirname(parent2);
    if (path.basename(parent3).toLowerCase().includes('texlive')) {
      addRoot(path.join(parent3, 'texmf-local'));
    }
  } else if (path.basename(binDir).toLowerCase() === 'bin' || path.basename(binDir).toLowerCase() === 'texbin') {
    addRoot(parent1);
  }
  if (configuredPath) {
    const cfgDir = path.dirname(configuredPath);
    addRoot(cfgDir);
    if (path.basename(cfgDir).toLowerCase() === 'texbin') addRoot(path.dirname(cfgDir));
  }
  return [...roots];
}

export function extractPdfTexVersion(logText) {
  if (typeof logText !== 'string') return null;
  const first = logText.split(/\r?\n/, 1)[0]?.trim() || '';
  return first.startsWith('This is pdfTeX') ? first.slice(0, 200) : null;
}

export function extractCompileLogExcerpt(logText, maxChars = 6000) {
  if (typeof logText !== 'string' || !logText) return '';
  const lines = logText.split(/\r?\n/);
  const errIdx = lines.findIndex(line => /^\s*!|^.+:\d+:|(?:LaTeX|Package\s+[^\r\n]+) Error:|Fatal error|Emergency stop/i.test(line));
  const slice = errIdx >= 0 ? lines.slice(Math.max(0, errIdx - 5), errIdx + 60) : lines.slice(-60);
  const text = slice.join('\n').trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function defaultCandidates(platform = process.platform) {
  if (platform === 'darwin') return [...DEFAULT_MAC_CANDIDATES];
  if (platform === 'win32') return [...DEFAULT_WIN_CANDIDATES];
  return [...DEFAULT_LINUX_CANDIDATES];
}

function sanitizedEnv() {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TEXMFHOME', 'TEXMFVAR', 'TEXMFCONFIG'];
  const out = {};
  for (const key of keep) if (typeof process.env[key] === 'string') out[key] = process.env[key];
  return out;
}

export function createPaperCompileService(sdk, {
  resolveExecutable,
  execCompiler,
  platform = process.platform,
  timeoutMs = 60000,
} = {}) {
  const storage = sdk?.storage?.global;
  const resolver = resolveExecutable ?? (async candidates => {
    if (typeof sdk?.process?.resolveExecutable !== 'function') {
      throw fail('PAPER_COMPILE_HOST_UNSUPPORTED', '当前 Hana 宿主未开放可执行文件探测接口（需要 app/process.spawn）。', 503);
    }
    return sdk.process.resolveExecutable({ candidates });
  });
  const runner = execCompiler ?? (async (command, args, options) => {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: sanitizedEnv(),
      });
      return { exitCode: 0, signal: null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
    } catch (error) {
      if (error?.code === 'ERR_ACCESS_DENIED' || error?.code === 'EACCES' || error?.code === 'EPERM') {
        throw fail('PAPER_COMPILE_PERMISSION_DENIED', 'Hana 未授权运行外部 TeX 编译器，请在扩展设置中确认 app/process.spawn 权限并重启 Math 应用。', 403);
      }
      if (error?.killed || error?.signal) {
        return { exitCode: null, signal: error.signal || 'SIGTERM', stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), timedOut: Boolean(error.killed) };
      }
      if (Number.isInteger(error?.code)) {
        return { exitCode: error.code, signal: null, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
      }
      throw fail('PAPER_COMPILE_EXEC_FAILED', `启动 TeX 编译器失败：${error?.message || String(error)}`, 502);
    }
  });

  async function readSettings() {
    if (typeof storage?.get !== 'function') return { compilerPath: null, updatedAt: null };
    try {
      const raw = await storage.get(TEX_SETTINGS_KEY);
      if (!isPlainObject(raw)) return { compilerPath: null, updatedAt: null };
      const compilerPath = typeof raw.compilerPath === 'string' ? normalizeTexCompilerPath(raw.compilerPath) : null;
      const updatedAt = Number.isSafeInteger(raw.updatedAt) ? raw.updatedAt : null;
      return { compilerPath, updatedAt };
    } catch {
      return { compilerPath: null, updatedAt: null };
    }
  }

  async function resolveCompiler(overridePath) {
    const saved = await readSettings();
    const configuredPath = overridePath !== undefined ? normalizeTexCompilerPath(overridePath) : saved.compilerPath;
    const candidates = configuredPath ? [configuredPath] : defaultCandidates(platform);
    let info;
    try {
      info = await resolver(candidates);
    } catch (error) {
      if (error?.code?.startsWith('PAPER_COMPILE_')) throw error;
      const denied = /DENIED|FORBIDDEN|PERMISSION|CAPABILITY/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
      throw fail(
        denied ? 'PAPER_COMPILE_PERMISSION_DENIED' : 'PAPER_COMPILE_RESOLVE_FAILED',
        denied
          ? 'Hana 未授权探测外部 TeX 编译器（需批准 app/process.spawn 权限并重启 Math 应用）。'
          : `探测 TeX 编译器失败：${error?.message || String(error)}`,
        denied ? 403 : 502,
      );
    }
    if (!info || typeof info.path !== 'string' || !info.path) {
      throw fail(
        'PAPER_COMPILE_NOT_FOUND',
        configuredPath
          ? `未找到指定的 TeX 编译器：${configuredPath}`
          : '未自动找到 pdflatex，请在 Math 设置中填写本机 pdflatex 的完整路径（例如 /Library/TeX/texbin/pdflatex）。',
        404,
      );
    }
    const resolvedPath = path.normalize(info.path);
    if (!path.isAbsolute(resolvedPath) || !ALLOWED_BASENAMES.has(baseName(resolvedPath))) {
      throw fail('PAPER_COMPILE_PATH_INVALID', '解析到的可执行文件不是受支持的 pdflatex / pdftex。', 400);
    }
    const readRoots = deriveTexReadRoots(resolvedPath, configuredPath);
    return {
      configuredPath,
      mode: configuredPath ? 'custom' : 'auto',
      resolvedPath,
      readRoots,
      mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : null,
      size: Number.isSafeInteger(info.size) ? info.size : null,
    };
  }

  async function getSettingsPanel() {
    const saved = await readSettings();
    const base = {
      configuredPath: saved.compilerPath,
      mode: saved.compilerPath ? 'custom' : 'auto',
      updatedAt: saved.updatedAt,
      defaultHint: platform === 'darwin' ? '/Library/TeX/texbin/pdflatex' : platform === 'win32' ? 'C:\\texlive\\2025\\bin\\windows\\pdflatex.exe' : '/usr/bin/pdflatex',
    };
    try {
      const resolved = await resolveCompiler(saved.compilerPath);
      return { ...base, available: true, resolvedPath: resolved.resolvedPath, error: null };
    } catch (error) {
      return {
        ...base,
        available: false,
        resolvedPath: null,
        error: { code: error?.code || 'PAPER_COMPILE_UNAVAILABLE', message: error?.message || 'TeX 编译器暂不可用' },
      };
    }
  }

  async function saveSettings(input) {
    if (!isPlainObject(input) || !Object.hasOwn(input, 'compilerPath') || Object.keys(input).some(k => k !== 'compilerPath')) {
      throw fail('PAPER_COMPILE_PATH_INVALID', '仅支持提交 compilerPath 字段。', 400);
    }
    const compilerPath = normalizeTexCompilerPath(input.compilerPath);
    if (typeof storage?.set !== 'function') {
      throw fail('PAPER_COMPILE_STORAGE_UNAVAILABLE', '当前宿主未提供设置存储接口。', 503);
    }
    await storage.set(TEX_SETTINGS_KEY, { compilerPath, updatedAt: Date.now() });
    return getSettingsPanel();
  }

  async function compileTex({ sourceBytes, sourceSha256, compilerPath } = {}) {
    if (!(sourceBytes instanceof Uint8Array) || sourceBytes.length === 0) {
      throw fail('PAPER_COMPILE_SOURCE_INVALID', '缺少待编译的 TeX 正文字节。', 400);
    }
    if (typeof sdk?.dataDir !== 'string' || !path.isAbsolute(sdk.dataDir)) {
      throw fail('PAPER_COMPILE_WORKDIR_INVALID', '缺少有效的 App 数据目录。', 500);
    }
    const resolved = await resolveCompiler(compilerPath);
    const jobsRoot = path.join(await fs.realpath(sdk.dataDir), 'research', 'tex-jobs');
    await fs.mkdir(jobsRoot, { recursive: true, mode: 0o700 });
    const jobDir = await fs.mkdtemp(path.join(jobsRoot, 'compile-'));
    try {
      const canonicalJobDir = await fs.realpath(jobDir);
      const plan = buildPaperCompilePlan({
        sourceBytes,
        sourceSha256,
        cwd: canonicalJobDir,
        command: resolved.resolvedPath,
        readRoots: resolved.readRoots,
        taskId: `tex-${randomUUID()}`,
      });
      await fs.writeFile(path.join(canonicalJobDir, 'main.tex'), sourceBytes, { mode: 0o600 });

      const readOptional = async name => {
        try { return await fs.readFile(path.join(canonicalJobDir, name)); }
        catch { return null; }
      };
      const readOutputs = async () => {
        const [logBytes, flsBytes, pdfBytes] = await Promise.all([
          readOptional('main.log'), readOptional('main.fls'), readOptional('main.pdf'),
        ]);
        const logText = logBytes ? new TextDecoder('utf-8', { fatal: false }).decode(logBytes) : '';
        return { logBytes, flsBytes, pdfBytes, logText };
      };

      let lastPass = 0;
      let lastExec = null;
      for (const pass of [1, 2]) {
        lastPass = pass;
        lastExec = await runner(plan.command, plan.args, { cwd: canonicalJobDir, timeoutMs });
        if (lastExec.exitCode !== 0) break;
      }

      let { logBytes, flsBytes, pdfBytes, logText } = await readOutputs();
      let checked = null;
      let checkError = null;
      if (lastExec && lastExec.exitCode === 0) {
        try {
          checked = checkPaperCompileOutput({ logBytes, flsBytes, pdfBytes, cwd: canonicalJobDir, readRoots: resolved.readRoots, pass: 2 });
        } catch (err) {
          if (err?.code === 'PAPER_COMPILE_REFERENCES_UNSETTLED') {
            // Allow one final pass for documents (e.g. TOC + hyperref outlines) that genuinely need 3 passes to settle.
            lastPass = 3;
            lastExec = await runner(plan.command, plan.args, { cwd: canonicalJobDir, timeoutMs });
            ({ logBytes, flsBytes, pdfBytes, logText } = await readOutputs());
            if (lastExec && lastExec.exitCode === 0) {
              try {
                checked = checkPaperCompileOutput({ logBytes, flsBytes, pdfBytes, cwd: canonicalJobDir, readRoots: resolved.readRoots, pass: 2 });
              } catch (thirdErr) { checkError = thirdErr; }
            }
          } else { checkError = err; }
        }
      }
      const version = extractPdfTexVersion(logText);
      const fallbackLog = !logBytes && lastExec ? Buffer.from(`${lastExec.stdout || ''}\n${lastExec.stderr || ''}`.trim() + '\n', 'utf8') : null;
      const effectiveLogBytes = logBytes || fallbackLog || Buffer.from('No TeX log produced.\n', 'utf8');
      const effectiveLogText = logText || effectiveLogBytes.toString('utf8');

      if (!lastExec || lastExec.exitCode !== 0) {
        const errorCode = lastExec?.timedOut ? 'PAPER_COMPILE_TIMEOUT' : 'PAPER_COMPILE_TEX_ERROR';
        return {
          ok: false,
          errorCode,
          message: lastExec?.timedOut
            ? `TeX 编译超时（pass ${lastPass}）`
            : `TeX 编译失败（pass ${lastPass}，退出码 ${lastExec?.exitCode ?? 'unknown'}）`,
          pass: lastPass,
          executable: resolved.resolvedPath,
          configuredPath: resolved.configuredPath,
          mode: resolved.mode,
          version,
          cwd: canonicalJobDir,
          readRoots: resolved.readRoots,
          logBytes: effectiveLogBytes,
          logExcerpt: extractCompileLogExcerpt(effectiveLogText),
        };
      }

      if (checked) {
        return {
          ok: true,
          pass: lastPass,
          executable: resolved.resolvedPath,
          configuredPath: resolved.configuredPath,
          mode: resolved.mode,
          version,
          cwd: canonicalJobDir,
          readRoots: resolved.readRoots,
          pdfBytes,
          logBytes,
          flsBytes,
          checked,
          logExcerpt: extractCompileLogExcerpt(logText, 1200),
        };
      }
      return {
        ok: false,
        errorCode: checkError?.code || 'PAPER_COMPILE_OUTPUT_INVALID',
        message: `TeX 产物核验未通过：${checkError?.code || checkError?.message || 'OUTPUT_INVALID'}`,
        pass: lastPass,
        executable: resolved.resolvedPath,
        configuredPath: resolved.configuredPath,
        mode: resolved.mode,
        version,
        cwd: canonicalJobDir,
        readRoots: resolved.readRoots,
        logBytes: effectiveLogBytes,
        logExcerpt: extractCompileLogExcerpt(effectiveLogText),
      };
    } finally {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function testCompiler(input = {}) {
    if (input !== null && input !== undefined && !isPlainObject(input)) {
      throw fail('PAPER_COMPILE_PATH_INVALID', '无效的测试参数。', 400);
    }
    const candidate = input && Object.hasOwn(input, 'compilerPath') ? input.compilerPath : undefined;
    const sourceBytes = Buffer.from(TEST_DOCUMENT, 'utf8');
    const { createHash } = await import('node:crypto');
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const result = await compileTex({ sourceBytes, sourceSha256, compilerPath: candidate });
    return {
      ok: result.ok,
      configuredPath: result.configuredPath,
      mode: result.mode,
      resolvedPath: result.executable,
      version: result.version,
      pdfBytes: result.ok ? result.pdfBytes.length : 0,
      error: result.ok ? null : { code: result.errorCode, message: result.message },
      logExcerpt: result.logExcerpt,
    };
  }

  return Object.freeze({
    readSettings,
    saveSettings,
    getSettingsPanel,
    resolveCompiler,
    compileTex,
    testCompiler,
  });
}

export function registerTexSettings(app, texService) {
  if (!texService) return;
  const handleError = (context, error) => context.json({
    ok: false,
    error: { code: error?.code || 'TEX_SETTINGS_ERROR', message: error?.message || '操作失败，请重试。' },
  }, Number.isInteger(error?.status) ? error.status : 500);

  app.get('/settings/tex', async context => {
    try { return context.json({ ok: true, tex: await texService.getSettingsPanel() }); }
    catch (error) { return handleError(context, error); }
  });
  app.post('/settings/tex', async context => {
    let body;
    try { body = await context.req.json(); }
    catch { return context.json({ ok: false, error: { code: 'INVALID_JSON', message: '请求内容不是有效的 JSON。' } }, 400); }
    try { return context.json({ ok: true, tex: await texService.saveSettings(body) }); }
    catch (error) { return handleError(context, error); }
  });
  app.post('/settings/tex/test', async context => {
    let body = {};
    try {
      const text = await context.req.text();
      if (text && text.trim()) body = JSON.parse(text);
    } catch { return context.json({ ok: false, error: { code: 'INVALID_JSON', message: '请求内容不是有效的 JSON。' } }, 400); }
    try { return context.json({ ok: true, result: await texService.testCompiler(body) }); }
    catch (error) { return handleError(context, error); }
  });
}
