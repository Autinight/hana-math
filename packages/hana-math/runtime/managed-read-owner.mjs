// App-instance, in-memory owner only. An occupied path, .complete, permissions,
// or an OS lock never confers ownership. No adoption, recovery, deletion or fallback.
import fs from 'node:fs/promises';
import { constants as C } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const FRAME = 1 << 20, HEAD = 69, STATE = 101, MAGIC = Buffer.from('HMRFRM01');
const FILES = ['state.frame', 'request.frame', 'result.frame'], SIZES = [STATE, FRAME, FRAME];
export const MANAGED_READ_SLOT_BYTES = 2 * FRAME + STATE;
const owners = new WeakMap();
const sha = bytes => createHash('sha256').update(bytes).digest();
const identity = s => `${s.dev}:${s.ino}`;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
const noFollow = C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK;
// Verified by the Darwin O_EXLOCK/flock interoperability fixture. No Linux
// fallback, native addon, subprocess, or process-queue substitute for this lock.
const DARWIN_O_EXLOCK = 32;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const zero = Buffer.alloc(STATE), zeros = Buffer.alloc(FRAME), zeroHash = sha(zeros);
const fault = (code = 'READ_SLOT_FENCED') => Object.assign(new Error('Managed read slot could not be used safely'), { code: `RESEARCH_RUNTIME_${code}` });
const need = (ok, code) => { if (!ok) throw fault(code); };
const ioError = e => fault(['EACCES', 'EPERM', 'ERR_ACCESS_DENIED'].includes(e?.code) ? 'DENIED' : 'READ_SLOT_FENCED');
const uuidBytes = id => Buffer.from(id.replaceAll('-', ''), 'hex');

