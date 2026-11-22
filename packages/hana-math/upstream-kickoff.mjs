// Danus worker kickoff, verbatim. Source: danus/execution/loop.py `kickoff()` at
// Danus commit 839c471d0560b9b5308afc6cbb59a138819fe16c
// (file SHA-256 66eebac286eaa60a1d21b6ed0a8e516870c593f9fe6ac269364c8d1af0f27014).
// Do not edit the wording. Hana-specific mappings belong in a separate block after it
// (docs/danus-parity.md D-02).
export const UPSTREAM_KICKOFF_SOURCE = Object.freeze({
  path: 'danus/execution/loop.py',
  gitHead: '839c471d0560b9b5308afc6cbb59a138819fe16c',
  sha256: '66eebac286eaa60a1d21b6ed0a8e516870c593f9fe6ac269364c8d1af0f27014',
});

export function upstreamKickoff(project, worker) {
  return `You are worker '${worker}' on project '${project}'. Continue solving the `
    + 'problem (this is a continuation round, not a fresh start).\n'
    + '1. Read TASK.md — your current assignment (which direction/subgoal is yours).\n'
    + '2. Follow AGENTS.md (worker.md) exactly — your standing contract (the adaptive '
    + 'control loop, memory discipline, the fact_submit gate). Drive toward a full '
    + 'verified result.\n'
    + '3. Resume from state: gm_search relevant findings + dead ends, read the fact '
    + 'graph and the latest master_guidance — DO NOT restart from zero; build on what '
    + 'is already there.\n'
    + '4. Keep going: assess -> pick skills adaptively -> act -> persist, repeatedly. '
    + 'An open problem is not a reason to stop. Do NOT finalize prematurely.\n'
    + '5. Persist as you go: rough progress to local memory; shareable findings via '
    + 'gm_add; any verified result via fact_submit.';
}
