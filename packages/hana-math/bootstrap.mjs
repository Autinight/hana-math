import { isMathContextStatus } from './math-context-tool.mjs';

// One App-lifetime gate. Nothing is queued at the gate, including Host wakes
// and aborts: the SDK does not prove a deferred delivery is still valid.
const goalHandler = 'math-project-main-control';
const handlers = Object.freeze({ 'math-research-once': true, 'math-project-report': true,
  'math-project-setup': true, 'math-project-main-control': false });
const exitOwners = new Set();
function onExit() { for (const close of exitOwners) close(); }

export function createMathBootstrap(sdk) {
  const slots = new Map();
  const registrations = [], owners = new Set();
  let phase = 'registering', timer, cleanupJob;
  // Only Research cold-start recovery contributes these aggregates, not other App setup.
  // Gets include sessions.context/get; a historical abort attempt does not imply success.
  let recovery = { reconciledRuns: 0, listQueries: 0, getQueries: 0, deliveryQueries: 0,
    historicalSessionAbortAttempts: 0, elapsedMs: 0 };
  function onRecoveryProgress({ reconciledRuns, listQueries, getQueries, deliveryQueries, historicalSessionAbortAttempts, elapsedMs }) {
    if (phase !== 'preparing') return;
    if (![reconciledRuns, listQueries, getQueries, deliveryQueries, historicalSessionAbortAttempts]
      .every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    recovery = { reconciledRuns, listQueries, getQueries, deliveryQueries, historicalSessionAbortAttempts, elapsedMs };
  }
  const readReadiness = () => Object.freeze({ state: phase, ready: phase === 'ready', ...recovery });
  const closed = () => phase === 'failed' || phase === 'disposed';
  const code = () => closed() ? 'MATH_BOOTSTRAP_UNAVAILABLE' : 'MATH_BOOTSTRAP_PENDING';
  const refusal = (reason = code()) => Object.assign(new Error(reason), { code: reason });
  const assertReady = () => { if (phase !== 'ready') throw refusal(); };
  const assertPreparing = () => { if (phase !== 'preparing') throw refusal(); };
  const stop = () => { phase = 'disposed'; clearImmediate(timer); forgetExitOwner(); };
  function forgetExitOwner() {
    exitOwners.delete(stop);
    if (!exitOwners.size) process.removeListener('exit', onExit);
  }
  const release = receipt => typeof receipt.disposeAsync === 'function' ? receipt.disposeAsync() : receipt();
  // Own only fully returned services; a child can transfer cleanup to its parent.
  async function own(dispose) {
    if (closed()) {
      await Promise.resolve().then(dispose).catch(() => {});
      throw refusal();
    }
    owners.add(dispose);
    return { transfer() { owners.delete(dispose); } };
  }
  function cleanup() {
    if (!cleanupJob) {
      const disposers = [...owners].reverse(); owners.clear();
      cleanupJob = (async () => {
        for (const dispose of disposers) await Promise.resolve().then(dispose).catch(() => {});
      })();
    }
    return cleanupJob;
  }
  async function retain(receipt) {
    if (closed()) {
      await Promise.resolve().then(() => release(receipt)).catch(() => {});
      throw refusal();
    }
    registrations.push(receipt); return receipt;
  }
  async function registerHandlers() {
    for (const [key, hasAbort] of Object.entries(handlers)) {
      const slot = { handler: null, receipt: null }; slots.set(key, slot);
      const forward = method => async value => {
        const owner = slot.handler;
        const check = () => {
          // Only a newly arriving Goal schedule can enter its already-assembled
          // owner during restart activation. That owner checks generation/token/fired.
          if (phase !== 'ready' && !(phase === 'activating-goals' && key === goalHandler
            && method === 'run' && value?.kind === 'schedule')) throw refusal();
          if (!owner || slot.handler !== owner) throw refusal('MATH_BOOTSTRAP_UNAVAILABLE');
        };
        check(); // Never wait on our own registration, or retain an early callback.
        try {
          const result = await owner[method](value);
          check(); // Suppress a late reply, not side effects already entered by the owner.
          return result;
        } catch (error) { check(); throw error; }
      };
      slot.receipt = await retain(await sdk.tasks.registerHandler(key, { run: forward('run'), ...(hasAbort ? { abort: forward('abort') } : {}) }));
    }
  }
  async function attachHandler(key, handler) {
    const slot = slots.get(key);
    assertPreparing();
    if (!slot?.receipt || slot.handler || typeof handler?.run !== 'function'
      || (typeof handler.abort === 'function') !== handlers[key]) throw new Error('MATH_BOOTSTRAP_HANDLER_MISMATCH');
    slot.handler = handler;
    const detach = () => { if (slot.handler === handler) slot.handler = null; };
    // Preserve the real registration acknowledgement; the constructor owns
    // only the local attachment, while bootstrap owns the Host registration.
    return Object.assign(detach, { ready: slot.receipt.ready, disposeAsync: async () => detach() });
  }
  function enableGoalAlarms() {
    assertPreparing();
    if (slots.size !== Object.keys(handlers).length || [...slots.values()].some(slot => !slot.handler))
      throw new Error('MATH_BOOTSTRAP_HANDLERS_INCOMPLETE');
    phase = 'activating-goals';
  }
  function start(prepare) {
    if (phase !== 'registering') throw refusal();
    phase = 'preparing';
    if (!exitOwners.size) process.once('exit', onExit);
    exitOwners.add(stop);
    timer = setImmediate(() => {
      if (phase !== 'preparing') return;
      void (async () => {
        try {
          await prepare({ assertPreparing, enableGoalAlarms });
          if (closed()) return;
          if (phase !== 'activating-goals' || [...slots.values()].some(slot => !slot.handler))
            throw new Error('MATH_BOOTSTRAP_HANDLERS_INCOMPLETE');
          phase = 'ready';
        } catch (error) {
          if (phase === 'disposed') return;
          phase = 'failed'; forgetExitOwner(); // Close synchronously, before cleanup or logging.
          await Promise.allSettled([cleanup(), Promise.resolve().then(() => sdk.logger.error('Math backend preparation failed', {
            code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,96}$/.test(error.code) ? error.code : 'MATH_BOOTSTRAP_FAILED',
          }))]);
        }
      })();
    });
  }
  async function dispose() {
    stop();
    await Promise.allSettled([cleanup(), ...registrations.splice(0).reverse().map(receipt => Promise.resolve().then(() => release(receipt)))]);
  }
  const tools = { ...sdk.tools, async register(definition) {
    return retain(await sdk.tools.register({ ...definition, async execute(...args) {
      if (phase === 'ready') {
        const result = await definition.execute(...args);
        if (phase === 'ready') return result;
      }
      const details = { error: { code: code() } };
      // This is a receipt from the gate, not an early call to the tool owner.
      if (definition.name === 'math_context' && isMathContextStatus(args[0])) details.readiness = readReadiness();
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details, isError: true };
    } }));
  } };
  const routes = { ...sdk.routes, async register(registrar) {
    return retain(await sdk.routes.register(app => registrar(Object.fromEntries(['get', 'post'].map(method => [method,
      (path, handler) => app[method](path, async c => {
        // The panel roster uses only Host list/get operations. Do not put
        // identity display behind research recovery, or widen any other route.
        const earlyPanel = method === 'get' && path === '/panel' && c.req?.raw?.method === 'GET';
        const available = () => phase === 'ready' || (earlyPanel && !closed());
        if (available()) {
          try {
            const result = await handler(c);
            if (available()) return result;
          } catch (error) {
            if (available() || !earlyPanel) throw error;
          }
        }
        const discovery = path === '/workspace-monitor/current';
        return Response.json(discovery ? { state: 'unavailable' } : { error: { code: code() } },
          { status: discovery ? 200 : 503, headers: { 'cache-control': 'no-store' } });
      }),
    ])))));
  } };
  return Object.freeze({ guardedSdk: { ...sdk, tools, routes }, assertReady, registerHandlers, attachHandler, own, start, dispose,
    readReadiness, onRecoveryProgress });
}
