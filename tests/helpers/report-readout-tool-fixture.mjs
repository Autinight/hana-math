// Registers the real tool. Callers supply a project adapter; all SDK work is local fixture work.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { registerMathResearch } from '../../packages/hana-math/research-tools.mjs';

export async function reportReadoutTool(t, adapter) {
  const unexpected = async () => assert.fail('unexpected fixture route');
  const stubs = names => Object.fromEntries(names.split(' ').map(name => [name, unexpected]));
  let tool;
  const sdk = { dataDir: tmpdir(), tools: { async register(def) { if (def.name === 'math_project') tool = def; return () => {}; } } };
  const reg = await registerMathResearch(sdk, stubs('run status setupStatus setToolMode result stop invoke recordSubmissionInputRejection'), {
    ...stubs('create list status assign start stop result invoke handles goal mainGoal'), ...adapter,
  });
  t.after(() => reg.dispose()); assert.ok(tool);
  return tool;
}
