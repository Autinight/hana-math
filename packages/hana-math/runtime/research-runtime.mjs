// Trusted host bridge. No executable, filesystem path or cancellation comes from model tools.
import fs from 'node:fs/promises';
import filesystem, { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { createManagedReadOwner, managedReadOwnerFor, managedDashboardReadOwnerFor, MANAGED_READ_SLOT_BYTES } from './managed-read-owner.mjs';
import { PYTHON_VERSION, pythonLaunch, matchesPythonRuntime, windowsAbsolute, sameWindowsPath, insideRoot,
  withWindowsFile, openWindowsExclusive } from './python-launch.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const LIMIT = 1 << 20;
export const CORE_CALLS_MAX_BYTES = 512 << 20;
// At three files per settled call, 4096 directories use 12288 of the 16384
// scanned entries. The byte budget and reservations for unfinished calls still apply.
export const CORE_CALLS_MAX_DIRECTORIES = 4096;
export const CORE_CALL_RESERVATION_BYTES = 2 * LIMIT;
const CORE_CALLS_MAX_ENTRIES = 16384;
// Shared by every bridge in this process. Disk markers retain conservative
// reservations across restart; absence of .complete means cleanup is unconfirmed.
const ipcQueues = new Map();
async function serialIpc(root, operation) {
  const previous = ipcQueues.get(root) || Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  const tail = task.catch(() => {});
  ipcQueues.set(root, tail);
  try { return await task; }
  finally { if (ipcQueues.get(root) === tail) ipcQueues.delete(root); }
}
const OPS = new Set(['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'prepare_submission', 'fact_submit', 'fact_get', 'fact_list', 'fact_list_page', 'dashboard_factgraph', 'dashboard_memory', 'local_memory_append', 'local_memory_read']);
const TERMINAL = new Set(['exited', 'failed', 'stopped']);
const STATES = new Set(['starting', 'ready', 'stopping', ...TERMINAL]);
const CONTROL_ID = /^control-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const onWindows = process.platform === 'win32';
const samePath = onWindows ? sameWindowsPath : (a, b) => a === b;
// Windows Node mode bits cannot attest POSIX 0600. The Host owns the ACL;
// retain regular/single-link and canonical path checks instead of inferring it.
const privateMode = stat => onWindows || (stat.mode & 0o777) === 0o600;
function fault(code, message, cause) { return Object.assign(new Error(message, { cause }), { code: `RESEARCH_RUNTIME_${code}` }); }
function plain(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > 16384 || depth > 16) throw fault('INVALID_REQUEST', 'JSON structure limit exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { budget.bytes += Buffer.byteLength(value); if (budget.bytes > LIMIT) throw fault('INVALID_REQUEST', 'JSON size limit exceeded'); return; }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw fault('INVALID_REQUEST', 'Plain JSON required');
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (Array.isArray(value) && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw fault('INVALID_REQUEST', 'JSON array indices required');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw fault('INVALID_REQUEST', 'Plain JSON properties required');
    plain(key, depth + 1, budget); plain(descriptor.value, depth + 1, budget);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw fault('INVALID_REQUEST', 'Dense JSON arrays required');
}
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
function canonicalPath(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) !== target || target.includes('\0')
    || onWindows && !windowsAbsolute(target)) throw fault('PATH_INVALID', 'Canonical absolute path required');
}
async function ownedRoot(root) {
  canonicalPath(root);
  // The host grants these roots, not their ancestors. realpath equality rejects
  // ancestor aliases without explicitly lstat'ing paths outside the grant.
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(root), root)) throw fault('PATH_INVALID', 'Unsafe owned root');
  return root;
}
async function safe(root, target, kind = 'directory', singleLink = false) {
  canonicalPath(root); canonicalPath(target);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fault('PATH_INVALID', 'Path escaped its owned root');
  await ownedRoot(root);
  if (!relative) {
    if (kind !== 'directory') throw fault('PATH_INVALID', 'Expected a file below its owned root');
    return root;
  }
  let current = root;
  const parts = relative.split(path.sep);
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 || kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || singleLink && stat.nlink !== 1)) throw fault('PATH_INVALID', 'Unsafe file path');
  }
  if (onWindows && !samePath(await fs.realpath(target), target)) throw fault('PATH_INVALID', 'Path is not canonical');
  return target;
}
async function json(root, file, max = LIMIT, owned = false, observeFile, windows = false) {
  const checkPath = () => safe(root, file, 'file', windows);
  const read = async (handle) => {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max || (owned && (stat.nlink !== 1 || !privateMode(stat)))) throw fault('INVALID_RESULT', 'Unsafe JSON file');
    const before = observeFile && await scratchStat(handle);
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) throw fault('INVALID_RESULT', 'JSON limit exceeded');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
    if (before?.size === BigInt(bytesRead) && sameScratchFile(before, await scratchStat(handle))) observeFile(before);
    return value;
  };
  if (windows) return withWindowsFile(file, checkPath, () => fault('INVALID_RESULT', 'Unsafe JSON file identity'), read);
  await checkPath();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return await read(handle); } finally { await handle.close(); }
}
// Private evidence for the original request, independent of ids and disk markers.
const completedReadScratch = new WeakMap(), completedDashboardBusy = new WeakMap(), completedDashboardGraphFallback = new WeakMap(), projectScratchOptions = new WeakSet();
const dashboardOptions = new WeakSet(), dashboardMemoryOptions = new WeakSet(), dashboardViewOptions = new WeakMap();
const dashboardKinds = new Set(['conclusion', 'example', 'counterexample', 'proof_attempt', 'plan', 'direction',
  'obstacle', 'dead_end', 'verification', 'elaboration', 'master_guidance']);
