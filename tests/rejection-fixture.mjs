// Isolated software Host protocol: placeholder executable is never executed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createResearchRuntime } from '../packages/hana-math/runtime/research-runtime.mjs';
export const refusalDiagnostic = (reason = 'response-bytes', patch = {}) => ({ version: 1, reason, observed: 1048577, observedLowerBound: false, limit: 1048576, reserve: 0, ...patch });
export async function refusalFixture(t, hooks = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'refusal-protocol-'))), packageRoot = path.join(base, 'package');
  const dataDir = hooks.dataDir ?? path.join(base, 'data'); await fs.mkdir(dataDir, { recursive: true });
  const executable = 'dependencies/python/bin/python3';
  for (const [name, text] of Object.entries({ 'dependencies/runtime.json': JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable }),
    [executable]: 'never executed', 'runtime/research_entry.py': '# software placeholder', 'engine/src/hana_math_engine/research.py': '# software placeholder' })) {
    const file = path.join(packageRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  }
  await fs.chmod(path.join(packageRoot, executable), 0o700);
  const requests = [], states = new Map(), bridges = [];
  const sdk = { dataDir, runtime: {
    async start(input) {
      const request = JSON.parse(await fs.readFile(input.args[4], 'utf8')); requests.push(request);
      if (hooks.startError) throw hooks.startError;
      const info = { runtimeId: request.requestId, runtime: 'command', profile: 'scoped', network: 'none', state: 'exited', exitCode: hooks.exitCode ?? 0 };
      states.set(info.runtimeId, info);
      const error = hooks.error ?? { code: 'size_limit', message: '/PRIVATE fixture message' };
      const envelope = { schemaVersion: 1, requestId: request.requestId, ok: false, error,
        diagnostic: hooks.diagnostic ?? refusalDiagnostic() };
      if (hooks.envelope) hooks.envelope(envelope, request);
      await fs.writeFile(input.args[5], JSON.stringify(envelope), { mode: 0o600 });
      hooks.started?.(request); return info;
    },
    async get(id) { if (hooks.get) return hooks.get(states.get(id)); return states.get(id); },
    async watch() { throw new Error('exited fixture must not watch'); },
    async stop(id) { if (hooks.stopError) throw hooks.stopError; return states.get(id); },
  } };
  const create = options => { const bridge = createResearchRuntime(sdk, { packageRoot, platform: 'darwin', arch: 'arm64', timeoutMs: 1000, cleanupTimeoutMs: 30, ...options }); bridges.push(bridge); return bridge; };
  const bridge = create();
  t.after(async () => { hooks.release?.(); await Promise.allSettled(bridges.map(b => b.dispose())); await fs.rm(base, { recursive: true, force: true }); });
  return { sdk, create, bridge, requests, packageRoot, dataDir, hooks };
}
export const fixtureBinding = { projectId: 'fixture-diagnostic', runId: 'run-diagnostic', role: 'main', author: 'fixture' };
export async function captureRefusal(bridge, operation = 'fact_list_page') {
  try { await bridge.call(fixtureBinding, operation); throw new Error('fixture expected refusal'); }
  catch (error) { if (error.code !== 'RESEARCH_RUNTIME_REJECTED') throw error; return error; }
}