const WINDOWS_MAGIC = Buffer.from('HMRWIN01'), WINDOWS_HEAD = 68, WINDOWS_RECEIPT = WINDOWS_HEAD + 32;
const READ_OPS = new Set(['fact_get', 'fact_list_page', 'dashboard_factgraph', 'dashboard_memory']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const frameJson = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

// Windows wire gate, deliberately not selected by createManagedReadOwner().
// It grants no filesystem ownership, does not spawn a command, and cannot
// mint Host/Project evidence. The bridge must supply a trusted terminal GET,
// pinned files in a confined one-shot slot, and verify their identity against
// the path/ancestor grant. No Windows admission until those and an identity-
// safe, bounded reclamation protocol are implemented and proved natively.
export function sealWindowsReadFrame({ generation, requestId, projectId, request }) {
  let payload, document;
  try {
    need(typeof request === 'string' && Buffer.byteLength(request) <= FRAME, 'INVALID_REQUEST');
    payload = Buffer.from(request);
    document = frameJson(payload);
  } catch { throw fault('INVALID_REQUEST'); }
  need(Number.isSafeInteger(generation) && generation > 0 && typeof requestId === 'string' && NONCE.test(requestId)
    && typeof projectId === 'string' && ID.test(projectId) && object(document)
    && Object.keys(document).sort().join(',') === 'arguments,context,operation,requestId,schemaVersion'
    && document.schemaVersion === 1 && document.requestId === requestId && READ_OPS.has(document.operation)
    && object(document.arguments) && object(document.context) && document.context.role === 'main'
    && document.context.projectId === projectId, 'INVALID_REQUEST');
  const frame = Buffer.alloc(FRAME); payload.copy(frame);
  const requestDigest = sha(frame);
  let consumed = false;
  return Object.freeze({
    requestFrame: Buffer.from(frame),
    args: Object.freeze([String(generation), requestId, projectId, String(payload.length), requestDigest.toString('hex')]),
    async takePublished({ terminal, files, verifyPinned, guard }) {
      // The expected runtimeId and GET receipt must both be obtained from the
      // same invocation by the trusted bridge, never from disk or a caller.
      need(!consumed); consumed = true;
      try {
        guard();
        need(typeof terminal.runtimeId === 'string' && terminal.runtimeId.length > 0 && terminal.info.runtimeId === terminal.runtimeId
          && terminal.info.state === 'exited' && terminal.info.exitCode === 0 && terminal.info.signal == null, 'INVALID_RESULT');
        const verify = async () => { guard(); need(await verifyPinned()); guard(); };
        const lengths = [FRAME, FRAME, WINDOWS_RECEIPT];
        const handles = [files.request, files.result, files.receipt];
        const stamp = async (fd, length) => {
          const st = await fd.stat({ bigint: true });
          need(st.isFile() && st.ino > 0n && st.nlink === 1n && st.size === BigInt(length));
          return st;
        };
        await verify();
        const stamps = await Promise.all(handles.map((fd, i) => stamp(fd, lengths[i])));
        need(new Set(stamps.map(identity)).size === stamps.length);
        const receipt = await read(files.receipt, WINDOWS_RECEIPT);
        const [actualRequest, result] = await Promise.all([read(files.request, FRAME), read(files.result, FRAME)]);
        const head = receipt.subarray(0, WINDOWS_HEAD), length = head.readUInt32BE(32);
        need(head.subarray(0, 8).equals(WINDOWS_MAGIC) && head.readBigUInt64BE(8) === BigInt(generation)
          && head.subarray(16, 32).equals(uuidBytes(requestId)) && length > 0 && length <= FRAME
          && sha(head).equals(receipt.subarray(WINDOWS_HEAD)) && sha(actualRequest).equals(requestDigest)
          && createHash('sha256').update(requestDigest).update(result).digest().equals(head.subarray(36))
          && !result.subarray(length).some(byte => byte !== 0));
        const envelope = frameJson(result.subarray(0, length));
        need(object(envelope) && envelope.schemaVersion === 1 && envelope.requestId === requestId
          && typeof envelope.ok === 'boolean' && (!envelope.ok || Object.hasOwn(envelope, 'result')));
        await verify();
        for (const [i, fd] of handles.entries()) {
          const before = stamps[i], after = await stamp(fd, lengths[i]);
          need(identity(before) === identity(after) && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs);
        }
        need((await read(files.receipt, WINDOWS_RECEIPT)).equals(receipt));
        await verify();
        return envelope;
      } catch (e) { throw e?.code?.startsWith('RESEARCH_RUNTIME_') ? e : ioError(e); }
    },
  });
}

function state(phase, generation, nonce, length, digest) {
  const out = Buffer.alloc(STATE);
  MAGIC.copy(out); out[8] = phase;
  out.writeBigUInt64BE(BigInt(generation), 9); uuidBytes(nonce).copy(out, 17);
  out.writeUInt32BE(length, 33); digest.copy(out, 37); sha(out.subarray(0, HEAD)).copy(out, HEAD);
  return out;
}
async function read(fd, length) {
  const b = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fd.read(b, offset, length - offset, offset);
    need(bytesRead > 0); offset += bytesRead;
  }
  return b;
}
async function writeVerifiedScratch(fd, value) {
  // This is a transient handoff to the next command, never a durable receipt.
  // Verify visibility on the same pinned handle before exposing PREPARED.
  // A new App process cannot adopt these files, even if they survived a crash.
  const { bytesWritten } = await fd.write(value, 0, value.length, 0);
  need(bytesWritten === value.length && (await read(fd, value.length)).equals(value));
}
async function dirStamp(p) {
  const stat = await fs.lstat(p, { bigint: true }); need(stat.isDirectory()); return stat;
}
function regular(s, size) {
  return s.isFile() && s.nlink === 1n && s.size === BigInt(size) && s.uid === BigInt(process.geteuid()) && (s.mode & 0o7777n) === 0o600n;
}

export function managedReadOwnerFor(owner, sdk) {
  const found = owners.get(owner);
  need(found && found.sdk === sdk, 'INVALID_REQUEST');
  return found.prepare;
}

export function managedDashboardReadOwnerFor(owner, sdk) {
  const found = owners.get(owner);
  need(found && found.sdk === sdk, 'INVALID_REQUEST');
  return found.prepareDashboard;
}