function validDashboardMemoryKeys(args, keys) {
  if ((args.view === 'overview' || args.view === 'channels') && keys.length === 1 && keys[0] === 'view') return true;
  return args.view === 'channel' && keys.length === 2 && keys.includes('view') && keys.includes('kind') && dashboardKinds.has(args.kind);
}
export function validProjectDashboardMemorySelection(args) {
  return validDashboardMemoryKeys(args, Reflect.ownKeys(args));
}
// Terminal is an internal view argument, never a member of a public selection.
// Callers here have already validated the argument object as plain JSON.
const FACT_ID = /^[0-9a-f]{16}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
export function validProjectDashboardReadArguments(operation, args, allowTerminal) {
  let keys = Reflect.ownKeys(args);
  if (keys.includes('terminal')) {
    if (!allowTerminal || args.terminal !== true) return false;
    keys = keys.filter(key => key !== 'terminal');
  }
  if (operation === 'dashboard_factgraph') {
    if (keys.length === 0) return true;
    if (args.mode === 'index') {
      if (!keys.every(k => ['mode', 'offset', 'limit', 'asOf'].includes(k))) return false;
      const offset = args.offset ?? 0, limit = args.limit ?? 512;
      return Number.isSafeInteger(offset) && offset >= 0 && offset < 4096
        && Number.isSafeInteger(limit) && limit >= 1 && limit <= 1024
        && (args.asOf === undefined || typeof args.asOf === 'string' && SHA256_HEX.test(args.asOf));
    }
    if (args.mode === 'fact') {
      return keys.every(k => ['mode', 'factId', 'asOf'].includes(k))
        && typeof args.factId === 'string' && FACT_ID.test(args.factId)
        && (args.asOf === undefined || typeof args.asOf === 'string' && SHA256_HEX.test(args.asOf));
    }
    return false;
  }
  return operation === 'dashboard_memory' && validDashboardMemoryKeys(args, keys);
}
// Only internal ProjectCoreAccess mints this; a model argument or a copy of
// the options object cannot authorize the dashboard operation.
export function projectDashboardFactgraphOptions(signal) {
  const options = Object.freeze({ signal });
  dashboardOptions.add(options);
  return options;
}
// The graph brand cannot be replayed as authority for shared memory.
export function projectDashboardMemoryOptions(signal) {
  const options = Object.freeze({ signal });
  dashboardMemoryOptions.add(options);
  return options;
}
export function projectDashboardViewOptions(operation, signal, guard) {
  if (!['dashboard_factgraph', 'dashboard_memory'].includes(operation) || typeof guard !== 'function') throw fault('INVALID_REQUEST', 'Invalid dashboard view options');
  const options = Object.freeze({ signal });
  dashboardViewOptions.set(options, { operation, guard });
  return options;
}
export function projectReadScratchOptions(signal) {
  const options = { signal };
  projectScratchOptions.add(options);
  return options;
}
const scratchFiles = ['request.json', 'result.json', '.complete'];
const localStat = file => filesystem.lstatSync(file, { bigint: true });
const ownedMode = (stat, mode) => typeof process.geteuid === 'function' && stat.uid === BigInt(process.geteuid()) && (stat.mode & 0o7777n) === mode;
const sameNode = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
const scratchFile = s => !!s && s.isFile() && s.nlink === 1n && ownedMode(s, 0o600n);
const sameScratchFile = (a, b) => scratchFile(a) && scratchFile(b) && sameNode(a, b)
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
async function scratchStat(handle) { try { return await handle.stat({ bigint: true }); } catch { return null; } }
function retireScratch(s) {
  const root = path.dirname(s.directory);
  // Do not wait behind a reservation or detach deletion from its caller. This
  // synchronous lease uses the same queue key as reservation and settlement.
  if (ipcQueues.has(root)) return;
  const lease = Promise.resolve(); ipcQueues.set(root, lease);
  try {
    const remaining = [...scratchFiles];
    const verify = () => {
      if (filesystem.realpathSync(s.dataRoot) !== s.dataRoot) return false;
      for (const [name, before] of s.scratchDirectories) {
        const now = localStat(name);
        // ContextStore may create the research parent with 0755; only the
        // owner can write there. The data root and IPC directories are private.
        const mode = ownedMode(now, 0o700n) || name === path.dirname(root) && ownedMode(now, 0o755n);
        if (!now.isDirectory() || !mode || !sameNode(now, before)) return false;
      }
      const dir = filesystem.opendirSync(s.directory, { bufferSize: 4 });
      try {
        const expected = new Set(remaining);
        for (let i = 0; i <= remaining.length; i++) {
          const entry = dir.readSync();
          if (!entry) return expected.size === 0;
          if (!expected.delete(entry.name) || !sameScratchFile(s.scratchIdentity[entry.name], localStat(path.join(s.directory, entry.name)))) return false;
        }
        return false;
      } finally { dir.closeSync(); }
    };
    // Node has no identity-conditional unlink/rmdir. Mode/identity and the
    // in-process queue are supplemental checks, not whole-root exclusivity.
    // The injected host lifetime must exclude other owners for this whole callback.
    while (remaining.length) {
      if (!verify()) return;
      filesystem.unlinkSync(path.join(s.directory, remaining[0]));
      remaining.shift(); // .complete is intentionally last; partial work is not a release receipt.
    }
    if (verify()) filesystem.rmdirSync(s.directory);
  } catch { /* Optional transport reclamation cannot change a settled read. */ }
  finally { if (ipcQueues.get(root) === lease) ipcQueues.delete(root); }
}
export function takeProjectReadScratch(bridge, attempt, operation, value) {
  const proof = completedReadScratch.get(attempt);
  if (!proof || proof.s.invocation.bridge !== bridge || proof.s.operation !== operation || proof.value !== value) return null;
  completedReadScratch.delete(attempt);
  if (proof.releaseFrame) return proof.releaseFrame;
  if (!proof.s.withScratchLifetime(() => true, proof.s.scratchTenure)) return null;
  let state = proof.s;
  return () => {
    const owned = state; state = null;
    if (owned) owned.withScratchLifetime(() => retireScratch(owned), owned.scratchTenure);
  };
}
// Only the trusted caller may take this after settling and persisting the
// failed task. Cleanup of the settled call (abort/dispose) is not a revocation.
export function takeDashboardBusyFrame(bridge, attempt, operation, error) {
  const proof = completedDashboardBusy.get(attempt);
  if (!proof || proof.bridge !== bridge || proof.operation !== operation || proof.error !== error) return null;
  completedDashboardBusy.delete(attempt);
  let accept = proof.accept;
  return () => {
    const rearm = accept; accept = null;
    return rearm?.() ?? false;
  };
}
export function takeDashboardGraphFallbackFrame(bridge, attempt, operation, error) {
  const proof = completedDashboardGraphFallback.get(attempt);
  if (!proof || proof.bridge !== bridge || proof.operation !== operation || proof.error !== error) return null;
  completedDashboardGraphFallback.delete(attempt);
  let accept = proof.accept;
  return () => {
    const rearm = accept; accept = null;
    return rearm?.() ?? false;
  };
}
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function dashboardBusyEnvelope(envelope) {
  // Called only after checking schemaVersion, requestId and ok === false.
  // The release dispatcher refuses pre-mutation on project lock contention.
  return exactKeys(envelope, ['schemaVersion', 'requestId', 'ok', 'error'])
    && exactKeys(envelope.error, ['code', 'message'])
    && envelope.error.code === 'busy' && envelope.error.message === 'project is busy';
}
function dashboardFactgraphFallbackEnvelope(operation, envelope) {
  // Clean pre-mutation Core refusal for large fact-graph pagination fallback or page drift.
  return operation === 'dashboard_factgraph'
    && exactKeys(envelope, ['schemaVersion', 'requestId', 'ok', 'error'])
    && exactKeys(envelope.error, ['code', 'message'])
    && (envelope.error.code === 'size_limit' || envelope.error.code === 'fact_page_changed')
    && typeof envelope.error.message === 'string' && envelope.error.message.length > 0 && envelope.error.message.length <= 256;
}
// Only local admission faults can mint this evidence for the exact call promise.
const ipcRefusals = new WeakMap();
function ipcCapacity(s, reason, message) {
  const error = fault('CAPACITY', message);
  ipcRefusals.set(s.invocation.promise, { bridge: s.invocation.bridge, error, requestId: s.requestId, operation: s.operation, reason });
  return error;
}
const ipcRoot = data => path.join(data, 'research', 'core-calls');
const noGuard = () => {};
async function ipcUsage(dataRoot, root, capacity, guard = noGuard) {
  let bytes = 0, logicalBytes = 0, directories = 0, entries = 0;
  await safe(dataRoot, root); guard();
  for (const name of await fs.readdir(root)) {
    guard();
    const directory = path.join(root, name);
    await safe(dataRoot, directory); guard();
    directories++;
    let actual = 0, complete = false;
    const pending = [directory];
    while (pending.length) {
      const parent = pending.pop();
      await safe(dataRoot, parent); guard();
      for (const child of await fs.readdir(parent)) {
        guard();
        const target = path.join(parent, child), info = await fs.lstat(target);
        guard();
        if (++entries > CORE_CALLS_MAX_ENTRIES) throw capacity('entry-limit', 'Unsafe or excessive managed IPC entries');
        if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw capacity('unsafe-entry', 'Unsafe or excessive managed IPC entries');
        if (info.isDirectory()) { directories++; pending.push(target); }
        else {
          actual += info.size;
          if (parent === directory && child === '.complete') {
            if (info.size !== 0 || !privateMode(info) || onWindows && !samePath(await fs.realpath(target), target))
              throw capacity('invalid-completion-marker', 'Invalid IPC completion marker');
            complete = true;
          }
        }
        if (directories > CORE_CALLS_MAX_DIRECTORIES) throw capacity('directory-limit', 'Managed IPC storage is full');
        if (actual > CORE_CALLS_MAX_BYTES) throw capacity('byte-limit', 'Managed IPC storage is full');
      }
      guard();
    }
    logicalBytes += actual;
    bytes += complete ? actual : Math.max(CORE_CALL_RESERVATION_BYTES, actual);
    if (directories > CORE_CALLS_MAX_DIRECTORIES) throw capacity('directory-limit', 'Managed IPC storage is full');
    if (bytes > CORE_CALLS_MAX_BYTES) throw capacity('byte-limit', 'Managed IPC storage is full');
  }
  guard();
  return { bytes, logicalBytes, directories, entries };
}
// App-global on-demand observation; trusted dataRoot only. No reservation,
// lock/queue, mutation or exact-call refusal proof belongs to this read.
export async function readManagedIpcUsage(dataRoot, guard = noGuard) {
  guard(); await ownedRoot(dataRoot); guard();
  const root = ipcRoot(dataRoot);
  // Only absence found before traversal is empty. A failed safety check,
  // readdir or descendant stat (including ENOENT) never yields partial counts.
  const exists = async directory => {
    guard();
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    guard();
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw fault('PATH_INVALID', 'Unsafe managed IPC directory');
    return !!stat;
  };
  const usage = await exists(path.dirname(root)) && await exists(root)
    ? await ipcUsage(dataRoot, root, (_reason, message) => fault('CAPACITY', message), guard)
    : { bytes: 0, logicalBytes: 0, directories: 0, entries: 0 };
  guard();
  const counts = (used, limit) => ({ used, limit, remaining: limit - used });
  const directories = counts(usage.directories, CORE_CALLS_MAX_DIRECTORIES), entries = counts(usage.entries, CORE_CALLS_MAX_ENTRIES);
  const chargedBytes = counts(usage.bytes, CORE_CALLS_MAX_BYTES);
  const nearLimitThresholds = { directoryRemaining: 1000, entryOrChargedPercent: 80 };
  return { scope: 'app-global-managed-ipc', atomic: false,
    countScope: { directories: 'exchange-directories-and-descendant-directories', entries: 'descendants-of-exchange-directories',
      logicalBytes: 'sum-of-regular-file-lengths', chargedBytes: 'logical-bytes-per-exchange-with-reservation-floor-when-marker-absent',
      attribution: 'none-project-history-read-write-not-classified' },
    directories, entries, logicalBytes: usage.logicalBytes, chargedBytes, incompleteReservationBytes: CORE_CALL_RESERVATION_BYTES,
    totalReservationOverheadBytes: chargedBytes.used - usage.logicalBytes,
    nearLimit: directories.remaining <= nearLimitThresholds.directoryRemaining
      || [entries, chargedBytes].some(v => v.used * 100 >= v.limit * nearLimitThresholds.entryOrChargedPercent), nearLimitThresholds };
}
async function reserveIpc(data, s, frameAdmission) {
  const root = ipcRoot(data);
  return serialIpc(root, async () => {
    if (!frameAdmission || frameAdmission.fresh) for (const directory of [path.dirname(root), root]) {
      await safe(data, path.dirname(directory));
      try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await safe(data, directory);
    }
    if (s.cancelled) throw s.cancelled;
    const usage = await ipcUsage(data, root, (reason, message) => ipcCapacity(s, reason, message));
    const addedDirectories = frameAdmission && !frameAdmission.fresh ? 0 : 1;
    const addedBytes = frameAdmission ? (frameAdmission.fresh ? MANAGED_READ_SLOT_BYTES : 0) : CORE_CALL_RESERVATION_BYTES;
    if (usage.directories + addedDirectories > CORE_CALLS_MAX_DIRECTORIES) throw ipcCapacity(s, 'directory-limit', 'Managed IPC capacity exhausted; retained calls require explicit reconciliation');
    if (usage.bytes + addedBytes > CORE_CALLS_MAX_BYTES) throw ipcCapacity(s, 'byte-limit', 'Managed IPC capacity exhausted; retained calls require explicit reconciliation');
    if (frameAdmission) {
      if (frameAdmission.fresh && usage.entries + 3 > CORE_CALLS_MAX_ENTRIES) throw ipcCapacity(s, 'entry-limit', 'Unsafe or excessive managed IPC entries');
      if (s.cancelled) throw s.cancelled;
      return frameAdmission.use(root);
    }
    const directory = path.join(root, s.requestId);
    await safe(data, root);
    await fs.mkdir(directory, { mode: 0o700 });
    s.directory = directory;
    s.withScratchLifetime?.(tenure => {
      s.scratchDirectories = [data, path.dirname(root), root, directory].map(name => [name, localStat(name)]);
      s.scratchTenure = tenure;
      s.scratchIdentity = Object.create(null);
    });
    await safe(data, directory);
    return directory;
  });
}
async function settleIpc(s) {
  if (!s.directory) return;
  await serialIpc(path.dirname(s.directory), async () => {
    const closeMarker = async () => {
      if (!s.markerHandle) return;
      await s.markerHandle.close();
      s.markerHandle = null; // Only a fulfilled close releases this owned handle.
    };
    // A failed or still-pending close must settle before EEXIST can confirm the
    // marker. The serial lock also keeps retries behind timed-out in-flight IO.
    await closeMarker();
    await safe(s.dataRoot, s.directory);
    const marker = path.join(s.directory, '.complete');
    // This empty marker only reduces retained IPC storage reservations. It is
    // not a mathematical fact/transaction receipt: a missing marker retains the
    // reservation conservatively. No file/directory fsync or power-loss guarantee
    // is required here; fact-store durability and mutation fences are unchanged.
    try {
      s.markerHandle = s.launch.windows
        ? await openWindowsExclusive(marker, created => created ? safe(s.dataRoot, marker, 'file', true) : safe(s.dataRoot, s.directory),
          () => fault('CLEANUP_FAILED', 'Unsafe IPC completion marker'))
        : await fs.open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      if (s.scratchIdentity) s.scratchIdentity['.complete'] = await scratchStat(s.markerHandle);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (s.scratchIdentity) delete s.scratchIdentity['.complete'];
      const info = await fs.lstat(marker);
      if (!info.isFile() || info.nlink !== 1 || info.size !== 0 || !privateMode(info)) throw fault('CLEANUP_FAILED', 'Unsafe IPC completion marker');
      if (s.launch.windows) await safe(s.dataRoot, marker, 'file', true);
    }
    await closeMarker(); // Close failures must never enter the open/EEXIST catch.
  });
}
const PHASES = new Set(['validation', 'installation', 'data-root', 'request', 'start', 'watch', 'get', 'result', 'cleanup', 'cleanup-start', 'cleanup-get', 'cleanup-stop', 'cleanup-watch', 'cleanup-reader', 'cleanup-pending', 'cleanup-marker', 'dispose']);
const START_OUTCOMES = new Set(['not-attempted', 'rejected-before-spawn', 'acknowledged', 'unknown']);
const SDK_OPERATIONS = new Set(['runtime.start', 'runtime.get', 'runtime.watch', 'runtime.stop', 'runtime.list', 'tasks.resolveScope']);
const SDK_KINDS = new Set(['permission', 'context', 'unavailable', 'unsupported', 'timeout', 'aborted', 'invalid', 'conflict', 'host']);
const SDK_CAPABILITIES = new Set(['app/runtime.execute', 'app/runtime.network', 'app/runtime.native', 'app/runtime.local-machine', 'app/tasks.manage']);
// Diagnostic codes only. Host 1.5.48-beta RuntimeErrorCode is defined in
// bundle/index.js:171552–171570 and task scope checks at 176740–176755;
// none of these diagnostic identifiers expand the no-spawn proof below.
const SDK_CODES = new Set(['APP_TASK_SCOPE_INVALID', 'APP_CALL_TOKEN_INVALID', 'APP_CAPABILITY_DENIED', 'CAPABILITY_DENIED', 'APP_HOST_ERROR', 'APP_SDK_CONTEXT_REQUIRED', 'APP_SDK_HOST_UNSUPPORTED', 'RPC_TIMEOUT', 'RPC_ABORTED', 'BUS_REQUEST_ABORTED', 'APP_RUNTIME_IPC_TIMEOUT',
  'APP_RUNTIME_CAPABILITY_DENIED', 'APP_RUNTIME_NETWORK_DENIED', 'APP_RUNTIME_NATIVE_DENIED', 'APP_RUNTIME_LOCAL_MACHINE_DENIED',
  'APP_RUNTIME_DISPOSED', 'APP_RUNTIME_SANDBOX_UNAVAILABLE', 'APP_RUNTIME_LOOPBACK_UNSUPPORTED', 'APP_RUNTIME_INVALID_INPUT',
  'APP_RUNTIME_SCOPE_DENIED', 'APP_RUNTIME_CONCURRENCY_LIMIT', 'APP_RUNTIME_NOT_FOUND', 'APP_RUNTIME_NOT_READY',
  'APP_RUNTIME_FETCH_TIMEOUT', 'APP_RUNTIME_FETCH_RESPONSE_TOO_LARGE', 'APP_RUNTIME_SERVICE_STOPPED', 'APP_RUNTIME_SERVICE_UNAVAILABLE',
  'APP_RUNTIME_SERVICE_ID_CONFLICT', 'APP_RUNTIME_SERVICE_OBSERVER_LIMIT']);
