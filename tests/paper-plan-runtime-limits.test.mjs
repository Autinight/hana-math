// C3-owned accuracy controls: session limits and parser/artifact guards differ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildPlanPrompt, capturePlanMaterial, readPlanResources } from '../packages/hana-math/paper-plan.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const disclosure = text => {
  assert.match(text, /session finalText[^.]*512 KiB/);
  assert.match(text, /reject[^.]*not truncat/i);
  assert.match(text, /planner parser\/artifact[^.]*2 MiB/);
  assert.doesNotMatch(text, /2 MiB output cap|512 KiB prompt and 2 MiB output/);
};

test('C3 contract: planner adapter states the effective session finalText limit independently of parser/artifact guards', async t => {
  const factId = 'a'.repeat(16), fact = { fact_id: factId, predecessors: [], markdown: `---\nfact_id: ${factId}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOpaque.\n## proof\nOpaque.\n` };
  const target = { schemaVersion: 1, projectId: 'c3-limits', paperId: 'main', factIds: [factId], factDigests: { [factId]: hash(fact.markdown) }, finalizedBy: 'creator', at: 1 };
  const gathered = { facts: [fact], asOf: 'c3-limits' }, plan = { paperId: 'main', target, brief: 'Opaque', instructions: '', material: capturePlanMaterial({ ...gathered, target }).material };
  const resources = await readPlanResources(), input = buildPlanPrompt({ ...gathered, plan, resources }), adapter = input.prompt.split('\n\n===== BEGIN ')[0];
  t.diagnostic('C3_PROMPT ' + JSON.stringify({ hashes: input.hashes, adapter, promptBytes: Buffer.byteLength(input.prompt) }));
  disclosure(adapter); assert.equal(input.hashes.promptSha256, hash(input.prompt));
  for (const resource of Object.values(resources)) assert.ok(input.prompt.includes(resource), 'original resources remain embedded verbatim');
});

test('C3 contract: new paper_plan tool disclosure distinguishes effective session rejection from parser/artifact limits', async t => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-c3-limits-'))), tools = new Map();
  let registration;
  t.after(async () => { await registration?.dispose(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const unexpected = async () => assert.fail('description inspection must not invoke research, model, export or project operations');
  const research = Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'].map(name => [name, unexpected]));
  const projects = Object.fromEntries(['create', 'list', 'status', 'assign', 'start', 'stop', 'result', 'invoke', 'handles', 'goal', 'mainGoal'].map(name => [name, unexpected]));
  registration = await registerMathResearch({ dataDir, tools: { async register(tool) { tools.set(tool.name, tool); return () => {}; } }, resources: { stage: unexpected } }, research, projects);
  const description = tools.get('math_project').description;
  disclosure(description.slice(0, description.indexOf('Creator only: paper_subgraph')));
  assert.match(description, /not claims about Host hard limits/);
});
