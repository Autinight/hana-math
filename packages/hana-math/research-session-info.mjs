// Cross-check the two public host projections. Only trusted backend callers may
// opt into home; existing private-session callers retain the App namespace gate.
// Neither titles nor internal sessionKind grant authority.
const APP = 'hana-math';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
function invalid(message) { return Object.assign(new Error(message), { code: 'SESSION_INFO_INVALID' }); }
function check(value, message) { if (!value) throw invalid(message); }
// Disk/list model metadata is optional, not the loaded session configuration.
// Preserve absence vs null without copying other session fields or invoking getters.
function modelFields(value) {
  return Object.fromEntries(['modelId', 'modelProvider'].map((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    const result = !field ? { state: 'missing' }
      : !Object.hasOwn(field, 'value') ? { state: 'invalid' }
        : field.value === null ? { state: 'null', value: null }
          : text(field.value) && field.value.length <= 256 ? { state: 'value', value: field.value } : { state: 'invalid' };
    return [key, result];
  }));
}

export async function readResearchSessionInfo(sdk, reference, options = { namespace: 'app' }) {
  check(object(options) && Object.keys(options).length === 1 && Object.hasOwn(options, 'namespace')
    && ['app', 'home'].includes(options.namespace), 'An explicit supported namespace is required');
  const namespace = options.namespace, visibility = namespace === 'home' ? 'public' : 'plugin_private';
  check(object(reference) && Object.keys(reference).length === 1
    && (text(reference.sessionId) || text(reference.sessionPath))
    && Object.keys(reference).every((key) => key === 'sessionId' || key === 'sessionPath'), 'A host session reference is required');
  let timer;
  const work = (async () => {
    const result = await sdk.sessions.get(reference);
    const session = result?.session;
    check(object(result) && result.ok !== false && !result.error && object(session), 'Session get is unavailable');
    check(text(session.sessionId) && (!reference.sessionId || session.sessionId === reference.sessionId)
      && session.ownerPluginId === APP && session.visibility === visibility && session.namespace === namespace
      && text(session.agentId) && text(session.cwd) && text(session.path), 'Session get does not prove an owned App session');
    const listed = await sdk.sessions.list({ scope: 'own', lifecycle: 'all', ownerPluginId: APP, agentId: session.agentId });
    check(object(listed) && listed.ok !== false && !listed.error && Array.isArray(listed.sessions), 'Session list is unavailable');
    // Count before filtering ownership: duplicate stable IDs, even foreign ones,
    // cannot be used to pick whichever row happens to agree with get.
    const matches = listed.sessions.filter((row) => row?.sessionId === session.sessionId);
    check(matches.length === 1, 'Session stable ID is missing or ambiguous');
    const row = matches[0];
    check(['ownerPluginId', 'visibility', 'agentId', 'cwd', 'path'].every((key) => row[key] === session[key]), 'Session projections disagree on identity');
    check(!Object.hasOwn(row, 'namespace') || row.namespace === session.namespace, 'Session projections disagree on namespace');
    check(Object.hasOwn(row, 'kind') && (row.kind === null || text(row.kind))
      && ['active', 'archived'].includes(row.lifecycle), 'Session list lacks public kind/lifecycle');
    for (const key of ['kind', 'lifecycle']) check(!Object.hasOwn(session, key) || session[key] === row[key], `Session projections disagree on ${key}`);
    const modelProjection = namespace === 'home' ? { get: modelFields(session), list: modelFields(row) } : null;
    if (modelProjection) for (const key of ['modelId', 'modelProvider']) {
      const left = modelProjection.get[key], right = modelProjection.list[key];
      if (left.state === 'invalid' || right.state === 'invalid'
        || left.state === 'value' && right.state === 'value' && left.value !== right.value) {
        throw Object.assign(invalid(`Session model projections are invalid or disagree on ${key}`), { modelProjection });
      }
    }
    return { sessionId: session.sessionId, ownerPluginId: session.ownerPluginId, visibility: session.visibility,
      namespace: session.namespace, agentId: session.agentId, cwd: session.cwd, path: session.path, kind: row.kind, lifecycle: row.lifecycle,
      ...(modelProjection ? { modelId: modelProjection.get.modelId.value ?? null,
        modelProvider: modelProjection.get.modelProvider.value ?? null, modelProjection } : {}) };
  })();
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Session identity lookup timed out'), { code: 'AUTHORITY_TIMEOUT' })), 10000);
    })]);
  } finally { clearTimeout(timer); }
}
