import { createCoreRuntime } from './runtime/core-runtime.mjs';
import { createContextService } from './context-service.mjs';
import { createContextProbe } from './context-probe.mjs';
import { ROLE_IDS, profileService, ProfileError } from './profile-service.mjs';

const PROBE_ROLE_IDS = Object.freeze(['main', 'worker', 'verifier']);
const ACTION_FIELDS = {
  status: [],
  role_status: ['role'],
  core_check: [],
  prepare: ['projectId', 'problem', 'operatorProfile', 'workerTask'],
  inspect: ['projectId'],
  probe: ['projectId', 'role'],
  probe_status: ['probeId'],
  probe_stop: ['probeId'],
};
const REQUIRED = {
  status: [], role_status: [], core_check: [],
  prepare: ['problem', 'operatorProfile', 'workerTask'],
  inspect: ['projectId'], probe: ['projectId', 'role'],
  probe_status: ['probeId'], probe_stop: ['probeId'],
};
// Keep editor localization out of model input; do not alter saved role content.
function modelErrorMessage(error) {
  if (error instanceof ProfileError) {
    const messages = {
      FORBIDDEN: 'Hana has not authorized this read/save operation. Check Math app permissions.',
      CONFLICT: 'The role binding or instance changed. Query it again.',
      NOT_FOUND: 'The requested member does not exist. Reopen the editor.',
      HOST_ERROR: 'The Hana operation failed; unconfirmed fields are not reported as saved.',
      INVALID_BINDING: 'The Math member binding is invalid; no agent was taken over.',
      AMBIGUOUS_INSTANCE: 'Multiple unbound instances exist; none was selected automatically.',
      ROLE_RETIRED: 'The Math role instance is retired. Save valid role settings in Math first.',
      ROLE_MISSING: 'The saved Math role instance is missing. Save valid role settings in Math first.',
      ROLE_NOT_CONFIGURED: 'The Math role has not been saved as an instance. Select a model and save it in Math first.',
      MODEL_NOT_CONFIGURED: 'The Math role has no saved chat model. Select a model and save it in Math first.',
    };
    return messages[error.code] || 'The Math profile operation failed; inspect the error code.';
  }
  return String(error?.message || 'The Math operation failed.').slice(0, 2000);
}
function invalid(message) {
  const error = new Error(message); error.code = 'MATH_CONTEXT_INVALID_INPUT'; throw error;
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Arguments must be an object.');
  if (!Object.hasOwn(ACTION_FIELDS, input.action)) invalid('Unsupported action.');
  const fields = new Set(['action', ...ACTION_FIELDS[input.action]]);
  if (Object.keys(input).some((key) => !fields.has(key))) invalid('The action contains unsupported arguments.');
  for (const field of REQUIRED[input.action]) {
    if (input[field] == null || (typeof input[field] === 'string' && !input[field].trim())) invalid(`Missing ${field}.`);
  }
  if (input.action === 'probe' && !PROBE_ROLE_IDS.includes(input.role)) invalid('Probe supports only main, worker and verifier.');
  if (input.action === 'role_status' && Object.hasOwn(input, 'role') && !ROLE_IDS.includes(input.role)) invalid('Unknown role.');
}
// `context` is reserved for SDK metadata; it is not a user argument.
export function isMathContextStatus(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const prototype = Object.getPrototypeOf(args);
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertyDescriptor(args, 'action')?.value === 'status'
    && Reflect.ownKeys(args).every(key => key === 'action' || key === 'context');
}
function reply(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(isError ? { isError: true } : {}) };
}
function failedResult(result) {
  return result?.ok === false || result?.success === false
    || ['failed', 'error', 'interrupted', 'invalid', 'incomplete', 'missing', 'timed-out'].includes(result?.status)
    || ['failed', 'error', 'interrupted', 'invalid', 'incomplete', 'missing', 'timed-out'].includes(result?.state);
}
export function assertCoreCheck(result) {
  if (!result || result.ok !== true || failedResult(result)) {
    const error = new Error(result?.error?.message || 'The core diagnostic did not return an explicit successful result.');
    error.code = typeof result?.error?.code === 'string' ? result.error.code : 'MATH_CORE_CHECK_FAILED';
    throw error;
  }
  return result;
}