export function createManagedReadOwner(sdk) {
  const factSlots = new Map(), dashboardSlots = new Map();
  let closed = false, closing;
  // Both lanes use the same whole-root IPC budget. Neither can adopt the other
  // lane's slot, and only the trusted runtime chooses which entry to call.
  async function prepare(slots, { data, projectId, requestId, request, reserve, guard, beforeStart }) {
    need(!closed && process.platform === 'darwin' && process.arch === 'arm64', 'UNSUPPORTED');
    need(path.isAbsolute(data) && path.resolve(data) === data && data === sdk.dataDir && ID.test(projectId) && NONCE.test(requestId), 'INVALID_REQUEST');
    const payload = Buffer.from(request);
    need(payload.length > 0 && payload.length <= FRAME, 'INVALID_REQUEST');
    let s = slots.get(projectId);
    const fresh = !s;
    if (fresh) {
      s = { data, generation: 0, previous: [zero, zeroHash, zeroHash], files: [], phase: 'fresh' };
      slots.set(projectId, s);
    }
    need(s.data === data && (s.phase === 'fresh' || s.phase === 'reusable') && s.generation < Number.MAX_SAFE_INTEGER);
    s.phase = 'preparing';
    const live = () => { need(!closed && sdk.dataDir === data); guard(); };
    const preparing = () => { live(); beforeStart?.(); };
    const generation = s.generation + 1;
    const requestFrame = Buffer.alloc(FRAME); payload.copy(requestFrame);
    const prepared = state(1, generation, requestId, payload.length, sha(payload)), requestHash = sha(requestFrame);
    const activity = (async () => {
      // Hold the same in-process admission lane from the whole-root scan
      // through frame preparation. Zero additional charge on reuse. This is
      // not root ownership or an atomic cross-process capacity transaction.
      await reserve(fresh, async root => {
        preparing();
        need(root === path.join(data, 'research', 'core-calls'));
        if (fresh) {
          const parents = [data, path.dirname(root), root];
          s.dirs = await Promise.all(parents.map(async p => [p, await dirStamp(p)]));
          const slotId = randomUUID(); need(slotId !== requestId);
          const directory = path.join(root, slotId);
          preparing(); s.creationAttempted = true;
          await fs.mkdir(directory, { mode: 0o700 }); // EEXIST refuses; never open an existing slot.
          s.directory = directory;
          s.dirs.push([directory, await dirStamp(directory)]);
          await verifyDirs(s);
          for (const [index, name] of FILES.entries()) {
            preparing(); await verifyDirs(s);
            const pathname = path.join(directory, name), fd = await fs.open(pathname, noFollow | C.O_CREAT | C.O_EXCL, 0o600);
            const file = { pathname, fd, size: SIZES[index] };
            s.files.push(file);
            file.stat = await fd.stat({ bigint: true });
            await verifyFile(file, 0); await verifyDirs(s);
            await writeVerifiedScratch(fd, index ? zeros : zero);
            await verifyFile(file);
          }
        }
        await locked(s, preparing, async () => {
          const [control, req, result] = s.files.map(x => x.fd);
          const [priorState, priorRequest, priorResult] = s.previous;
          // Always check the full predecessor, including the padded tails.
          need((await read(control, STATE)).equals(priorState) && sha(await read(req, FRAME)).equals(priorRequest)
            && sha(await read(result, FRAME)).equals(priorResult));
          preparing(); await verify(s);
          // Only the O_EXCL-created handles are used for writes.
          await writeVerifiedScratch(req, requestFrame);
          preparing(); await verify(s);
          need((await read(control, STATE)).equals(priorState));
          await writeVerifiedScratch(control, prepared);
        });
      });
      preparing();
      s.generation = generation;
      s.phase = 'launched';
      const args = Object.freeze([String(generation), requestId, ...s.dirs.map(([, d]) => identity(d)), ...s.files.map(x => identity(x.stat))]);
      return Object.freeze({ directory: s.directory, args,
        async takePublished() {
          need(s.phase === 'launched' && s.generation === generation);
          s.phase = 'reading';
          const reading = locked(s, live, async () => {
            const [control, req, result] = s.files.map(x => x.fd);
            const published = await read(control, STATE), frame = await read(result, FRAME);
            const length = published.readUInt32BE(33);
            need(length > 0 && length <= FRAME);
            const body = frame.subarray(0, length);
            need(published.equals(state(3, generation, requestId, length, sha(body))) && !frame.subarray(length).some(x => x !== 0));
            need(sha(await read(req, FRAME)).equals(requestHash) && (await read(control, STATE)).equals(published));
            const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
            return { envelope, stamp: [published, requestHash, sha(frame)] };
          });
          s.activity = reading;
          try {
            const { envelope, stamp } = await reading;
            live(); need(s.phase === 'reading');
            s.previous = stamp; s.phase = 'waiting-for-validation'; return envelope;
          } catch (e) { s.phase = 'fenced'; throw ioError(e); }
          finally { if (s.activity === reading) s.activity = null; }
        },
        fence() { if (s.generation === generation && s.phase !== 'reusable') s.phase = 'fenced'; },
        async abandonBeforeStart() {
          if (s.generation === generation && ['launched','fenced'].includes(s.phase)) {
            s.phase = 'fenced'; await closeOriginals(s);
          }
        },
        accept() {
          // The runtime hands this only to exact Project/CoreAccess evidence.
          // No IO here: next prepare must revalidate predecessor under OS lock.
          if (closed || sdk.dataDir !== data || s.generation !== generation || s.phase !== 'waiting-for-validation') return false;
          s.phase = 'reusable';
          return true;
        },
      });
    })();
    s.activity = activity;
    try { return await activity; }
    catch (e) {
      s.phase = 'fenced';
      if (fresh && !s.creationAttempted) slots.delete(projectId);
      else {
        // No command can have started: prepare never returned its descriptor.
        // Preserve the first failure, including exact admission evidence. A
        // failed close stays recorded in closeJob; there is no path deletion.
        await closeOriginals(s).catch(() => {});
      }
      throw e?.code?.startsWith('RESEARCH_RUNTIME_') ? e : ioError(e);
    }
    finally { if (s.activity === activity) s.activity = null; }
  }
  function dispose() {
    if (!closing) {
      closed = true;
      closing = Promise.allSettled([...factSlots.values(), ...dashboardSlots.values()].map(async s => {
        await s.activity?.catch(() => {});
        s.phase = 'fenced';
        await closeOriginals(s);
      })).then(results => { need(results.every(r => r.status === 'fulfilled')); });
    }
    return closing;
  }
  const owner = Object.freeze({ dispose });
  owners.set(owner, { sdk, prepare: options => prepare(factSlots, options), prepareDashboard: options => prepare(dashboardSlots, options) });
  return owner;
}
function closeOriginals(s) {
  s.closeJob ??= Promise.allSettled(s.files.map(x => x.fd.close())).then(results => {
    need(results.every(r => r.status === 'fulfilled'));
  });
  return s.closeJob;
}
async function verifyDirs(s) {
  // Directory stamps are pathname snapshots, not open directory handles.
  // A new path/inode never authorizes reuse; the three original FDs stay pinned.
  need(await fs.realpath(s.directory) === s.directory);
  for (const [p, expected] of s.dirs) need(same(await dirStamp(p), expected));
}
async function verifyFile(file, size = file.size, fd = file.fd) {
  for (const st of [await fd.stat({ bigint: true }), await fs.lstat(file.pathname, { bigint: true })])
    need(regular(st, size) && same(st, file.stat));
}
async function verify(s) {
  await verifyDirs(s);
  const names = await fs.readdir(s.directory);
  need(names.length === FILES.length && FILES.every(x => names.includes(x)));
  for (const file of s.files) await verifyFile(file);
}
async function locked(s, guard, work) {
  guard(); await verifyDirs(s);
  const control = s.files[0];
  // Separate open description acquires/releases the lock; use the original
  // handles for all data reads/writes, and match the lock fd to the original inode.
  const lock = await fs.open(control.pathname, noFollow | DARWIN_O_EXLOCK);
  try {
    await verifyFile(control, STATE, lock); await verify(s); guard();
    const value = await work();
    await verifyFile(control, STATE, lock); await verify(s); guard();
    return value;
  } finally { await lock.close(); }
}