const FAILURE_CODES = new Set([...SDK_CODES, 'EACCES', 'EPERM', 'ENOENT', 'EIO', 'EEXIST', 'ENOTDIR', 'ERR_ACCESS_DENIED',
  ...['INVALID_REQUEST', 'PATH_INVALID', 'INVALID_RESULT', 'CAPACITY', 'CLEANUP_FAILED', 'CLEANUP_PENDING', 'UNKNOWN_START', 'UNSUPPORTED', 'MISSING', 'DISPOSED', 'CANCELLED', 'TIMEOUT', 'FAILED', 'DENIED', 'REJECTED', 'READ_SLOT_FENCED'].map((code) => `RESEARCH_RUNTIME_${code}`)]);
const member = (value, key) => {
  if (!value || !['object', 'function'].includes(typeof value)) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
};
// Read-only; does not follow cause/runtime or accept a thenable/derived promise in place of the original call.
export function runtimeManagedIpcRefusal(bridge, promise, error, operation) {
  const proof = ipcRefusals.get(promise);
  return proof && proof.bridge === bridge && proof.error === error && proof.operation === operation
    && member(error, 'code') === 'RESEARCH_RUNTIME_CAPACITY' && member(error, 'requestId') === proof.requestId
    && member(error, 'operation') === operation ? proof.reason : null;
}
const enumValue = (set, value) => typeof value === 'string' && set.has(value) ? value : null;
const runtimeIdValue = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null;
const ENFORCEMENTS = new Set(['full', 'partial', 'none']);
function runtimeFields(value, stateKey = 'runtimeState') {
  const exitCode = member(value, 'exitCode'), signal = member(value, 'signal'), backend = member(value, 'backend');
  return { runtimeState: enumValue(STATES, member(value, stateKey)),
    exitCode: Number.isInteger(exitCode) && exitCode >= -2147483648 && exitCode <= 2147483647 ? (exitCode === 0 ? 0 : exitCode) : null,
    signal: typeof signal === 'string' && /^SIG[A-Z0-9]{1,29}$/.test(signal) ? signal : null,
    enforcement: enumValue(ENFORCEMENTS, member(value, 'enforcement')),
    backend: typeof backend === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(backend) ? backend : null };
}
function sdkFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const operation = enumValue(SDK_OPERATIONS, member(value, 'operation'));
  return operation ? { code: enumValue(SDK_CODES, member(value, 'code')), operation,
    kind: enumValue(SDK_KINDS, member(value, 'kind')), capability: enumValue(SDK_CAPABILITIES, member(value, 'capability')) } : null;
}
function sdkFailure(error) {
  for (let depth = 0, value = error; depth < 5 && value; depth++, value = member(value, 'cause')) {
    // Persisted DTO.sdk is re-projected through exactly the same scalar enums;
    // do not spread it or follow arbitrary nested causes/details inside it.
    const sdk = sdkFields(value) || sdkFields(member(value, 'sdk'));
    if (sdk) return sdk;
  }
  return null;
}
function failureSummary(error) {
  const cleanup = member(error, 'cleanup');
  const errors = member(cleanup, 'errors');
  const safeErrors = Array.isArray(errors) ? errors.slice(0, 16).map((entry) => ({ code: enumValue(FAILURE_CODES, member(entry, 'code')),
    phase: enumValue(PHASES, member(entry, 'phase')), sdk: sdkFailure(entry) })) : [];
  const rid = member(error, 'requestId');
  return { code: enumValue(FAILURE_CODES, member(error, 'code')), phase: enumValue(PHASES, member(error, 'phase')),
    requestId: typeof rid === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(rid) ? rid : null,
    runtimeId: runtimeIdValue(member(error, 'runtimeId')), ...runtimeFields(error), operation: enumValue(OPS, member(error, 'operation')),
    startOutcome: enumValue(START_OUTCOMES, member(error, 'startOutcome')),
    processTerminalConfirmed: typeof member(error, 'processTerminalConfirmed') === 'boolean' ? member(error, 'processTerminalConfirmed') : null,
    indeterminate: typeof member(error, 'indeterminate') === 'boolean' ? member(error, 'indeterminate') : null,
    sdk: sdkFailure(error) || sdkFailure(member(error, 'startError')), cleanup: { confirmed: typeof member(cleanup, 'confirmed') === 'boolean' ? member(cleanup, 'confirmed') : null,
      errorCodes: [...new Set(safeErrors.flatMap((entry) => [entry.code, entry.sdk?.code]).filter(Boolean))], errors: safeErrors } };
}
// Current-call capabilities only: no Error/DTO own fields or Symbols, no JSON inheritance.
const checkedRejections = new WeakMap();
const REJECTION_REASONS = new Map([
  ['fact-page-changed', ['fact-index', null, 'restart-enumeration', 'fact_page_changed']],
  ['invalid-cursor', ['fact-index', null, 'fix-request', 'invalid_cursor']],
  ['fact-page-bytes', ['fact-index', 'bytes', 'report-capacity', 'size_limit']],
  ['response-bytes', ['response', 'bytes', 'reduce-response-scope', 'size_limit']],
  ...[['shared-fact-bytes', 'canonical-fact'], ['shared-glossary-bytes', 'glossary'], ['shared-verification-bytes', 'verification-trace'],
    ['shared-other-file-bytes', 'shared-file'], ['shared-tree-bytes', 'shared-tree'], ['other-file-bytes', 'file']]
    .map(([reason, resource]) => [reason, [resource, 'bytes', 'report-capacity', 'size_limit']]),
  ['shared-tree-files', ['shared-tree', 'files', 'report-capacity', 'size_limit']],
  ['shared-tree-entries', ['shared-tree', 'entries', 'report-capacity', 'size_limit']],
  ['control-bytes', ['control-store', 'bytes', 'report-capacity', 'capacity_exceeded']],
  ['control-entries', ['control-store', 'entries', 'report-capacity', 'capacity_exceeded']],
]);
function checkedDiagnostic(raw, coreCode, operation) {
  if (!raw || typeof raw !== 'object' || isProxy(raw) || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null;
  const keys = ['version', 'reason', 'observed', 'observedLowerBound', 'limit', 'reserve'];
  if (Reflect.ownKeys(raw).length !== keys.length) return null;
  const v = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return null;
    v[key] = d.value;
  }
  const rule = typeof v.reason === 'string' ? REJECTION_REASONS.get(v.reason) : null;
  const number = (value, min) => value === null || Number.isSafeInteger(value) && value >= min;
  if (v.version !== 1 || !rule || coreCode !== rule[3] || !OPS.has(operation)
    || !number(v.observed, 0) || !number(v.limit, 1) || !number(v.reserve, 0)
    || (v.observed === null ? v.observedLowerBound !== null : typeof v.observedLowerBound !== 'boolean')) return null;
  if (['fact-page-changed', 'invalid-cursor', 'fact-page-bytes'].includes(v.reason) && operation !== 'fact_list_page') return null;
  if (['fact-page-changed', 'invalid-cursor'].includes(v.reason)
    && [v.observed, v.observedLowerBound, v.limit, v.reserve].some(x => x !== null)) return null;
  const result = { version: 1, origin: 'checked-facade-result', observation: 'at-refusal', reason: v.reason,
    resource: rule[0], unit: rule[1], observed: v.observed, observedLowerBound: v.observedLowerBound,
    limit: v.limit, reserve: v.reserve, suggestedAction: rule[2] };
  return Buffer.byteLength(JSON.stringify(result)) <= 2048 ? Object.freeze(result) : null;
}
function rejectionSource(source) {
  if (!source || isProxy(source)) return null;
  const stored = checkedRejections.get(source);
  return stored && member(source, 'code') === 'RESEARCH_RUNTIME_REJECTED'
    && member(source, 'requestId') === stored.requestId && member(source, 'operation') === stored.operation ? stored : null;
}
/** Read-only, fresh scalar projection; no traversal, adoption or grant API. */
export function runtimeRejectionInfo(source) {
  const stored = rejectionSource(source);
  return stored ? { ...stored.value } : null;
}