/** Only configuration/diagnostic operations. No proof scheduling or MCP replacement. */
export async function registerMathContext(sdk, services = {}) {
  const contexts = services.contexts || createContextService(sdk);
  const core = services.core || createCoreRuntime(sdk);
  const probes = services.probes || createContextProbe(sdk, contexts);
  const profiles = services.profiles || profileService(sdk);
  const registration = await sdk.tools.register({
    name: 'math_context',
    description: 'Hana context adapter: manage original material and workspaces, check the packaged Python core, or diagnose read-only access to material. This does not start mathematical research or replace MCP. role_status reads saved role models without starting a model. Use prepare before inspect. probe invokes a model and creates background tasks, requiring user authorization; it uses only the corresponding role model saved in Math, without chat-model fallback or call-argument overrides. If unconfigured, save the role in Math first. Use probe_status for actual results and probe_stop to stop that diagnostic.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: Object.keys(ACTION_FIELDS) },
        projectId: { type: 'string', description: 'Math project ID returned by prepare; external paths are not accepted.' },
        problem: { type: 'string', description: 'Complete problem statement for this project; use a non-research fixture description for software diagnostics.' },
        operatorProfile: { type: 'string', description: 'Configuration notes explicitly supplied by the current operator; not copied from an old Danus project.' },
        workerTask: { type: 'string', description: 'Verbatim task for the current worker.' },
        role: { type: 'string', enum: ROLE_IDS, description: 'role_status reads any of the four configurable roles: main, worker, verifier or explorer. The model-starting probe action accepts only main, worker or verifier; explorer is not a probe/business role.' },
        probeId: { type: 'string', description: 'Diagnostic ID returned by probe.' },
      },
      required: ['action'],
    },
    async execute(args) {
      const { context, ...input } = args || {};
      try {
        validate(input);
        const { action, ...payload } = input;
        let result;
        switch (action) {
          case 'status':
            if (!isMathContextStatus(args)) invalid('The action contains unsupported arguments.');
            result = { checkpoint: 'CP2B', actions: Object.keys(ACTION_FIELDS), core: 'use_core_check',
              roleReading: 'use_probe_status', modelSource: 'saved-role', roleModels: 'use_role_status',
              researchScheduling: 'use_math_research', researchToolAdapter: 'six_role_bound_tools',
              mcpReplacement: 'partial', verificationEvidence: 'query_actual_run_and_facts' };
            if (services.readReadiness) result.readiness = services.readReadiness();
            break;
          case 'role_status': {
            const roles = await Promise.all((payload.role ? [payload.role] : ROLE_IDS).map(async (role) => {
              try {
                const selection = await profiles.getRoleModel(role);
                return { role, agentId: selection.agentId, instanceState: selection.instanceState,
                  model: { provider: selection.model.provider, id: selection.model.id }, source: selection.source };
              } catch (error) {
                return { role, error: { code: typeof error?.code === 'string' ? error.code : 'MATH_CONTEXT_FAILED',
                  message: modelErrorMessage(error) } };
              }
            }));
            result = { ok: roles.every((entry) => !entry.error), roles };
            return reply({ action, ok: result.ok, result }, !result.ok);
          }
          case 'core_check': result = await core.check(); break;
          case 'prepare': result = await contexts.prepare(payload); break;
          case 'inspect': result = await contexts.inspect(payload.projectId); break;
          case 'probe': {
            const selection = await profiles.getRoleModel(payload.role);
            result = await probes.start({ ...payload, model: selection.model,
              modelSelection: { source: 'saved-role', agentId: selection.agentId } }, context || {});
            break;
          }
          case 'probe_status': result = await probes.get(payload.probeId); break;
          case 'probe_stop': result = await probes.stop(payload.probeId); break;
        }
        if (failedResult(result)) return reply({ action, result }, true);
        if (action === 'core_check') assertCoreCheck(result);
        return reply({ action, result });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'MATH_CONTEXT_FAILED';
        return reply({ error: { code, message: modelErrorMessage(error) } }, true);
      }
    },
  });
  return { registration, contexts, core, probes, profiles };
}
