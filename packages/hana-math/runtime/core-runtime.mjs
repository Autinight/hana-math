// Fixed software diagnostic only. Never accepts tool names, code, projects or CLI arguments.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PYTHON_VERSION, pythonLaunch, matchesPythonRuntime, windowsAbsolute, sameWindowsPath, insideRoot,
  withWindowsFile, openWindowsExclusive } from './python-launch.mjs';

const onWindows = process.platform === 'win32';
const packageUrl = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE_ROOT = onWindows ? path.resolve(packageUrl) : packageUrl;
const TERMINAL = new Set(['exited', 'failed', 'stopped']);
const STATES = new Set(['starting', 'ready', 'stopping', ...TERMINAL]);
const CHECKS = ['imports', 'glossary', 'globalMemory', 'verifierRequired', 'noFacts'];
const MAX_JSON = 16384;
const MAX_STREAM = 1024 * 1024;

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = `CORE_RUNTIME_${code}`;
  return error;
}
function hostFailure(error, fallback) {
  if (error?.code?.startsWith('CORE_RUNTIME_')) return error;
  const denied = /DENIED|NOT_GRANTED|PERMISSION|CAPABILITY|EACCES|EPERM/i.test(error?.code || '')
    || /not authorized|not granted|permission denied/i.test(error?.message || '');
  return failure(denied ? 'DENIED' : fallback, error?.message || String(error), error);
}
const samePath = onWindows ? sameWindowsPath : (a, b) => a === b;
async function canonicalRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || onWindows && !windowsAbsolute(value)) throw failure('PATH_INVALID', 'An absolute owned root is required');
  if (!(await fs.lstat(value)).isDirectory()) throw failure('PATH_INVALID', 'Owned root must be a directory, not a symlink');
  const resolved = await fs.realpath(value);
  if (onWindows && !samePath(resolved, value)) throw failure('PATH_INVALID', 'Owned root must not be an alias');
  return resolved;
}
async function plainChild(root, relative, kind, singleLink = false) {
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) throw failure('PATH_INVALID', 'Invalid package/data path');
  let target = root;
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (index < parts.length - 1 || kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || singleLink && stat.nlink !== 1)) {
      throw failure('PATH_INVALID', 'Symlinks and unexpected file types are not allowed');
    }
  }
  if (!insideRoot(root, target) || !samePath(await fs.realpath(target), target)) throw failure('PATH_INVALID', 'Path escaped its canonical root');
  return target;
}
async function readJson(file, { singleLink = false, checkPath } = {}) {
  const read = async (handle) => {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_JSON || (singleLink && stat.nlink !== 1)) throw failure('INVALID_RESULT', 'JSON file type, size or link count is invalid');
    // Bound reads even if a peer grows the file after stat().
    const buffer = Buffer.alloc(MAX_JSON + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_JSON) throw failure('INVALID_RESULT', 'JSON exceeds the size limit');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  };
  if (checkPath) return withWindowsFile(file, checkPath, () => failure('INVALID_RESULT', 'Unsafe JSON file identity'), read);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await read(handle); } finally { await handle.close(); }
}
async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('CLEANUP_FAILED', message)), ms); })]);
  } finally { clearTimeout(timer); }
}