/** Pure, bounded public projection. Never returns message/stack/cause/details,
 * paths, argv, or coreError/coreResult. Internal errors retain their full causes. */
export function runtimeFailureInfo(error) {
  const requests = member(error, 'requests');
  const failures = Array.isArray(requests) ? requests : member(error, 'errors');
  const result = { ...failureSummary(error), requests: Array.isArray(failures) ? failures.slice(0, 32)
    .filter((entry) => member(entry, 'primary')).map((entry) => ({ primary: failureSummary(member(entry, 'primary')) })) : [] };
  const source = rejectionSource(error);
  if (source && result.code === 'RESEARCH_RUNTIME_REJECTED' && result.requestId === source.requestId && result.operation === source.operation)
    checkedRejections.set(result, source);
  return result;
}
export function runtimeDiagnostics(error) {
  let stored;
  try { stored = error && Object.getOwnPropertyDescriptor(error, 'runtime')?.value; } catch { /* Not a DTO holder. */ }
  const saved = runtimeFailureInfo(stored);
  if (saved.code?.startsWith('RESEARCH_RUNTIME_')) return saved;
  const value = runtimeFailureInfo(error);
  return value.code?.startsWith('RESEARCH_RUNTIME_') ? value : null;
}
async function bound(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fault('CLEANUP_FAILED', 'Cleanup deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
}
const managedDashboardFactories = new WeakSet();
export const supportsManagedDashboardReads = createCore => managedDashboardFactories.has(createCore);

// Composition used by the App entry and the isolated end-to-end fixture.
// The host supplies one dedicated child per App instance. No startup IO.
export function createAppResearchCore(sdk, { packageRoot = ROOT, timeoutMs, cleanupTimeoutMs } = {}) {
  const owner = createManagedReadOwner(sdk);
  const createCore = ({ taskId } = {}) => createResearchRuntime(sdk, { packageRoot, timeoutMs, cleanupTimeoutMs, taskId, managedReadOwner: owner });
  if (process.platform === 'darwin' && process.arch === 'arm64') managedDashboardFactories.add(createCore);
  return Object.freeze({ createCore, dispose: () => owner.dispose() });
}
export function createResearchRuntime(sdk, { packageRoot = ROOT, platform = process.platform, arch = process.arch, timeoutMs = 20000, cleanupTimeoutMs = 3000, taskId, withExclusiveReadScratch, managedReadOwner } = {}) {
  const prepareRead = managedReadOwner === undefined ? null : managedReadOwnerFor(managedReadOwner, sdk);
  const prepareDashboardRead = managedReadOwner === undefined ? null : managedDashboardReadOwnerFor(managedReadOwner, sdk);
  // Internal construction dependency, deliberately absent at the production entry.
  // A trusted host must already own this exact SDK/root for the entire synchronous
  // callback, and supply a fresh symbol for each distinct tenure. Neither the
  // directory's permissions nor the result of calling the provider grants access.
  function inScratchLifetime(data, action, expected) {
    let open = true, used = false, result;
    try {
      if (data !== sdk.dataDir) return;
      withExclusiveReadScratch(sdk, data, tenure => {
        if (!open || used || typeof tenure !== 'symbol' || (expected !== undefined && tenure !== expected)) return;
        used = true;
        result = action(tenure);
      });
      return result;
    } catch { /* Optional evidence or reclamation cannot fail the read. */ }
    finally { open = false; }
  }
  if (taskId !== undefined && (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(taskId))) throw fault('INVALID_REQUEST', 'Invalid trusted task ID');
  if (![timeoutMs, cleanupTimeoutMs].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) throw new TypeError('Invalid timeout');
  let disposed = false;
  const owned = new Set();
  function stamp(s, error, phase = s.phase) {
    error.phase ??= phase;
    if (s.startError) error.startError = s.startError; // Internal receipt, never copied wholesale to the DTO.
    Object.assign(error, { requestId: s.requestId, runtimeId: s.id || null, ...runtimeFields(s.info, 'state'), operation: s.operation, startOutcome: s.startOutcome,
      processTerminalConfirmed: s.terminal === true, cleanup: s.cleanup || { confirmed: false, errors: [] } });
    return error;
  }
  function status(s, info) {
    if (!info || !runtimeIdValue(info.runtimeId) || (s.id && s.id !== info.runtimeId) || !STATES.has(info.state)
      || !matchesPythonRuntime(info, s.launch)) throw fault('INVALID_RESULT', 'Invalid managed runtime status');
    s.id = info.runtimeId;
    // Host get/stop/watch can race. A previously observed terminal receipt is
    // never downgraded by an older ready/stopping receipt for the same ID.
    if (!s.terminal) { s.info = { ...info }; s.terminal = TERMINAL.has(info.state); }
    if (s.error) stamp(s, s.error);
    return s.info;
  }
  function lateCleanup(s) {
    if (!s.cancelled && !s.error) return;
    const current = s.cleanupJob;
    Promise.resolve(current).catch(() => {}).then(() => {
      if (owned.has(s) && !s.cleanup?.confirmed) return cleanup(s);
    }).catch(() => {});
  }
  function rpc(s, method) {
    if (s.rpc[method]) return s.rpc[method];
    const promise = Promise.resolve().then(() => sdk.runtime[method](s.id)).then((info) => {
      const current = status(s, info);
      // A latched terminal start/watch status can mask a stale GET. Require
      // the final GET itself to confirm a clean exit for busy-frame evidence.
      if (s.viewGuard && method === 'get' && s.phase === 'get')
        s.finalGetExited = info.state === 'exited' && info.exitCode === 0 && info.signal == null;
      return current;
    });
    s.rpc[method] = promise; s.pendingRpc.add(promise);
    promise.finally(() => {
      if (s.rpc[method] === promise) s.rpc[method] = null;
      s.pendingRpc.delete(promise);
      if (s.terminal && s.cleanup && !s.cleanupJob) lateCleanup(s);
    }).catch(() => {});
    return promise;
  }
  function acquireWatch(s) {
    if (s.watch && !s.watch.closed) return Promise.resolve(s.watch);
    if (s.watchRequest) return s.watchRequest;
    s.watchPending = true;
    let receivedBody = false;
    const promise = Promise.resolve().then(() => sdk.runtime.watch(s.id)).then((response) => {
      const watch = { body: response?.body, reader: null, decoder: new TextDecoder('utf-8', { fatal: true }), pending: '', total: 0, eof: false };
      if (watch.body) { receivedBody = true; s.readers.add(watch); s.watch = watch; }
      try {
        if (!watch.body?.getReader) throw fault('INVALID_RESULT', 'Invalid watch response');
        watch.reader = watch.body.getReader();
        if (!response.ok) throw fault('INVALID_RESULT', 'Invalid watch response');
        return watch;
      } catch (e) { watch.broken = true; throw e; }
    });
    s.watchRequest = promise; s.pendingRpc.add(promise);
    promise.finally(() => {
      s.watchPending = false; if (s.watchRequest === promise) s.watchRequest = null; s.pendingRpc.delete(promise);
      if (s.cleanup && (receivedBody || !s.cleanupJob && s.terminal)) lateCleanup(s);
    }).catch(() => {});
    return promise;
  }
  function readWatch(s, watch) {
    if (watch.readPromise) return watch.readPromise;
    const promise = Promise.resolve().then(() => watch.reader.read()).then(({ done, value }) => {
      if (value) {
        watch.total += value.byteLength;
        if (watch.total > LIMIT) throw fault('INVALID_RESULT', 'Watch limit exceeded');
        watch.pending += watch.decoder.decode(value, { stream: true });
      }
      if (done) { watch.eof = true; watch.pending += watch.decoder.decode(); }
      const consume = (line) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type !== 'log') { if (typeof event.type !== 'string') throw fault('INVALID_RESULT', 'Invalid event'); status(s, event.runtime); }
      };
      let index;
      while (!s.terminal && (index = watch.pending.indexOf('\n')) >= 0) { consume(watch.pending.slice(0, index)); watch.pending = watch.pending.slice(index + 1); }
      if (done && !s.terminal) { consume(watch.pending); watch.pending = ''; }
    }).catch((e) => { watch.broken = true; throw e; });
    watch.readPromise = promise;
    promise.finally(() => { if (watch.readPromise === promise) watch.readPromise = null; }).catch(() => {});
    return promise;
  }
  async function cancelWatch(s, watch, within) {
    if (!watch.cancelled) {
      await within('cleanup-reader', () => {
        if (watch.cancelled) return;
        if (!watch.cancelPromise) {
          const target = watch.reader || watch.body;
          const pending = Promise.resolve().then(() => target.cancel()).then(() => { watch.cancelled = true; });
          watch.cancelPromise = pending;
          pending.finally(() => { if (watch.cancelPromise === pending) watch.cancelPromise = null; }).catch(() => {});
        }
        return watch.cancelPromise;
      });
    }
    const reading = watch.readPromise;
    if (reading) await within('cleanup-reader', () => reading.catch(() => {}));
    // A failed cancel keeps the reader and its lock for a later explicit retry.
    if (watch.reader) await within('cleanup-reader', () => watch.reader.releaseLock());
    watch.closed = true; s.readers.delete(watch); if (s.watch === watch) s.watch = null;
  }
  function cleanup(s) {
    if (s.cleanupJob) return s.cleanupJob;
    const deadline = Date.now() + cleanupTimeoutMs;
    const errors = [], attemptedReaders = new Set();
    const within = async (phase, action) => {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw fault('CLEANUP_FAILED', 'Cleanup deadline exceeded');
        return await bound(Promise.resolve().then(action), remaining);
      } catch (cause) { throw Object.assign(fault('CLEANUP_FAILED', 'Managed cleanup operation failed', cause), { phase }); }
    };
    const job = (async () => {
      try {
        if (s.preparing) await within('cleanup-start', () => s.prepared);
        if (s.startPending) await within('cleanup-start', () => s.startPromise.catch(() => {}));
        if (s.id && !s.terminal) {
          await within('cleanup-get', () => rpc(s, 'get'));
          if (!s.terminal) await within('cleanup-stop', () => rpc(s, 'stop'));
          if (!s.terminal) {
            if (s.watch && (s.watch.eof || s.watch.broken)) { attemptedReaders.add(s.watch); await cancelWatch(s, s.watch, within); }
            const watch = await within('cleanup-watch', () => acquireWatch(s));
            while (!s.terminal && !watch.eof) await within('cleanup-watch', () => readWatch(s, watch));
            if (!s.terminal) await within('cleanup-get', () => rpc(s, 'get'));
            if (!s.terminal) throw Object.assign(fault('CLEANUP_PENDING', 'Runtime exit remains unconfirmed'), { phase: 'cleanup-watch' });
          }
        }
      } catch (e) { errors.push(e); }
      // A late watch response owns a stream even after the process is terminal.
      const opening = s.watchRequest;
      if (s.watchPending && opening) { try { await within('cleanup-watch', () => opening.catch(() => {})); } catch (e) { errors.push(e); } }
      for (const watch of s.readers) {
        if (attemptedReaders.has(watch)) continue;
        attemptedReaders.add(watch);
        try { await cancelWatch(s, watch, within); } catch (e) { errors.push(e); }
      }
      if (s.pendingRpc.size) { try { await within('cleanup-pending', () => Promise.allSettled([...s.pendingRpc])); } catch (e) { errors.push(e); } }
      const processSettled = s.terminal || ['not-attempted', 'rejected-before-spawn'].includes(s.startOutcome);
      if (!processSettled && !s.id) errors.push(Object.assign(fault('UNKNOWN_START', 'No confirmed runtime identity or pre-spawn rejection'), { phase: 'cleanup-start' }));
      const settled = !s.preparing && !s.startPending && !s.watchPending && !s.pendingRpc.size && !s.readers.size && processSettled;
      if (!settled && !errors.length) errors.push(Object.assign(fault('CLEANUP_PENDING', 'Owned work remains unsettled'), { phase: 'cleanup-pending' }));
      if (settled && !errors.length) {
        try {
          if (s.frame && ['not-attempted', 'rejected-before-spawn'].includes(s.startOutcome))
            await within('cleanup-pending', () => s.frame.abandonBeforeStart());
          else await within('cleanup-marker', () => settleIpc(s));
        } catch (e) { errors.push(e); }
      }
      s.cleanup = { confirmed: settled && !errors.length, errors: errors.slice(0, 16) };
      if (s.cleanup.confirmed) owned.delete(s);
      if (s.error) {
        if (!s.cleanup.confirmed) s.error.indeterminate = true;
        else if (['not-attempted', 'rejected-before-spawn'].includes(s.startOutcome)) s.error.indeterminate = false;
        stamp(s, s.error);
      }
      return s.cleanup;
    })();
    s.cleanupJob = job;
    job.finally(() => { if (s.cleanupJob === job) s.cleanupJob = null; }).catch(() => {});
    return job;
  }
  async function install(frame, projectRead) {
    const launch = pythonLaunch(platform, arch, fault);
    for (const key of ['start', 'get', 'watch', 'stop']) if (typeof sdk?.runtime?.[key] !== 'function') throw fault('MISSING', `Missing runtime.${key}`);
    await ownedRoot(packageRoot);
    const meta = await json(packageRoot, path.join(packageRoot, 'dependencies/runtime.json'), 16384, false, undefined, launch.windows);
    if (meta?.schemaVersion !== 1 || meta.platform !== platform || meta.arch !== arch || meta.pythonVersion !== PYTHON_VERSION
      || meta.executable !== launch.executable) throw fault('UNSUPPORTED', 'Invalid packaged Python metadata');
    // The current frame owner uses Darwin's lock and file-identity contract.
    // Do not switch a branded frame operation to the ordinary JSON transport.
    if (projectRead && launch.windows) throw fault('UNSUPPORTED', 'Windows managed project read ownership is not available');
    const candidate = path.join(packageRoot, launch.executable);
    const executable = launch.windows ? await safe(packageRoot, candidate, 'file', true) : await fs.realpath(candidate);
    const relative = path.relative(packageRoot, executable);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(executable)).isFile()) throw fault('PATH_INVALID', 'Python escaped installation');
    if (!launch.windows) await fs.access(executable, constants.X_OK);
    const entry = await safe(packageRoot, path.join(packageRoot, frame ? 'runtime/research_read_frame.py' : 'runtime/research_entry.py'), 'file', launch.windows);
    if (frame) await safe(packageRoot, path.join(packageRoot, 'runtime/research_entry.py'), 'file', launch.windows);
    await safe(packageRoot, path.join(packageRoot, 'engine/src/hana_math_engine/research.py'), 'file', launch.windows);
    return { executable, entry, launch };
  }
  async function execute(s, request, signal) {
    const race = (p) => Promise.race([p, s.interrupted]);
    const abort = () => s.cancel(fault('CANCELLED', 'Host cancelled research call'));
    let timer, scratchValue, busyError, graphFallbackError;
    s.preparing = true;
    try {
      if (disposed) throw fault('DISPOSED', 'Bridge disposed');
      if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
      timer = setTimeout(() => s.cancel(fault('TIMEOUT', 'Research deadline exceeded')), timeoutMs);
      s.phase = 'installation';
      const { executable, entry, launch } = await race(install(!!s.frameProjectId, s.projectRead));
      s.launch = launch;
      s.phase = 'data-root';
      const data = await race(ownedRoot(sdk.dataDir));
      s.dataRoot = data;
      const rel = path.relative(packageRoot, data), inverse = path.relative(data, packageRoot);
      if (!rel || (launch.windows ? insideRoot(packageRoot, data) || insideRoot(data, packageRoot) : !rel.startsWith('..') || !inverse.startsWith('..')))
        throw fault('PATH_INVALID', 'Install/data overlap');
      // Serialize scan + reservation + directory creation across bridge instances.
      // Do not race this allocation against cancellation: cleanup must see any
      // directory it creates before deciding that no process could write there.
      s.phase = 'request';
      let directory, requestPath, resultPath, args;
      if (s.frameProjectId) {
        const prepareFrame = s.viewGuard ? prepareDashboardRead : prepareRead;
        s.frame = await prepareFrame({ data, projectId: s.frameProjectId, requestId: s.requestId, request,
          reserve: (fresh, use) => reserveIpc(data, s, { fresh, use }), guard: () => { if (s.cancelled) throw s.cancelled; },
          beforeStart: s.viewGuard });
        directory = s.frame.directory; args = s.frame.args;
      } else {
        directory = await reserveIpc(data, s);
        requestPath = path.join(directory, 'request.json'); resultPath = path.join(directory, 'result.json');
        const handle = launch.windows
          ? await openWindowsExclusive(requestPath, created => created ? safe(data, requestPath, 'file', true) : safe(data, directory),
            () => fault('PATH_INVALID', 'Unsafe request file identity'))
          : await fs.open(requestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.writeFile(request);
          if (s.scratchIdentity) {
            const stat = await scratchStat(handle);
            if (stat?.size === BigInt(Buffer.byteLength(request))) s.scratchIdentity['request.json'] = stat;
          }
        } finally { await handle.close(); }
        args = [requestPath, resultPath];
      }
      if (s.cancelled) throw s.cancelled;
      s.preparing = false; s.preparedResolve();
      s.phase = 'start'; s.startPending = true;
      s.startPromise = Promise.resolve().then(async () => {
        if (s.cancelled) throw s.cancelled;
        s.viewGuard?.();
        s.startOutcome = 'unknown';
        let info;
        // Only this precise SDK start rejection is a host guarantee of no spawn.
        // A denial from get/watch/stop or a generic transport error is not one.
        // Only the trusted constructor can bind an App task. No ambient token or
        // extra roots are supplied; Host still validates the task and its scope.
        try { info = await sdk.runtime.start({ runtime: 'command', command: executable, args: ['-I', '-S', '-B', entry, ...args], cwd: directory,
          profile: launch.profile, network: launch.network, ...(taskId === undefined ? {} : { taskId }) }); }
        catch (e) {
          s.startError = e;
          if (e?.code === 'APP_CAPABILITY_DENIED' && e.capability === 'app/runtime.execute' && e.operation === 'runtime.start') s.startOutcome = 'rejected-before-spawn';
          throw e;
        }
        const acknowledged = status(s, info); s.startOutcome = 'acknowledged'; return acknowledged;
      });
      s.startPromise.finally(() => { s.startPending = false; if (s.error) stamp(s, s.error); if (s.cleanup) lateCleanup(s); }).catch(() => {});
      await race(s.startPromise);
      if (!s.terminal) {
        s.phase = 'watch';
        const watch = await race(acquireWatch(s));
        while (!s.terminal && !watch.eof) await race(readWatch(s, watch));
      }
      s.phase = 'get';
      const final = await race(rpc(s, 'get'));
      if (final.state !== 'exited' || final.exitCode !== 0 || final.signal) throw fault('FAILED', 'Research process did not exit successfully');
      s.phase = 'result';
      let envelope;
      if (s.frame) {
        const reading = s.frame.takePublished(); s.pendingRpc.add(reading);
        reading.finally(() => { s.pendingRpc.delete(reading); if (s.cleanup) lateCleanup(s); }).catch(() => {});
        envelope = await race(reading);
      } else {
        envelope = await race(json(s.dataRoot, resultPath, LIMIT, true,
          s.scratchIdentity && (stat => { s.scratchIdentity['result.json'] = stat; }), launch.windows));
      }
      if (envelope?.schemaVersion !== 1 || envelope.requestId !== s.requestId || typeof envelope.ok !== 'boolean') throw fault('INVALID_RESULT', 'Result identity mismatch');
      if (!envelope.ok) {
        const e = fault('REJECTED', envelope.error?.message || 'Research core rejected request');
        e.coreError = envelope.error;
        if (Object.hasOwn(envelope, 'result')) e.coreResult = envelope.result;
        e.indeterminate = envelope.error?.mutationState === 'indeterminate';
        const diagnostic = checkedDiagnostic(member(envelope, 'diagnostic'), member(envelope.error, 'code'), s.operation);
        if (diagnostic && !s.cancelled) checkedRejections.set(e, { requestId: s.requestId, operation: s.operation, value: diagnostic });
        if (s.viewGuard && s.frame && s.finalGetExited && final.signal == null) {
          if (dashboardBusyEnvelope(envelope)) busyError = e;
          else if (dashboardFactgraphFallbackEnvelope(s.operation, envelope)) graphFallbackError = e;
        }
        throw e;
      }
      if (!Object.hasOwn(envelope, 'result')) throw fault('INVALID_RESULT', 'Missing result');
      if (s.cancelled) throw s.cancelled;
      if ((s.scratchIdentity || s.frame) && object(envelope.result)) scratchValue = envelope.result;
      return envelope.result;
    } catch (cause) {
      const e = cause?.code?.startsWith('RESEARCH_RUNTIME_') ? cause : fault(/DENIED|PERMISSION|NOT_GRANTED|EACCES|EPERM/.test(cause?.code || '') ? 'DENIED' : 'FAILED', cause?.message || String(cause), cause);
      e.indeterminate ??= ['acknowledged', 'unknown'].includes(s.startOutcome);
      s.error = stamp(s, e); throw e;
    } finally {
      s.preparing = false; s.preparedResolve();
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const result = await cleanup(s);
      if (s.frame) {
        const settled = !s.cancelled && !signal?.aborted && s.startOutcome === 'acknowledged' && s.terminal && result.confirmed;
        if (settled && scratchValue && !s.error) {
          completedReadScratch.set(s.invocation.promise, { s, value: scratchValue, releaseFrame: s.frame.accept });
        } else if (settled && busyError && s.error === busyError) {
          // Leave the pinned frame waiting for validation; taking evidence
          // alone does not rearm it and never changes the failed outcome.
          completedDashboardBusy.set(s.invocation.promise, { bridge: s.invocation.bridge, operation: s.operation, error: busyError, accept: s.frame.accept });
        } else if (settled && graphFallbackError && s.error === graphFallbackError) {
          completedDashboardGraphFallback.set(s.invocation.promise, { bridge: s.invocation.bridge, operation: s.operation, error: graphFallbackError, accept: s.frame.accept });
        } else s.frame.fence();
      }
      if (!s.error && !result.confirmed) {
        const e = fault('CLEANUP_FAILED', 'Cannot confirm runtime cleanup', result.errors[0]); e.indeterminate = true;
        s.error = stamp(s, e, result.errors[0]?.phase || 'cleanup'); throw e;
      }
      if (scratchValue && !s.error && !s.cancelled && !signal?.aborted && s.startOutcome === 'acknowledged' && s.terminal
        && result.confirmed && s.scratchDirectories && s.scratchIdentity['.complete']?.size === 0n
        && scratchFiles.every(name => scratchFile(s.scratchIdentity[name])) && s.withScratchLifetime(() => true, s.scratchTenure)) {
        completedReadScratch.set(s.invocation.promise, { s, value: scratchValue });
      }
    }
  }
  function call(binding, operation, args = {}, verification, options = {}) {
    const invocation = { bridge, promise: null };
    // Local IPC admission is reached only after async installation/data-root checks.
    invocation.promise = callInternal(invocation, binding, operation, args, verification, options);
    return invocation.promise;
  }
  async function callInternal(invocation, binding, operation, args, verification, options) {
    const requestId = randomUUID();
    let request, view, projectRead;
    try {
      plain(binding); plain(args);
      const hasWorkerId = object(binding) && Object.hasOwn(binding, 'workerId');
      const bindingKeys = hasWorkerId ? 'author,projectId,role,runId,workerId' : 'author,projectId,role,runId';
      if (!object(binding) || Object.keys(binding).sort().join(',') !== bindingKeys || !['projectId', 'runId'].every((k) => typeof binding[k] === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(binding[k])) || typeof binding.author !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(binding.author) || !['main', 'worker', 'verifier'].includes(binding.role) || !OPS.has(operation) || !object(args)) throw fault('INVALID_REQUEST', 'Invalid binding, operation or arguments');
      if (hasWorkerId && (binding.role !== 'worker' || typeof binding.workerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(binding.workerId))) throw fault('INVALID_REQUEST', 'Invalid workerId or non-worker binding');
      if (!object(options) || Object.keys(options).some((k) => k !== 'signal') || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw fault('INVALID_REQUEST', 'Invalid host options');
      view = dashboardViewOptions.get(options);
      if (view && (view.operation !== operation || !prepareDashboardRead)) throw fault('INVALID_REQUEST', 'Dashboard view requires a managed read owner');
      const dashboard = operation === 'dashboard_factgraph' || operation === 'dashboard_memory';
      projectRead = dashboard || (['fact_get', 'fact_list_page'].includes(operation) && taskId !== undefined && binding.role === 'main'
        && (projectScratchOptions.has(options) || CONTROL_ID.test(binding.runId)));
      if (dashboard) {
        const admitted = view || (operation === 'dashboard_factgraph' ? dashboardOptions.has(options) : dashboardMemoryOptions.has(options));
        if (!admitted || !validProjectDashboardReadArguments(operation, args, !!view) || taskId === undefined
          || binding.role !== 'main' || !CONTROL_ID.test(binding.runId))
          throw fault('INVALID_REQUEST', 'Invalid internal dashboard operation');
      } else if (Object.hasOwn(args, 'terminal')) {
        throw fault('INVALID_REQUEST', 'Terminal witness requires an internal dashboard view');
      }
      if (verification !== undefined) {
        plain(verification);
        if (operation !== 'fact_submit' || !object(verification) || Object.keys(verification).sort().join(',') !== 'candidateDigest,predecessorDigests,report,verifierSessionId' || typeof verification.candidateDigest !== 'string' || !/^[a-f0-9]{64}$/.test(verification.candidateDigest) || !object(verification.predecessorDigests) || !Object.entries(verification.predecessorDigests).every(([k, v]) => /^[a-f0-9]{16}$/.test(k) && typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) || typeof verification.verifierSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(verification.verifierSessionId) || !object(verification.report)) throw fault('INVALID_REQUEST', 'Invalid internal verification');
      }
      request = JSON.stringify({ schemaVersion: 1, requestId, operation, context: binding, arguments: args, ...(verification === undefined ? {} : { verification }) });
      if (Buffer.byteLength(request) > LIMIT) throw fault('INVALID_REQUEST', 'Request exceeds 1 MiB');
    } catch (cause) { const e = fault('INVALID_REQUEST', cause.message, cause); Object.assign(e, { requestId, operation: OPS.has(operation) ? operation : null, phase: 'validation', startOutcome: 'not-attempted', processTerminalConfirmed: false, runtimeId: null, indeterminate: false, cleanup: { confirmed: true, errors: [] } }); throw e; }
    let reject, preparedResolve;
    const prepared = new Promise((resolve) => { preparedResolve = resolve; });
    const s = { invocation, requestId, operation, projectRead, phase: 'validation', startOutcome: 'not-attempted', terminal: false, markerHandle: null,
      prepared, preparedResolve, rpc: {}, pendingRpc: new Set(), readers: new Set(), interrupted: new Promise((_, no) => { reject = no; }) };
    if (view) { s.frameProjectId = binding.projectId; s.viewGuard = view.guard; }
    if (projectScratchOptions.has(options) && taskId !== undefined && binding.role === 'main' && ['fact_list_page', 'fact_get'].includes(operation)) {
      if (typeof withExclusiveReadScratch === 'function') s.withScratchLifetime = (action, expected) => inScratchLifetime(s.dataRoot, action, expected);
      else if (prepareRead) s.frameProjectId = binding.projectId;
    }
    s.interrupted.catch(() => {});
    s.cancel = (e) => { if (!s.cancelled) { s.cancelled = e; reject(e); } };
    owned.add(s);
    s.task = execute(s, request, options.signal);
    return s.task;
  }
  async function dispose() {
    disposed = true;
    const states = [...owned];
    const failures = await Promise.all(states.map(async (s) => {
      s.cancel(fault('DISPOSED', 'Bridge disposed'));
      const result = await cleanup(s);
      if (result.confirmed) return null;
      const primary = s.error || s.cancelled;
      primary.indeterminate ??= true; s.error = stamp(s, primary);
      return { requestId: s.requestId, primary: s.error, cleanup: result };
    }));
    if (failures.some(Boolean)) {
      const entries = failures.filter(Boolean);
      throw Object.assign(fault('CLEANUP_FAILED', 'Disposal could not confirm cleanup'), { phase: 'dispose', indeterminate: true,
        cleanup: { confirmed: false, errors: entries.flatMap((entry) => entry.cleanup.errors).slice(0, 16) }, errors: entries });
    }
  }
  const bridge = Object.freeze({ call, dispose });
  return bridge;
}
