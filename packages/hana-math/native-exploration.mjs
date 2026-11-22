export const NATIVE_EXPLORATION_TOOLS = Object.freeze(['subagent', 'subagent_reply', 'subagent_message', 'subagent_close']);

export const NATIVE_EXPLORATION_GUIDANCE = 'Exploratory subagents are for speculative text-only mathematics, never accepted facts. Every NEW launch requires the confirmed DIFFERENT App explorer Agent and explicit provider/model below, with access:"read". Never omit agent/model or reuse the caller main Agent: native bootstrap/default behavior is not App main inheritance and may target a global persona. Include sufficient problem, canonical facts and context plus the full no-computation boundary in each assignment. Explore proof mechanisms, alternative routes, structural counterexamples, literature techniques, technical obstacles and architecture; no main Goal/coordinator duty, fact submission or global-memory mutation. Child tools do not inherit the parent exact active selection; Host read-only restrictions are separate. Do not use worker-local memory or raw research-session reads. All mathematics is TEXT ONLY: no numerical/symbolic programs, brute force, solvers, proof assistants or executable mathematical experiments, not even tiny checks. Advice is not an accepted fact or predecessor; promising leads must go through worker then verifier. Before using advice, confirm the exact explorer Agent identity from returned executorAgentId/agentId or native current_status subagents agentId for the actual threadId; requestedAgentId records the requested target, not child-model execution. Check any available child-model evidence, but when none is exposed record actualChildModel UNKNOWN (not verified), keep advice speculative, and do not disable exploration solely because child-model evidence is absent. current_status key=model reports the invoking main model only; the native subagent status projection exposes no child-model field. Never read raw child sessions or fabricate/infer child-model evidence from parent observer APIs or configured selection. Preserve each native threadId; use subagent_reply, subagent_message and subagent_close with that actual threadId. Existing children keep their old identities: never relabel, replace or replay them automatically. If actual Agent identity mismatches or cannot be confirmed, or native explicit model/target selection is denied, report exploration unavailable and continue worker/verifier; never fallback to Shiraha, another global/default Agent or main.';

// Tool-selection availability only; a separate confirmed explorer descriptor is required. Never authority.
export function nativeExplorationState(selection) {
  if (selection?.exploration?.state === 'available' && Array.isArray(selection.requested)
    && NATIVE_EXPLORATION_TOOLS.every(name => selection.requested.includes(name))) return 'available';
  if (selection?.exploration?.state === 'unavailable' && selection.exploration.errorCode === 'APP_HOST_ERROR'
    && Array.isArray(selection.requested) && NATIVE_EXPLORATION_TOOLS.every(name => !selection.requested.includes(name))) return 'unavailable';
  return 'unknown';
}

export function explorerProjection(value, mainAgentId) {
  const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (value?.schemaVersion === 1 && value.state === 'available' && value.role === 'explorer'
    && typeof value.agentId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.agentId) && value.agentId !== mainAgentId
    && typeof value.model?.provider === 'string' && /^[^\/\x00-\x20\x7f]{1,256}$/.test(value.model.provider)
    && typeof value.model?.id === 'string' && /^[^\x00-\x20\x7f]{1,1024}$/.test(value.model.id)
    && ['adapterContractSha256', 'adapterIdentitySha256', 'sourcesSha256', 'configuredIdentitySha256', 'configuredContractSha256'].every(k => sha(value.contract?.[k]))
    && Array.isArray(value.contract.originals) && value.contract.originals.length === 2 && value.contract.originals.every(s => typeof s.path === 'string' && sha(s.sha256))) {
    return { schemaVersion: 1, state: 'available', role: 'explorer', agentId: value.agentId, model: { provider: value.model.provider, id: value.model.id },
      contract: structuredClone(value.contract), selectionEvidence: 'saved-role-config-and-persona-readback', actualChildModel: 'unknown', nativeLaunchSupport: 'unverified' };
  }
  return { state: 'unavailable', errorCode: typeof value?.errorCode === 'string' && /^[A-Z0-9_]{1,96}$/.test(value.errorCode) ? value.errorCode : 'EXPLORER_UNCONFIRMED' };
}
export async function resolveNativeExplorer(profiles, mainAgentId) {
  try {
    if (typeof profiles?.getExplorerSelection !== 'function') return { state: 'unavailable', errorCode: 'EXPLORER_PROFILE_UNAVAILABLE' };
    return explorerProjection(await profiles.getExplorerSelection(), mainAgentId);
  } catch (error) { return explorerProjection({ errorCode: error?.code }, mainAgentId); }
}
export function nativeExplorationGuidance(selectionOrState, explorer) {
  const state = typeof selectionOrState === 'string' ? selectionOrState : nativeExplorationState(selectionOrState);
  const resolved = explorerProjection(explorer);
  if (state === 'available' && resolved.state === 'available') return NATIVE_EXPLORATION_GUIDANCE
    + '\nConfirmed explorer configuration (native launch support and actual child model remain unverified): '
    + JSON.stringify({ agent: resolved.agentId, model: `${resolved.model.provider}/${resolved.model.id}`, access: 'read', contract: resolved.contract }) + '\n';
  if (state === 'available') return 'Exploratory subagents are for speculative text-only mathematics. Explorer persona/model has not been confirmed for new native launches: report exploration unavailable and continue worker then verifier, never use a global/default or same-main Agent fallback. Any future confirmed launch must use access:"read" and explicit distinct agent/model with the full no-computation boundary. Inspect current_status subagents for existing native thread identities; old child identities remain historical, never relabel, replace or replay them.';
  if (state === 'unavailable') return 'Native exploratory subagents are unavailable for this main session; continue through worker then verifier. No global/default or same-main Agent fallback, automatic child replacement or replay is permitted.';
  return 'Native exploration availability has not been confirmed for this Goal. Continue through worker then verifier; new launches need a resolved distinct explorer descriptor and explicit model/read access. No global/default fallback, old-child relabeling or automatic replay. Report native denials honestly.';
}