/** Trusted construction options are for isolated tests, never model/tool input. */
export function createCoreRuntime(sdk, {
  packageRoot = PACKAGE_ROOT, platform = process.platform, arch = process.arch,
  timeoutMs = 30000, cleanupTimeoutMs = 3000,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) throw new TypeError('Timeouts must be positive integers');
  let disposed = false;
  let inFlight = null;
  const owned = new Set();

  async function installation() {
    const launch = pythonLaunch(platform, arch, failure);
    for (const method of ['start', 'get', 'watch', 'stop']) {
      if (typeof sdk?.runtime?.[method] !== 'function') throw failure('MISSING', `sdk.runtime.${method} is unavailable`);
    }
    try {
      const root = await canonicalRoot(packageRoot);
      const metadataPath = () => plainChild(root, 'dependencies/runtime.json', 'file', launch.windows);
      const metadata = await readJson(await metadataPath(), { checkPath: launch.windows ? metadataPath : undefined });
      if (metadata?.schemaVersion !== 1 || metadata.platform !== platform || metadata.arch !== arch || metadata.pythonVersion !== PYTHON_VERSION) {
        throw failure('UNSUPPORTED', 'Packaged Python metadata does not match this supported platform/version');
      }
      if (metadata.executable !== launch.executable) throw failure('PATH_INVALID', 'Unexpected Python executable path');
      // Preserve the internal bin/python3 alias on macOS only.
      const executable = launch.windows ? await plainChild(root, launch.executable, 'file', true)
        : await fs.realpath(path.join(root, launch.executable));
      if (!insideRoot(root, executable) || !(await fs.stat(executable)).isFile()) throw failure('PATH_INVALID', 'Python executable is outside the install directory');
      if (!launch.windows) await fs.access(executable, constants.X_OK);
      const entry = await plainChild(root, 'runtime/core_entry.py', 'file', launch.windows);
      await plainChild(root, 'engine/src/danus/core/glossary_global.json', 'file', launch.windows);
      await plainChild(root, 'engine/src/hana_math_engine/service.py', 'file', launch.windows);
      return { root, executable, entry, launch };
    } catch (error) { throw hostFailure(error, error.code === 'ENOENT' ? 'MISSING' : 'INVALID_RESULT'); }
  }

  function status(info, state) {
    if (!info || typeof info.runtimeId !== 'string' || !info.runtimeId || (state.id && info.runtimeId !== state.id)
      || !STATES.has(info.state) || !matchesPythonRuntime(info, state.launch)) {
      throw failure('INVALID_RESULT', 'Invalid or mismatched managed runtime status');
    }
    state.info = info;
    state.terminal = TERMINAL.has(info.state);
    return info;
  }
  async function stopOwned(state) {
    if (!state.id || state.terminal) return;
    if (!state.stopPromise) {
      state.stopPromise = Promise.resolve().then(() => sdk.runtime.stop(state.id)).then((info) => {
        status(info, state);
        if (!state.terminal) throw failure('CLEANUP_FAILED', 'runtime.stop did not confirm a terminal state');
      });
    }
    await bounded(state.stopPromise, cleanupTimeoutMs, 'Timed out stopping owned runtime');
  }
  async function cleanup(state) {
    if (state.cleanupPromise) return state.cleanupPromise;
    state.cleanupPromise = (async () => {
      const errors = [];
      try { await stopOwned(state); } catch (error) { errors.push(hostFailure(error, 'CLEANUP_FAILED')); }
      if (state.watchPending) {
        try { await bounded(state.watchPromise.then(() => {}, () => {}), cleanupTimeoutMs, 'Runtime watch remains unresolved during cleanup'); }
        catch (error) { errors.push(error); }
      }
      if (state.lateCleanupError) errors.push(state.lateCleanupError);
      if (state.reader) {
        try { await bounded(state.reader.cancel(), cleanupTimeoutMs, 'Timed out canceling runtime watcher'); }
        catch (error) { errors.push(hostFailure(error, 'CLEANUP_FAILED')); }
        try { state.reader.releaseLock(); } catch (error) { errors.push(hostFailure(error, 'CLEANUP_FAILED')); }
        state.reader = null;
      }
      if (!errors.length && !state.startPending && !state.watchPending && (!state.id || state.terminal)) owned.delete(state);
      if (errors.length) {
        const error = failure('CLEANUP_FAILED', 'Managed runtime cleanup failed');
        error.errors = errors;
        throw error;
      }
    })();
    return state.cleanupPromise;
  }
  function interruptible(promise, state) { return Promise.race([promise, state.interrupted]); }
  async function recordLateCleanup(state, error) {
    state.lateCleanupError = error;
    if (state.cancelled) state.cancelled.cleanupErrors = [...state.cancelled.cleanupErrors || [], error];
    try {
      if (typeof sdk.logger?.error === 'function') {
        await bounded(Promise.resolve().then(() => sdk.logger.error('Late core diagnostic cleanup failed: %s', error.message)), cleanupTimeoutMs, 'Timed out logging late runtime cleanup failure');
      } else console.error('Late core diagnostic cleanup failed:', error);
    } catch (loggingError) {
      error.loggingError = loggingError;
      console.error('Late core diagnostic cleanup failed:', error, 'Logger also failed:', loggingError);
    }
  }

  async function observe(state) {
    if (!state.terminal) {
      state.watchPending = true;
      state.watchPromise = Promise.resolve().then(() => sdk.runtime.watch(state.id)).then(async (response) => {
        try {
          if (!response?.ok || !response.body?.getReader) {
            if (response?.body) await bounded(response.body.cancel(), cleanupTimeoutMs, 'Invalid watcher body did not close');
            throw failure('INVALID_RESULT', 'Runtime watcher did not return a readable response');
          }
          if (state.cancelled) {
            try { await bounded(response.body.cancel(), cleanupTimeoutMs, 'Late runtime watcher did not close'); }
            catch (lateError) { await recordLateCleanup(state, lateError); throw lateError; }
            throw state.cancelled;
          }
          state.reader = response.body.getReader();
        } finally {
          state.watchPending = false;
          if (state.cancelled && state.terminal && !state.reader && !state.lateCleanupError) owned.delete(state);
        }
      }, (error) => { state.watchPending = false; throw error; });
      await interruptible(state.watchPromise, state);
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '';
      let total = 0;
      let records = 0;
      const consume = (line) => {
        if (!line.trim()) return;
        if (++records > 4096 || Buffer.byteLength(line) > 65536) throw failure('INVALID_RESULT', 'Runtime watch record limit exceeded');
        let record;
        try { record = JSON.parse(line); } catch (error) { throw failure('INVALID_RESULT', 'Malformed runtime NDJSON', error); }
        if (record?.type === 'log') return; // Child stdout/stderr is never trusted as a result.
        if (typeof record?.type !== 'string') throw failure('INVALID_RESULT', 'Missing runtime event type');
        status(record.runtime, state);
      };
      while (!state.terminal) {
        const { done, value } = await interruptible(state.reader.read(), state);
        if (value) {
          total += value.byteLength;
          if (total > MAX_STREAM) throw failure('INVALID_RESULT', 'Runtime watch byte limit exceeded');
          pending += decoder.decode(value, { stream: true });
        }
        if (done) pending += decoder.decode();
        let newline;
        while (!state.terminal && (newline = pending.indexOf('\n')) >= 0) {
          consume(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        }
        if (Buffer.byteLength(pending) > 65536) throw failure('INVALID_RESULT', 'Runtime watch line limit exceeded');
        if (done) { if (!state.terminal && pending.trim()) consume(pending); break; }
      }
    }
    // One authoritative read also handles an already-exited runtime and a watch
    // that closed at the same time as process exit. This is not polling.
    const final = status(await interruptible(Promise.resolve().then(() => sdk.runtime.get(state.id)), state), state);
    if (!state.terminal || final.state !== 'exited' || final.exitCode !== 0 || final.signal) {
      throw failure('FAILED', `Diagnostic runtime did not exit successfully (${final.state}, ${final.exitCode ?? 'no exit code'})`);
    }
    return final;
  }

  async function execute(state) {
    let result;
    let error;
    const timer = setTimeout(() => state.cancel(failure('TIMEOUT', 'Core diagnostic exceeded its deadline')), timeoutMs);
    try {
      const install = await interruptible(installation(), state);
      state.launch = install.launch;
      const data = await interruptible(canonicalRoot(sdk.dataDir), state);
      if (!path.relative(data, install.root) || insideRoot(install.root, data) || insideRoot(data, install.root)) throw failure('PATH_INVALID', 'Install and diagnostic data roots must not overlap');
      const checks = path.join(data, 'core-checks');
      try { await fs.mkdir(checks, { mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
      await plainChild(data, 'core-checks', 'directory');
      const requestId = randomUUID();
      const directory = path.join(checks, requestId);
      await fs.mkdir(directory, { mode: 0o700 });
      await plainChild(data, `core-checks/${requestId}`, 'directory');
      const requestPath = path.join(directory, 'request.json');
      const resultPath = path.join(directory, 'result.json');
      const request = { schemaVersion: 1, requestId, operation: 'core-diagnostic' };
      const handle = install.launch.windows
        ? await openWindowsExclusive(requestPath, created => created ? plainChild(data, `core-checks/${requestId}/request.json`, 'file', true)
          : plainChild(data, `core-checks/${requestId}`, 'directory'), () => failure('PATH_INVALID', 'Unsafe request file identity'))
        : await fs.open(requestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(request), 'utf8'); } finally { await handle.close(); }
      if (state.cancelled) throw state.cancelled;
      state.startPending = true;
      state.startPromise = Promise.resolve().then(() => {
        if (state.cancelled) throw state.cancelled;
        return sdk.runtime.start({
          runtime: 'command', command: install.executable,
          args: ['-I', '-S', '-B', install.entry, '--request', requestPath, '--result', resultPath],
          cwd: directory, profile: state.launch.profile, network: state.launch.network,
        });
      }).then(async (info) => {
        state.startPending = false;
        if (typeof info?.runtimeId === 'string' && info.runtimeId) state.id = info.runtimeId;
        if (state.cancelled) {
          try { await stopOwned(state); if (state.terminal || !state.id) owned.delete(state); }
          catch (lateError) {
            await recordLateCleanup(state, lateError);
            throw lateError;
          }
          throw state.cancelled;
        }
        return status(info, state);
      }, (startError) => { state.startPending = false; if (!state.id) owned.delete(state); throw hostFailure(startError, 'START_FAILED'); });
      await interruptible(state.startPromise, state);
      const final = await observe(state);
      let diagnostic;
      try {
        const checkPath = () => plainChild(data, `core-checks/${requestId}/result.json`, 'file', state.launch.windows);
        await checkPath();
        diagnostic = await readJson(resultPath, { singleLink: true, checkPath: state.launch.windows ? checkPath : undefined });
      } catch (err) { throw failure('INVALID_RESULT', 'Missing, unsafe or malformed diagnostic result file', err); }
      if (diagnostic?.schemaVersion !== 1 || diagnostic.requestId !== requestId || diagnostic.operation !== 'core-diagnostic'
        || diagnostic.ok !== true || diagnostic.pythonVersion !== PYTHON_VERSION || !diagnostic.checks
        || Object.keys(diagnostic.checks).length !== CHECKS.length || !CHECKS.every((key) => diagnostic.checks[key] === true)) {
        throw failure('INVALID_RESULT', 'Diagnostic identity, version or checks do not match the request');
      }
      if (state.cancelled) throw state.cancelled;
      result = { ok: true, requestId, directory, diagnostic, runtime: final };
    } catch (err) { error = hostFailure(err, 'FAILED'); }
    finally {
      clearTimeout(timer);
      try { await cleanup(state); }
      catch (cleanupError) {
        if (error) error.cleanupErrors = cleanupError.errors || [cleanupError];
        else error = cleanupError;
      }
      // A pending host start has no ID to stop yet. Its continuation above owns
      // late cleanup; dispose() also waits boundedly and reports any uncertainty.
    }
    if (error) throw error;
    return result;
  }

  function check(...arguments_) {
    if (arguments_.length) return Promise.reject(failure('INVALID_RESULT', 'check accepts no input'));
    if (disposed) return Promise.reject(failure('DISPOSED', 'Core runtime bridge is disposed'));
    if (inFlight) return inFlight; // Concurrent callers share exactly one diagnostic.
    if (owned.size) return Promise.reject(failure('BUSY', 'A previous diagnostic still has unresolved runtime cleanup'));
    let reject;
    const state = { interrupted: new Promise((_, fail) => { reject = fail; }) };
    state.interrupted.catch(() => {}); // Cancellation can arrive before the first awaited operation.
    state.cancel = (error) => { if (!state.cancelled) { state.cancelled = error; reject(error); } };
    owned.add(state);
    inFlight = execute(state).finally(() => { inFlight = null; });
    return inFlight;
  }
  async function dispose() {
    disposed = true;
    const states = [...owned];
    for (const state of states) state.cancel(failure('DISPOSED', 'Core diagnostic was disposed'));
    const errors = [];
    for (const state of states) {
      if (state.startPromise) {
        try {
          // Includes late stop/logging work after start already returned an ID.
          await bounded(state.startPromise.then(() => {}, () => {}), cleanupTimeoutMs, 'Runtime start/late cleanup remains unresolved during disposal');
        } catch (error) { errors.push(error); }
      }
      if (state.lateCleanupError) errors.push(state.lateCleanupError);
      try { await cleanup(state); } catch (error) { errors.push(error); }
    }
    if (errors.length) { const error = failure('CLEANUP_FAILED', 'Core runtime disposal could not confirm cleanup'); error.errors = errors; throw error; }
  }
  return Object.freeze({ check, dispose });
}
