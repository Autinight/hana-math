import * as fs from 'node:fs/promises';
import { constants, lstatSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { types } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const ROLES = ['main', 'worker', 'verifier'];
const DYNAMIC = ['PROBLEM.md', 'OPERATOR.md', 'TASK.md', 'CONTEXT.md', 'PATHS.json'];
const MAX_FILE = 2 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export class ContextError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new ContextError(code, message); }
export function contextId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) fail('INVALID_ID', 'ID must contain 1–64 lowercase letters, digits or hyphens');
  return value;
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\\x00-\x1f:]/.test(value) || path.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) fail('UNSAFE_PATH', 'A canonical package-relative or workspace-relative path is required');
  return value;
}
async function checkedPath(absolute, mkdir = false, root) {
  if (!path.isAbsolute(absolute) || !root) fail('UNSAFE_PATH', 'The root must be an absolute path');
  const boundary = path.resolve(root);
  if (absolute !== boundary && !absolute.startsWith(`${boundary}${path.sep}`)) fail('UNSAFE_PATH', 'The path is outside the authorized root');
  // AppHost grants the package/data roots, not their parents. Inspect only the
  // owned root and descendants; realpath rejects ancestor aliases without probing them.
  const rootStat = await fs.lstat(boundary);
  if (rootStat.isSymbolicLink() || await fs.realpath(boundary) !== boundary) fail('SYMLINK_REFUSED', 'Symlink roots are not allowed');
  if (!rootStat.isDirectory()) fail('UNSAFE_PATH', 'The authorized root is not a directory');
  const parts = path.relative(boundary, absolute).split(path.sep).filter(Boolean);
  let current = boundary;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !mkdir) throw error;
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink()) fail('SYMLINK_REFUSED', 'Symlink paths are not allowed');
    if ((mkdir || i < parts.length - 1) && !stat.isDirectory()) fail('UNSAFE_PATH', 'The parent path is not a directory');
  }
  return absolute;
}
async function withReadFile(absolute, root, read) {
  await checkedPath(absolute, false, root);
  const file = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE) fail('INVALID_FILE', 'The material is not a regular file or exceeds 2 MiB');
    return await read(file);
  } finally { await file.close(); }
}
const readFile = (absolute, root) => withReadFile(absolute, root, file => file.readFile());
function regularIdentity(s) {
  if (!s.isFile() || s.nlink !== 1n || s.size > BigInt(MAX_FILE)) fail('INVALID_FILE', 'Unsafe archival file identity');
  return { size: Number(s.size), identity: [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':') };
}
async function readIdentity(file) { return regularIdentity(await file.stat({ bigint: true })); }
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
// Shared by the probe service. All writes stay below App dataDir; never follows links.
export function createContextStore(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || path.normalize(dataDir) !== dataDir) fail('UNSAFE_PATH', 'dataDir must be a canonical absolute path');
  const absolute = (name) => path.join(dataDir, relative(name));
  return {
    absolute,
    async mkdir(name, exclusive = false) {
      const target = absolute(name);
      if (!exclusive) return checkedPath(target, true, dataDir);
      await checkedPath(path.dirname(target), true, dataDir);
      await fs.mkdir(target); await checkedPath(target, false, dataDir);
      return target;
    },
    async read(name) { return readFile(absolute(name), dataDir); },
    async readWitness(name) {
      return withReadFile(absolute(name), dataDir, async file => {
        const { size, identity } = await readIdentity(file), buffer = Buffer.alloc(size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== size || (await readIdentity(file)).identity !== identity) fail('INVALID_FILE', 'Archival file changed while reading');
        return { bytes: buffer.subarray(0, size), identity };
      });
    },
    // A late stat-only guard for already hash-checked bytes, not an atomic disk snapshot.
    async fileIdentity(name) { return withReadFile(absolute(name), dataDir, async file => (await readIdentity(file)).identity); },
    async readJson(name) { return JSON.parse((await readFile(absolute(name), dataDir)).toString('utf8')); },
    async list(name) { await checkedPath(absolute(name), false, dataDir); return fs.readdir(absolute(name)); },
    async write(name, bytes, replace = false, mode = 0o600) {
      const target = absolute(name); await checkedPath(path.dirname(target), true, dataDir);
      if (!replace) {
        const file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
        try { await file.writeFile(bytes); } finally { await file.close(); }
      } else {
        try { await checkedPath(target, false, dataDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const temporary = `${target}.${randomUUID()}.tmp`;
        const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(bytes); } finally { await file.close(); }
        await checkedPath(path.dirname(target), false, dataDir);
        try { await checkedPath(target, false, dataDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(temporary, target);
      }
    },
    // Existing file only. Caller serializes writes and supplies a synchronous
    // local guard and optional late async authority check. No async boundary
    // between the final local guard and the atomic rename.
    async writeGuarded(name, bytes, { guard, recheck } = {}) {
      if (typeof guard !== 'function' || types.isAsyncFunction(guard) || recheck !== undefined && typeof recheck !== 'function')
        fail('INVALID_INPUT', 'Guarded commit requires a synchronous guard');
      if (Buffer.byteLength(bytes) > MAX_FILE) fail('INVALID_FILE', 'Guarded material exceeds 2 MiB');
      const target = absolute(name), parent = path.dirname(target), temporary = `${target}.${randomUUID()}.tmp`;
      await checkedPath(target, false, dataDir);
      const parentBefore = lstatSync(parent, { bigint: true });
      const parentPinned = () => parentBefore.isDirectory() && realpathSync(parent) === parent
        && sameInode(parentBefore, lstatSync(parent, { bigint: true }));
      const identity = file => regularIdentity(lstatSync(file, { bigint: true })).identity;
      if (!parentPinned()) fail('UNSAFE_PATH', 'Guarded material parent changed');
      const before = identity(target);
      let created, staged, committed = false;
      try {
        const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          created = await file.stat({ bigint: true });
          await file.writeFile(bytes);
          staged = (await readIdentity(file)).identity;
        } finally { await file.close(); }
        await checkedPath(target, false, dataDir);
        await recheck?.();
        if (!parentPinned() || identity(target) !== before || identity(temporary) !== staged) fail('INVALID_FILE', 'Guarded material changed before commit');
        const allowed = guard();
        if (types.isPromise(allowed)) Promise.prototype.then.call(allowed, undefined, () => {});
        if (allowed !== undefined && allowed !== true) fail('INVALID_INPUT', 'Guarded commit was not authorized');
        renameSync(temporary, target);
        committed = true;
      } finally {
        if (created && !committed) {
          // Best effort only for the original private staging file. Preserve the
          // original refusal and never remove another file or a followed path.
          try { if (parentPinned() && sameInode(created, lstatSync(temporary, { bigint: true }))) unlinkSync(temporary); } catch {}
        }
      }
    },
    async remove(name) {
      const target = absolute(name);
      try {
        await checkedPath(path.dirname(target), false, dataDir);
        await checkedPath(target, false, dataDir);
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) fail('SYMLINK_REFUSED', 'Symlink paths are not allowed');
        if (!stat.isFile()) fail('INVALID_FILE', 'Only regular files can be removed');
        await fs.unlink(target);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}
function checkTargets(names) {
  const paths = names.map((name) => relative(name).toLowerCase());
  const set = new Set(paths);
  if (set.size !== paths.length || paths.some((name) => name.split('/').slice(0, -1).some((_, index, parts) => set.has(parts.slice(0, index + 1).join('/'))))) fail('TARGET_CONFLICT', 'Workspace or package target paths conflict');
}
function inputOf(input) {
  if (!object(input) || Object.keys(input).some((key) => !['projectId', 'problem', 'operatorProfile', 'workerTask'].includes(key))) fail('INVALID_INPUT', 'Unknown project preparation field');
  const result = {};
  for (const key of ['problem', 'operatorProfile', 'workerTask']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || Buffer.byteLength(input[key]) > 128 * 1024 || input[key].includes('\0')) fail('INVALID_INPUT', 'The problem, operator profile and task must be nonempty text, each at most 128 KiB');
    result[key] = input[key];
  }
  return result;
}

export function createContextService(sdk, { packageRoot = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  if (!path.isAbsolute(packageRoot)) fail('UNSAFE_PATH', 'packageRoot must be an absolute path');
  packageRoot = path.resolve(packageRoot);
  const store = createContextStore(sdk.dataDir);
  const locks = new Map();
  async function references() {
    const bytes = await readFile(path.join(packageRoot, 'reference-sources.json'), packageRoot);
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 2048 || !object(manifest.roles) || !object(manifest.workspaces) || !Array.isArray(manifest.unavailableCapabilities) || manifest.unavailableCapabilities.some((word) => typeof word !== 'string')) fail('INVALID_REFERENCES', 'Invalid material manifest format');
    checkTargets(manifest.files.map((entry) => entry.target));
    const files = new Map(); let total = 0;
    for (const entry of manifest.files) {
      if (typeof entry.source !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('INVALID_REFERENCES', 'Invalid material source or hash');
      const content = await readFile(path.join(packageRoot, relative(entry.target)), packageRoot);
      total += content.length; if (total > 32 * 1024 * 1024) fail('INVALID_REFERENCES', 'Total material size exceeds 32 MiB');
      if (hash(content) !== entry.sha256) fail('SOURCE_HASH_MISMATCH', 'Packaged material does not match its manifest hash');
      files.set(entry.target, content);
    }
    const markers = {};
    for (const role of ROLES) {
      const definition = manifest.roles[role]; const mapping = manifest.workspaces[role];
      if (!object(definition) || !files.has(definition.contract) || !Array.isArray(definition.skills) || !definition.skills.length || !Array.isArray(mapping) || !mapping.length) fail('INVALID_REFERENCES', 'Each role requires a contract, skills and workspace mappings');
      checkTargets([...mapping.map((entry) => entry.to), ...DYNAMIC, 'READ-PROBE-NONCE.txt']);
      for (const entry of mapping) {
        if (!files.has(entry.from)) fail('INVALID_REFERENCES', 'The mapping is not registered in the source manifest');
        relative(entry.to);
        if (['shared', 'fact_graph', 'global_memory', 'local_memory'].includes(entry.to.split('/')[0].toLowerCase())) fail('TARGET_CONFLICT', 'Static material cannot be copied as shared or private runtime state');
      }
      if (!mapping.some((entry) => entry.to === 'AGENTS.md' && entry.from === definition.contract)) fail('INVALID_REFERENCES', 'The role AGENTS.md must match its role contract');
      for (const skill of definition.skills) {
        if (typeof skill.name !== 'string' || !skill.name || !files.has(`${relative(skill.path)}/SKILL.md`) || !mapping.some((entry) => entry.from === `${skill.path}/SKILL.md`)) fail('INVALID_REFERENCES', 'Role skills must declare and map their verbatim SKILL.md');
      }
      markers[role] = files.get(definition.contract).toString('utf8').split(/\r?\n/).find((line) => /^#\s+\S/.test(line));
      if (!markers[role]) fail('INVALID_REFERENCES', 'Contracts need distinct level-one headings for read-chain diagnostics');
    }
    if (new Set(Object.values(markers)).size !== ROLES.length) fail('INVALID_REFERENCES', 'Role contract headings must differ');
    return { manifest, files, sha256: hash(bytes), markers };
  }
  const projectBase = (id) => `context/projects/${contextId(id)}`;
  function dynamic(id, role, cwd, input) {
    const shared = store.absolute(`${projectBase(id)}/shared`);
    const paths = {
      schemaVersion: 1, projectId: id, role, cwd,
      shared: { root: shared, factGraph: path.join(shared, 'fact_graph'), globalMemory: path.join(shared, 'global_memory') },
      aliases: { 'fact_graph/': path.join(shared, 'fact_graph'), 'global_memory/': path.join(shared, 'global_memory'), 'runtime/projects/<p>/fact_graph/': path.join(shared, 'fact_graph'), 'runtime/projects/<p>/global_memory/': path.join(shared, 'global_memory') },
      localMemory: role === 'worker' ? path.join(cwd, 'local_memory') : null,
    };
    return {
      'PROBLEM.md': input.problem,
      'OPERATOR.md': input.operatorProfile,
      'TASK.md': input.workerTask,
      'PATHS.json': json(paths),
      'CONTEXT.md': `# Hana Math context\n\nProject: ${id}\nRole: ${role}\n\nHana context adapter: PROBLEM.md, OPERATOR.md and TASK.md are dynamic inputs for this project; original contracts and skills remain verbatim. Legacy relative shared paths must map through PATHS.json to the single canonical directory, with no local fact copies or external symlinks. Material itself is not verified fact.\n\nThe CP2A adapter only diagnoses material reading; it does not execute research loops, proofs, fact submissions, MCP, commands or mathematical experiments. Legacy CLI references and dynamic placeholders in prompts do not imply implemented capabilities. Directory separation is not OS file-access isolation.\n`,
    };
  }
  async function layout(id, input, ref, base, role) {
    const result = [];
    for (const entry of ref.manifest.workspaces[role]) result.push({ path: entry.to, content: ref.files.get(entry.from), source: entry.from, kind: entry.to === 'AGENTS.md' ? 'contract' : 'static' });
    for (const [name, content] of Object.entries(dynamic(id, role, store.absolute(base), input))) result.push({ path: name, content: Buffer.from(content), kind: 'dynamic' });
    return result;
  }
  async function noInheritedContract(base) {
    let current = path.dirname(store.absolute(base));
    const boundary = sdk.dataDir;
    while (current === boundary || current.startsWith(`${boundary}${path.sep}`)) {
      try { await fs.lstat(path.join(current, 'AGENTS.md')); fail('INHERITED_CONTRACT', 'Role workspace ancestors must not contain AGENTS.md'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current === boundary) break;
      current = path.dirname(current);
    }
  }
  async function inspect(projectId) {
    const id = contextId(projectId); const base = projectBase(id); const issues = [];
    let meta, input, ref;
    try {
      meta = await store.readJson(`${base}/project.json`);
      if (meta.schemaVersion !== 1 || meta.projectId !== id || meta.state !== 'ready') fail('INCOMPLETE', 'Project creation is incomplete');
      input = inputOf(await store.readJson(`${base}/request.json`));
      if (hash(json(input)) !== meta.inputSha256) fail('INPUT_HASH_MISMATCH', 'The dynamic-input archive is corrupted');
      ref = await references();
      if (ref.sha256 !== meta.referenceSha256) fail('REFERENCE_CHANGED', 'Packaged material differs from the assembled project version');
    } catch (error) { return { projectId: id, state: error.code === 'ENOENT' ? 'missing' : error.code === 'INCOMPLETE' ? 'incomplete' : 'invalid', issues: [{ code: error.code || 'INVALID_PROJECT' }] }; }
    const roles = {};
    for (const role of ROLES) {
      const cwd = `${base}/roles/${role}`; roles[role] = { cwd: store.absolute(cwd), files: [] };
      try {
        await noInheritedContract(cwd); await checkedPath(store.absolute(cwd), false, sdk.dataDir);
        if (role === 'worker') {
          const local = store.absolute(`${cwd}/local_memory`);
          await checkedPath(local, false, sdk.dataDir);
          if (!(await fs.lstat(local)).isDirectory()) fail('INVALID_LOCAL_MEMORY', 'The worker private-notes path must be a regular directory');
        }
        for (const file of await layout(id, input, ref, cwd, role)) {
          const sha256 = hash(file.content);
          roles[role].files.push({ path: file.path, sha256, kind: file.kind });
          try { if (hash(await store.read(`${cwd}/${file.path}`)) !== sha256) fail('FILE_HASH_MISMATCH', 'Material hash mismatch'); }
          catch (error) { issues.push({ role, path: file.path, code: error.code || 'INVALID_FILE' }); }
        }
      } catch (error) { issues.push({ role, code: error.code || 'INVALID_WORKSPACE' }); }
    }
    for (const name of ['shared', 'shared/fact_graph', 'shared/fact_graph/facts', 'shared/global_memory']) {
      try { const target = store.absolute(`${base}/${name}`); await checkedPath(target, false, sdk.dataDir); if (!(await fs.lstat(target)).isDirectory()) fail('INVALID_SHARED', 'The shared root is not a directory'); }
      catch (error) { issues.push({ path: name, code: error.code || 'INVALID_SHARED' }); }
    }
    return { projectId: id, state: issues.length ? 'invalid' : 'ready', roles, shared: JSON.parse(dynamic(id, 'main', roles.main.cwd, input)['PATHS.json']).shared, issues, unavailableCapabilities: ref.manifest.unavailableCapabilities };
  }
  async function prepare(input) {
    const payload = inputOf(input); const id = input.projectId === undefined ? `project-${randomUUID()}` : contextId(input.projectId);
    const key = hash(json(payload)); const base = projectBase(id);
    if (locks.has(id)) { await locks.get(id); return prepare({ ...input, projectId: id }); }
    const work = (async () => {
      const ref = await references();
      try { await store.mkdir(base, true); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await store.readJson(`${base}/project.json`).catch((error) => { if (error.code === 'ENOENT') fail('INCOMPLETE', 'Project creation was interrupted'); throw error; });
        if (existing.inputSha256 !== key) fail('PROJECT_CONFLICT', 'Inputs differ for the same projectId; overwrite refused');
        const result = await inspect(id);
        if (result.state !== 'ready') fail('INCOMPLETE', 'The existing project failed integrity checks; no overwrite');
        return { ...result, reused: true };
      }
      const meta = { schemaVersion: 1, projectId: id, state: 'preparing', inputSha256: key, referenceSha256: ref.sha256 };
      await store.write(`${base}/project.json`, json(meta));
      await store.write(`${base}/request.json`, json(payload));
      for (const dir of ['shared/fact_graph/facts', 'shared/global_memory']) await store.mkdir(`${base}/${dir}`);
      for (const role of ROLES) {
        const cwd = `${base}/roles/${role}`; await store.mkdir(cwd); await noInheritedContract(cwd);
        if (role === 'worker') await store.mkdir(`${cwd}/local_memory`, true);
        for (const file of await layout(id, payload, ref, cwd, role)) await store.write(`${cwd}/${file.path}`, file.content);
      }
      await store.write(`${base}/project.json`, json({ ...meta, state: 'ready' }), true);
      const result = await inspect(id);
      if (result.state !== 'ready') fail('INCOMPLETE', 'Post-assembly integrity check failed');
      return { ...result, reused: false };
    })();
    locks.set(id, work); try { return await work; } finally { locks.delete(id); }
  }
  async function prepareProbe({ projectId, role } = {}) {
    const id = contextId(projectId);
    if (!ROLES.includes(role)) fail('INVALID_ROLE', 'Unknown role');
    const project = await inspect(id);
    if (project.state !== 'ready') fail('PROJECT_NOT_READY', 'Project material has not passed integrity checks');
    const ref = await references(); const input = inputOf(await store.readJson(`${projectBase(id)}/request.json`));
    const probeId = `probe-${randomUUID()}`; const base = `${projectBase(id)}/probes/${probeId}/${role}`;
    await store.mkdir(base, true); await noInheritedContract(base);
    const receipt = `${projectBase(id)}/probes/${probeId}/probe.json`;
    const meta = { schemaVersion: 1, probeId, projectId: id, role, state: 'preparing', referenceSha256: ref.sha256 };
    await store.write(receipt, json(meta));
    if (role === 'worker') await store.mkdir(`${base}/local_memory`, true);
    const expectedNonce = randomUUID(); const files = [];
    const material = await layout(id, input, ref, base, role);
    material.push({ path: 'READ-PROBE-NONCE.txt', content: Buffer.from(expectedNonce), kind: 'nonce' });
    for (const file of material) {
      await store.write(`${base}/${file.path}`, file.content);
      files.push({ path: store.absolute(`${base}/${file.path}`), relativePath: file.path, sha256: hash(file.content), kind: file.kind, ...(file.source ? { source: file.source } : {}) });
    }
    const definition = ref.manifest.roles[role];
    const skill = files.find((file) => file.source === `${definition.skills[0].path}/SKILL.md`);
    const commonFiles = files.filter((file) => file.kind === 'static' && !file.source?.endsWith('/SKILL.md') && !Object.values(ref.manifest.roles).some((entry) => entry.contract === file.source) && !definition.skills.some((entry) => file.source?.startsWith(`${entry.path}/`)));
    const common = commonFiles.find((file) => path.basename(file.path) === 'ARCHITECTURE.md') || commonFiles[0];
    if (!skill || !common) fail('INVALID_REFERENCES', 'The diagnostic must include a skill and a common reference');
    const glossary = 'danus/core/glossary_global.json';
    if (!files.some((file) => file.relativePath === glossary && file.kind === 'static')) fail('INVALID_REFERENCES', 'The diagnostic lacks the mapped verbatim global glossary');
    const requiredReadPaths = [...new Set(['AGENTS.md', 'PROBLEM.md', 'OPERATOR.md', 'TASK.md', 'CONTEXT.md', 'PATHS.json', glossary, skill.relativePath, common.relativePath, 'READ-PROBE-NONCE.txt'])].map((file) => store.absolute(`${base}/${file}`));
    for (const file of files) if (hash(await store.read(`${base}/${file.relativePath}`)) !== file.sha256) fail('FILE_HASH_MISMATCH', 'Diagnostic file verification failed after writing');
    await store.write(receipt, json({ ...meta, state: 'ready', files, requiredReadPaths }), true);
    return { probeId, projectId: id, role, state: 'ready', cwd: store.absolute(base), files, requiredReadPaths, expectedNonce, contractMarkers: ref.markers };
  }
  async function checkRoleAncestors(base) {
    const cwd = store.absolute(base);
    await noInheritedContract(base);
    let parent = path.dirname(cwd);
    while (parent === sdk.dataDir || parent.startsWith(`${sdk.dataDir}${path.sep}`)) {
      try {
        const agents = await fs.lstat(path.join(parent, '.agents'));
        if (agents.isSymbolicLink()) fail('SYMLINK_REFUSED', 'An ancestor .agents must not be a symlink');
        if (agents.isDirectory()) { await fs.lstat(path.join(parent, '.agents', 'skills')); fail('INHERITED_SKILLS', 'Research workspace ancestors must not contain auto-discovered .agents/skills'); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (parent === sdk.dataDir) break;
      parent = path.dirname(parent);
    }
  }
  async function prepareResearchWorkspace(options = {}) {
    if (!object(options) || Object.keys(options).some((key) => !['projectId', 'runId', 'role', 'verificationId'].includes(key))) fail('INVALID_INPUT', 'Unknown research workspace field');
    const { role } = options;
    const projectId = contextId(options.projectId); const runId = contextId(options.runId);
    if (!ROLES.includes(role)) fail('INVALID_ROLE', 'Research execution allows only main, worker or verifier');
    if (role !== 'verifier' && options.verificationId !== undefined) fail('INVALID_INPUT', 'Only verifier accepts verificationId');
    const verificationId = role === 'verifier' ? contextId(options.verificationId) : null;
    const project = await inspect(projectId);
    if (project.state !== 'ready') fail('PROJECT_NOT_READY', 'Project material has not passed integrity checks');
    const ref = await references();
    const meta = await store.readJson(`${projectBase(projectId)}/project.json`);
    const input = inputOf(await store.readJson(`${projectBase(projectId)}/request.json`));
    if (meta.referenceSha256 !== ref.sha256 || meta.inputSha256 !== hash(json(input))) fail('PROJECT_CHANGED', 'Project material changed after inspection');
    const base = `${projectBase(projectId)}/research/${runId}/${role === 'verifier' ? `verifiers/${verificationId}` : role}`;
    const cwd = store.absolute(base);
    const checkResearchAncestors = () => checkRoleAncestors(base);
    await store.mkdir(path.posix.dirname(base));
    await checkResearchAncestors();
    const excludedPaths = [];
    const material = (await layout(projectId, input, ref, base, role)).filter((file) => {
      const name = file.path.toLowerCase();
      if (name === 'agents.md' || name === '.agents/skills' || name.startsWith('.agents/skills/')
        || role === 'verifier' && ['problem.md', 'operator.md', 'task.md'].includes(name)) { excludedPaths.push(file.path); return false; }
      if (role === 'verifier' && file.kind !== 'dynamic') {
        const verifySkills = ['check-referenced-statements', 'synthesize-verification-report', 'verify-sequential-statements'];
        const allowed = file.source === ref.manifest.roles.verifier.contract
          || file.path === 'danus/core/glossary_global.json' || file.path === 'LICENSE'
          || verifySkills.some((skill) => file.path.startsWith(`agents/skills/verify/${skill}/`)
            && file.source === `references/danus/${file.path}`);
        if (!allowed) { excludedPaths.push(file.path); return false; }
      }
      return true;
    });
    const paths = JSON.parse(material.find((file) => file.path === 'PATHS.json').content.toString('utf8'));
    paths.runId = runId; paths.verificationId = verificationId;
    if (role === 'verifier') {
      const factGraph = paths.shared.factGraph;
      paths.shared = { factGraph };
      paths.aliases = { 'fact_graph/': factGraph, 'runtime/projects/<p>/fact_graph/': factGraph };
      paths.localMemory = null;
    }
    material.find((file) => file.path === 'PATHS.json').content = Buffer.from(json(paths));
    material.find((file) => file.path === 'CONTEXT.md').content = Buffer.from(`# Hana Math CP2B research context\n\nProject: ${projectId}\nRun: ${runId}\nRole: ${role}\n${verificationId ? `Verification: ${verificationId}\n` : ''}\nHana bounded-run adapter, not a replacement role contract. This workspace does not inject AGENTS.md or register .agents/skills; the saved role instance supplies its persona and Skills.\n\nPROBLEM.md, OPERATOR.md and TASK.md contain the current inputs. PATHS.json identifies the canonical shared fact/global-memory root and any run-local memory.\n${role === 'worker' ? 'Use math_local_memory for this run private notes; this workspace is reused across worker turns.' : role === 'main' ? 'One planning turn uses math_assign, followed later by one result-summary turn in this workspace. No private-notes directory is assigned to main; this is not persistent main control.' : 'Use math_verification_report for the report; the coordinator supplies Statement/Proof and binds the report path. No private-notes directory is assigned to verifier.'}\n\nMathematics is text-only; do not run computation or experiments. Turn completion is not fact acceptance. Directory separation is not OS file isolation.\n`);
    if (role === 'verifier') material.find((file) => file.path === 'CONTEXT.md').content = Buffer.from(`# Hana Math CP2B verifier context\n\nProject: ${projectId}\nRun: ${runId}\nRole: verifier\nVerification: ${verificationId}\n\nHana bounded-run adapter: the coordinator supplies the candidate Statement/Proof. PATHS.json identifies the canonical fact graph. Use math_verification_report for the report at the coordinator-bound location.\n\nMathematics is text-only; do not run computation or experiments. This input layout does not provide OS file isolation.\n`);
    checkTargets([...material.map((file) => file.path), 'research-workspace.json']);
    try { await store.mkdir(base, true); }
    catch (error) { if (error.code === 'EEXIST') fail('RESEARCH_WORKSPACE_CONFLICT', 'The research workspace already exists; existing content and interrupted artifacts will not be overwritten'); throw error; }
    const receipt = { schemaVersion: 1, projectId, runId, role, verificationId, cwd, shared: paths.shared, localMemory: paths.localMemory, state: 'preparing', referenceSha256: ref.sha256, excludedPaths };
    await store.write(`${base}/research-workspace.json`, json(receipt));
    if (role === 'worker') await store.mkdir(`${base}/local_memory`, true);
    const files = [];
    for (const file of material) {
      // Set the initial mode on exclusive creation: fchmod is unavailable under
      // Node's filesystem permission model, even with data-root write grants.
      await store.write(`${base}/${file.path}`, file.content, false, file.kind === 'dynamic' ? 0o600 : 0o400);
      const sha256 = hash(file.content);
      if (hash(await store.read(`${base}/${file.path}`)) !== sha256) fail('FILE_HASH_MISMATCH', 'Research material verification failed after writing');
      files.push({ path: file.path, sha256, kind: file.kind, ...(file.source ? { source: file.source } : {}) });
    }
    await checkResearchAncestors();
    const result = { ...receipt, state: 'ready', files };
    await store.write(`${base}/research-workspace.json`, json(result), true);
    return result;
  }
  function projectWorkspaceIdentity(options) {
    if (!object(options) || Object.keys(options).some(key => !['projectId', 'role', 'workerId'].includes(key))) fail('INVALID_INPUT', 'Unknown project workspace field');
    const projectId = contextId(options.projectId), role = options.role;
    if (!['main', 'worker'].includes(role)) fail('INVALID_ROLE', 'Project workspaces allow only main or worker');
    if (role === 'main' && Object.hasOwn(options, 'workerId')) fail('INVALID_INPUT', 'Main does not accept workerId');
    const workerId = role === 'worker' ? contextId(options.workerId) : undefined;
    const base = `${projectBase(projectId)}/${role === 'main' ? 'main' : `workers/${workerId}`}`;
    return { projectId, role, ...(role === 'worker' ? { workerId } : {}), base };
  }
  async function projectWorkspaceMaterial(identity) {
    const { projectId, role, workerId, base } = identity;
    if ((await inspect(projectId)).state !== 'ready') fail('PROJECT_NOT_READY', 'Project material has not passed integrity checks');
    const ref = await references(), meta = await store.readJson(`${projectBase(projectId)}/project.json`);
    const input = inputOf(await store.readJson(`${projectBase(projectId)}/request.json`));
    if (meta.referenceSha256 !== ref.sha256 || meta.inputSha256 !== hash(json(input))) fail('PROJECT_CHANGED', 'Project material changed after inspection');
    const scope = role === 'main' ? 'project-main' : 'logical-worker', cwd = store.absolute(base), excludedPaths = [];
    const material = (await layout(projectId, input, ref, base, role)).filter(file => {
      const name = file.path.toLowerCase();
      if (name === 'agents.md' || name === '.agents/skills' || name.startsWith('.agents/skills/') || role === 'main' && name === 'task.md') {
        excludedPaths.push(file.path); return false;
      }
      return true;
    });
    const paths = JSON.parse(material.find(file => file.path === 'PATHS.json').content.toString('utf8'));
    Object.assign(paths, { scope, verificationId: null, ...(role === 'worker' ? { workerId } : {}) });
    material.find(file => file.path === 'PATHS.json').content = Buffer.from(json(paths));
    material.find(file => file.path === 'CONTEXT.md').content = Buffer.from(`# Hana Math project workspace\n\nPROBLEM.md and OPERATOR.md hold project inputs. PATHS.json maps the canonical project shared stores. This workspace persists across executions; saved role persona and Skills are not reinjected here.\n\n${role === 'worker' ? 'TASK.md is this logical worker\'s current assignment. local_memory persists for this worker; use math_local_memory for private notes.' : 'This is the project main workspace, with no worker task or private-memory directory.'}\n\nDirectory separation is not OS file isolation.\n`);
    checkTargets([...material.map(file => file.path), 'project-workspace.json']);
    const receipt = { schemaVersion: 1, scope, projectId, role, ...(role === 'worker' ? { workerId } : {}), verificationId: null,
      cwd, shared: paths.shared, localMemory: paths.localMemory, referenceSha256: ref.sha256, excludedPaths };
    return { material, receipt };
  }
  async function checkProjectWorkspacePaths(identity, existing = false) {
    const { base, role } = identity;
    try { await checkedPath(store.absolute(base), false, sdk.dataDir); }
    catch (error) { if (existing || error.code !== 'ENOENT') throw error; }
    await checkRoleAncestors(base);
    for (const name of ['AGENTS.md', '.agents/skills', ...(role === 'main' ? ['TASK.md', 'local_memory'] : [])]) {
      try { await fs.lstat(store.absolute(`${base}/${name}`)); fail('WORKSPACE_MISMATCH', 'Unexpected injected role material or main worker state'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { if ((await fs.lstat(store.absolute(`${base}/.agents`))).isSymbolicLink()) fail('SYMLINK_REFUSED', 'Workspace .agents must not be a symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && role === 'worker') {
      const memory = await checkedPath(store.absolute(`${base}/local_memory`), false, sdk.dataDir);
      if (!(await fs.lstat(memory)).isDirectory()) fail('WORKSPACE_MISMATCH', 'Worker local memory must be a directory');
    }
  }
  async function validateProjectWorkspace(identity, expected) {
    await checkProjectWorkspacePaths(identity, true);
    const receipt = await store.readJson(`${identity.base}/project-workspace.json`);
    if (!object(receipt) || Object.keys(receipt).some(key => ![...Object.keys(expected.receipt), 'files', 'state'].includes(key)) || receipt.state !== 'ready' || Object.hasOwn(receipt, 'runId')
      || identity.role === 'main' && Object.hasOwn(receipt, 'workerId')) fail('WORKSPACE_MISMATCH', 'A ready project workspace is required');
    for (const [key, value] of Object.entries(expected.receipt)) {
      if (json(receipt[key]) !== json(value)) fail('WORKSPACE_MISMATCH', 'Project workspace identity or references changed');
    }
    if (!Array.isArray(receipt.files) || receipt.files.length !== expected.material.length) fail('WORKSPACE_MISMATCH', 'Project workspace file inventory changed');
    for (const [index, file] of expected.material.entries()) {
      const recorded = receipt.files[index];
      if (!object(recorded) || recorded.path !== file.path || recorded.kind !== file.kind || recorded.source !== file.source) fail('WORKSPACE_MISMATCH', 'Project workspace file identity changed');
      const bytes = await store.read(`${identity.base}/${file.path}`);
      if (recorded.sha256 !== hash(bytes)) fail('FILE_HASH_MISMATCH', 'Project workspace file does not match its receipt');
      if (identity.role === 'worker' && file.path === 'TASK.md') {
        if (!bytes.toString('utf8').trim() || bytes.includes(0) || bytes.length > 128 * 1024 + 1) fail('INVALID_INPUT', 'Stored worker task is invalid');
      } else if (recorded.sha256 !== hash(file.content)) fail('FILE_HASH_MISMATCH', 'Project workspace material changed');
    }
    return receipt;
  }
  async function prepareProjectWorkspace(options = {}) {
    const identity = projectWorkspaceIdentity(options), { base, role } = identity;
    if (locks.has(base)) { await locks.get(base); return prepareProjectWorkspace(options); }
    const work = (async () => {
      const expected = await projectWorkspaceMaterial(identity);
      await store.mkdir(path.posix.dirname(base)); await checkProjectWorkspacePaths(identity);
      try { await store.mkdir(base, true); }
      catch (error) { if (error.code === 'EEXIST') return validateProjectWorkspace(identity, expected); throw error; }
      const receiptFile = `${base}/project-workspace.json`;
      await store.write(receiptFile, json({ ...expected.receipt, state: 'preparing' }));
      if (role === 'worker') await store.mkdir(`${base}/local_memory`, true);
      const files = [];
      for (const file of expected.material) {
        await store.write(`${base}/${file.path}`, file.content, false, file.kind === 'dynamic' ? 0o600 : 0o400);
        const sha256 = hash(file.content);
        if (hash(await store.read(`${base}/${file.path}`)) !== sha256) fail('FILE_HASH_MISMATCH', 'Project material readback failed');
        files.push({ path: file.path, sha256, kind: file.kind, ...(file.source ? { source: file.source } : {}) });
      }
      await checkProjectWorkspacePaths(identity, true);
      const result = { ...expected.receipt, files, state: 'ready' };
      await store.write(receiptFile, json(result), true);
      return result;
    })();
    locks.set(base, work); try { return await work; } finally { locks.delete(base); }
  }
  async function assignWorkerTask(input, options = {}) {
    if (!object(options) || Object.keys(options).some(key => key !== 'assertAdmission')
      || options.assertAdmission !== undefined && typeof options.assertAdmission !== 'function') fail('INVALID_INPUT', 'Invalid trusted assignment options');
    if (!object(input) || Object.keys(input).some(key => !['projectId', 'workerId', 'task'].includes(key))) fail('INVALID_INPUT', 'Only projectId, workerId and task are accepted');
    const { task } = input;
    if (typeof task !== 'string' || !task.trim() || task.includes('\0') || Buffer.byteLength(task) > 128 * 1024) fail('INVALID_INPUT', 'Task must be nonempty text, at most 128 KiB');
    const identity = projectWorkspaceIdentity({ projectId: input.projectId, workerId: input.workerId, role: 'worker' }), { base, projectId, workerId } = identity;
    if (locks.has(base)) { await locks.get(base); return assignWorkerTask(input, options); }
    const work = (async () => {
      const receipt = await validateProjectWorkspace(identity, await projectWorkspaceMaterial(identity));
      const sha256 = await replaceWorkspaceTask(base, 'project-workspace.json', receipt, task, options.assertAdmission);
      return { state: 'ready', projectId, workerId, taskFile: `${base}/TASK.md`, sha256 };
    })();
    locks.set(base, work); try { return await work; } finally { locks.delete(base); }
  }
  async function replaceWorkspaceTask(base, receiptName, receipt, task, assertAdmission) {
    const taskFile = `${base}/TASK.md`, receiptFile = `${base}/${receiptName}`;
    const entries = receipt.files.filter(file => file.path === 'TASK.md');
    if (entries.length !== 1 || entries[0].kind !== 'dynamic' || entries[0].sha256 !== hash(await store.read(taskFile))) fail('FILE_HASH_MISMATCH', 'Worker task receipt does not match its file');
    // Last synchronous admission boundary. Once the preparing write is issued,
    // finish this atomic TASK/receipt commit even if the Goal is paused afterward.
    if (assertAdmission) {
      const admitted = assertAdmission();
      if (admitted !== undefined && admitted !== true) fail('INVALID_INPUT', 'Admission guard must return synchronously');
    }
    await store.write(receiptFile, json({ ...receipt, state: 'preparing' }), true);
    const content = Buffer.from(task.endsWith('\n') ? task : `${task}\n`), sha256 = hash(content);
    await store.write(taskFile, content, true);
    if (hash(await store.read(taskFile)) !== sha256) fail('FILE_HASH_MISMATCH', 'Assigned task readback failed');
    entries[0].sha256 = sha256;
    await store.write(receiptFile, json({ ...receipt, state: 'ready' }), true);
    return sha256;
  }
  async function assignResearchTask(input) {
    if (!object(input) || Object.keys(input).some(key => !['projectId', 'runId', 'task'].includes(key))) fail('INVALID_INPUT', 'Only projectId, runId and task are accepted');
    const projectId = contextId(input.projectId), runId = contextId(input.runId), task = input.task;
    if (typeof task !== 'string' || !task.trim() || task.includes('\0') || Buffer.byteLength(task) > 128 * 1024) fail('INVALID_INPUT', 'Task must be nonempty text, at most 128 KiB');
    const base = `context/projects/${projectId}/research/${runId}/worker`, taskFile = `${base}/TASK.md`, receiptFile = `${base}/research-workspace.json`;
    if (locks.has(base)) { await locks.get(base); return assignResearchTask(input); }
    const work = (async () => {
      const receipt = await store.readJson(receiptFile);
      if (receipt.schemaVersion !== 1 || receipt.state !== 'ready' || receipt.projectId !== projectId || receipt.runId !== runId || receipt.role !== 'worker' || receipt.verificationId !== null
        || receipt.cwd !== store.absolute(base) || !Array.isArray(receipt.files)) fail('WORKSPACE_MISMATCH', 'A ready worker workspace for this run is required');
      const sha256 = await replaceWorkspaceTask(base, 'research-workspace.json', receipt, task);
      return { state: 'ready', projectId, runId, taskFile, sha256 };
    })();
    locks.set(base, work); try { return await work; } finally { locks.delete(base); }
  }
  return { prepare, inspect, prepareProbe, prepareResearchWorkspace, assignResearchTask, prepareProjectWorkspace, assignWorkerTask };
}
