import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboardRequest } from '../packages/hana-math/dashboard-request.mjs';

const kinds = ['conclusion','example','counterexample','proof_attempt','plan','direction','obstacle','dead_end','verification','elaboration','master_guidance'];

test('Danus request adapter maps only exact paths to a fresh bound read', async () => {
  const selections = [];
  const request = createDashboardRequest(selection => { selections.push(selection); return { ordinal: selections.length }; });
  for (const route of ['/api/overview','/api/factgraph','/api/channels',...kinds.map(k=>`/api/channel/${k}`),'/api/overview']) {
    const response = await request(route);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await response.json()).ordinal,selections.length);
  }
  assert.deepEqual(selections,[{view:'overview'},{view:'factgraph'},{view:'channels'},...kinds.map(kind=>({view:'channel',kind})),{view:'overview'}]);
});

test('selectors cannot supply a project, remote URL or private channel; bound errors propagate', async () => {
  let calls = 0;
  const denied = new Error('owner denied');
  const request = createDashboardRequest(() => { calls++; throw denied; });
  for(const route of [null,{},'/api/factgraph?projectId=other','/api/channels/','/api/overview?projectId=other','/api/channel/plan#other',
    'https://example.invalid/api/overview','//example.invalid/api/channels','/api/channel/_status','/api/channel/%70lan','/api/channel/plan/../verification']) {
    assert.equal((await request(route)).status,404);
  }
  assert.equal(calls,0);
  await assert.rejects(request('/api/overview'), e => e===denied);
  assert.equal(calls,1);
});
