import { ROLE_IDS, profileService, publicAssistant, registerEditors } from './profile-service.mjs';
import { registerWorkspaceDashboardRoutes } from './workspace-dashboard-routes.mjs';
import { registerTexSettings } from './paper-compile-service.mjs';

export function projectAssistants(result) {
  if (result?.ok === false || result?.error || !Array.isArray(result?.agents)) throw new Error('Invalid assistant list');
  const seen = new Set();
  return result.agents.filter((agent) => {
    if (!publicAssistant(agent)) return false;
    if (typeof agent.id !== 'string' || !agent.id.trim() || seen.has(agent.id)) return false;
    seen.add(agent.id);
    return true;
  }).map((agent) => ({
    id: agent.id,
    name: typeof agent.name === 'string' && agent.name.trim() ? agent.name : agent.id,
    yuan: typeof agent.yuan === 'string' ? agent.yuan : null,
    ...(typeof agent.isCurrent === 'boolean' ? { isCurrent: agent.isCurrent } : {}),
    ...(typeof agent.isPrimary === 'boolean' ? { isPrimary: agent.isPrimary } : {}),
  })).sort((a, b) => Number(b.isPrimary === true) - Number(a.isPrimary === true) || Number(b.isCurrent === true) - Number(a.isCurrent === true));
}

export function projectRoles(result) {
  if (result?.ok === false || result?.error || !Array.isArray(result?.roles)) throw new Error('Invalid role list');
  return ROLE_IDS.map((id) => {
    const matches = result.roles.filter((role) => role?.roleId === id && role.appId === 'hana-math');
    if (matches.length !== 1 || typeof matches[0].agent?.name !== 'string' || !matches[0].agent.name.trim()) throw new Error('Missing or ambiguous role');
    const { agent } = matches[0];
    return { id, name: agent.name, yuan: typeof agent.yuan === 'string' ? agent.yuan : null };
  });
}

async function readSection(load) {
  try { return { state: 'ready', items: await load() }; }
  catch { return { state: 'error', items: [] }; }
}

export async function loadPanel(sdk, texService) {
  // This roster is available during bootstrap: avatar and role binding
  // resolution only read storage and lists, and never persist a recovered role.
  const profiles = profileService(sdk);
  const [assistants, roles, tex] = await Promise.all([
    readSection(async () => Promise.all(projectAssistants(await sdk.agents.list({ scope: 'all', lifecycle: 'active' }))
      .map(async (item) => ({ ...item, agentId: item.id, ...await profiles.avatar('assistant', item.id) })))),
    readSection(async () => {
      const items = projectRoles(await sdk.roles.list());
      const bindings = await profiles.roleBindings();
      return Promise.all(items.map(async (item) => {
        const binding = bindings[item.id], agent = binding.agent;
        if (item.id === 'explorer' && binding.state === 'unavailable') return { ...item, agentId: null, state: 'unavailable', errorCode: binding.errorCode,
          avatarUrl: './assets/avatars/preset.png', avatarSource: 'reference' };
        return { ...item, ...(agent ? { name: agent.name, yuan: typeof agent.yuan === 'string' ? agent.yuan : item.yuan } : {}), agentId: agent?.id || null, ...await profiles.avatar('role', item.id) };
      }));
    }),
    texService ? texService.getSettingsPanel().catch(() => ({
      configuredPath: null, resolvedPath: null, mode: 'auto', available: false,
      error: { code: 'TEX_SETTINGS_READ_FAILED', message: '暂时无法读取 LaTeX 编译设置。' },
    })) : Promise.resolve(null),
  ]);
  return tex ? { assistants, roles, tex } : { assistants, roles };
}

export async function registerPanel(sdk, dashboardView, workspaceDashboard, texService) {
  await sdk.routes.register((app) => {
    app.get('/panel', async (context) => context.json(await loadPanel(sdk, texService)));
    registerEditors(app, profileService(sdk));
    if (texService) registerTexSettings(app, texService);
    dashboardView?.registerRoutes(app);
    if (workspaceDashboard) registerWorkspaceDashboardRoutes(app, workspaceDashboard);
  });
}
