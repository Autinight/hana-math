import { defineApp } from './sdk/app-contract/server-client.js';
import { registerPanel } from './panel-service.mjs';
import { createDashboardView } from './dashboard-view.mjs';
import { assertCoreCheck, registerMathContext } from './math-context-tool.mjs';
import { createAppResearchCore } from './runtime/research-runtime.mjs';
import { createResearchSessions } from './research-sessions.mjs';
import { createLiteratureService } from './literature-service.mjs';
import { createResearchService } from './research-service.mjs';
import { registerMathResearch } from './research-tools.mjs';
import { createProjectService } from './project-service.mjs';
import { createProjectMainSession } from './project-main-session.mjs';
import { createSummaryWriter } from './report-writer.mjs';
import { createContextProbe } from './context-probe.mjs';
import { createMathBootstrap } from './bootstrap.mjs';

export const name = 'hana-math';
const startedRoots = new Set();
export default defineApp(async sdk => {
  // One dedicated App child per load. Do not replace an owner in-place for
  // the same trusted dataDir, even after partial setup. No filesystem IO here.
  const root = sdk.dataDir;
  if (startedRoots.has(root)) throw Object.assign(new Error('HANA_MATH_DUPLICATE_SETUP'), { code: 'HANA_MATH_DUPLICATE_SETUP' });
  startedRoots.add(root);
  const boot = createMathBootstrap(sdk);
  const instance = createAppResearchCore(sdk);
  let research, projects, probes;
  // These are local implementation bindings; callers never supply service names.
  const delegate = target => new Proxy(Object.create(null), { get: (_object, method) => (...args) => {
    boot.assertReady(); return target()[method](...args);
  } });
  const view = createDashboardView(boot.guardedSdk, delegate(() => projects));
  try {
    await boot.own(() => instance.dispose());
    await boot.own(() => view.dispose());
    const services = await registerMathContext(boot.guardedSdk, { probes: delegate(() => probes), readReadiness: boot.readReadiness });
    await boot.registerHandlers();
    await registerPanel(boot.guardedSdk, view, delegate(() => projects.workspaceDashboard));
    if (!view.supported) await sdk.logger.warn('Math live dashboard disabled: Host documents API unavailable.');
    await view.registerTool();
    await registerMathResearch(boot.guardedSdk, delegate(() => research), delegate(() => projects));
    // An explicitly requested build diagnostic still fails apply honestly.
    if (await sdk.launchArgs.get('core-self-test') === true) {
      assertCoreCheck(await services.core.check());
      await sdk.logger.info('Math CP2A managed core self-test passed.');
    }
    boot.start(async ({ assertPreparing, enableGoalAlarms }) => {
      // Constructors bind their original handlers to the exact registrations
      // above; all other SDK capabilities continue to go to the real SDK.
      const runtimeSdk = { ...sdk, tasks: { ...sdk.tasks, registerHandler: boot.attachHandler } };
      probes = createContextProbe(runtimeSdk, services.contexts);
      await boot.own(() => probes.dispose());
      await probes.recoveryReady; assertPreparing();
      const literature = createLiteratureService(runtimeSdk), sessions = createResearchSessions(runtimeSdk);
      const sessionOwner = await boot.own(() => sessions.dispose());
      assertPreparing();
      research = await createResearchService(runtimeSdk, { contexts: services.contexts, profiles: services.profiles,
        createCore: instance.createCore, sessions, literature, onRecoveryProgress: boot.onRecoveryProgress });
      sessionOwner.transfer(); await boot.own(() => research.dispose());
      assertPreparing();
      const summaryWriter = createSummaryWriter({ sdk: runtimeSdk, sessions: createResearchSessions(runtimeSdk), profiles: services.profiles });
      const writerOwner = await boot.own(() => summaryWriter.dispose());
      assertPreparing();
      projects = await createProjectService(runtimeSdk, { contexts: services.contexts, profiles: services.profiles,
        research, createCore: instance.createCore, literature, createMainSession: createProjectMainSession, summaryWriter });
      writerOwner.transfer(); await boot.own(() => projects.dispose());
      enableGoalAlarms();
      // Only the assembled Goal owner can accept a fresh alarm while it checks
      // prior consent, bindings, deadlines and budgets. Other doors stay shut.
      await projects.activateRestarts();
    });
  } catch (error) {
    await boot.dispose();
    throw error;
  }
});
