// Publish from a confirmed creator grant, not from a viewer poll. A publication
// is a fixed set of read-only projections; it is never a stored live capability.
import {randomUUID} from 'node:crypto';
import {dashboardSelection} from './dashboard-request.mjs';
import {livePaths} from './ui/dashboard/live-protocol.mjs';
import {workspaceProjectBusy} from './dashboard-monitor-transport.mjs';
const unavailable = Object.freeze({state:'unavailable'});
const requireTrue = b => { if (b !== true) throw new Error('Workspace publication changed'); };

export function createSnapshotPublisher({archive, capture, delay = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const jobs = new Map(); let closed = false;
  function notify(projectId) {
    if (closed) return;
    let c;
    try { c = capture(projectId); if (!c || !c.guard()) return; } catch { return; }
    const {endedAt, scopeSeal} = c, key = `${projectId}:${endedAt}:${scopeSeal}`;
    if (jobs.has(key)) return;
    const published = archive.latest();
    if (published && (published.endedAt > endedAt || published.endedAt === endedAt && published.scopeSeal === scopeSeal && published.projectId === projectId)) return;
    const guard = () => { requireTrue(!closed && c.guard()); return true; };
    const id = {projectId,endedAt,scopeSeal};
    const job = Promise.resolve().then(async () => {
      guard(); await c.authorize(guard); guard();
      await archive.begin(id,guard); guard(); // Only a currently authorized publication may advance the shared watermark.
      const panels = {};
      for (const path of ['/api/overview','/api/channels','/api/factgraph',...livePaths.filter(p=>p.startsWith('/api/channel/'))]) {
        const sel = dashboardSelection(path);
        if (sel.view === 'channel' && panels['/api/channels'].channels.find(row=>row.kind === sel.kind)?.count === 0) {
          // A confirmed count of zero at the same pinned inventory revision
          // uniquely determines this public channel projection. No Core call.
          panels[path] = {kind:sel.kind,count:0,entries:[]}; continue;
        }
        for (let attempt=0;;attempt++) {
          guard();
          try { panels[path] = await c.read(sel,guard,endedAt); break; }
          catch (error) {
            if (error !== workspaceProjectBusy || attempt >= 2) throw error;
            guard(); await delay(350 * (attempt + 1));
          }
        }
        guard();
      }
      await c.authorize(guard); guard();
      const inventoryRevision=c.getRevision(); requireTrue(typeof inventoryRevision === 'string' && /^[a-f0-9]{64}$/.test(inventoryRevision));
      await archive.publish({...id,inventoryRevision,panels},guard);
    });
    jobs.set(key,{projectId,job});
    job.finally(()=>jobs.delete(key)).catch(()=>{}); // Failure keeps the pending watermark; never publish a partial or an older capture.
  }
  function waitForProject(projectId) {
    const prior = [...jobs.values()].filter(entry=>entry.projectId===projectId).map(entry=>entry.job);
    return prior.length ? Promise.allSettled(prior) : null;
  }
  return Object.freeze({notify, waitForProject, get pending(){return jobs.size;},
    drain:()=>Promise.allSettled([...jobs.values()].map(entry=>entry.job)), close(){closed=true;}});
}

// A published artifact is never handed to Core. A fixed follow may instead
// use its own read-only reader, with separate lifecycle and owner evidence.
export function withPublishedWorkspaceDashboard({live,archive,allowed,authorize,epoch,liveOwnerCheck,getSaved,getHistoricalSaved,getHistoricalPublication}) {
  let issued;
  function selectPublication(ticket,guard,choice) {
    const stamp=epoch(); requireTrue(allowed(ticket)); requireTrue(guard());
    if (issued?.ticket !== ticket || issued.choice !== choice || issued.epoch !== stamp) issued={ticket,choice,epoch:stamp,
      summary:Object.freeze({state:'snapshot',projectId:ticket.projectId,endedAt:ticket.endedAt,generation:randomUUID()})};
    return issued.summary;
  }
  function select(guard) {
    try {
      requireTrue(guard()); const cur=live.current(guard);
      if (cur.state === 'unavailable') {
        // Neither scoped selection claims a global terminal winner. An exact
        // published ticket takes precedence over current-data reads; any
        // pending, corrupt or conflicting publication blocks both paths.
        const ticket=archive.latest(), barrier=archive.barrier?.();
        if (ticket && barrier?.state === 'published' && barrier.endedAt === ticket.endedAt) {
          const choice=getHistoricalPublication?.(ticket);
          if (choice) return selectPublication(ticket,guard,choice);
        } else if (!ticket && !barrier) {
          const saved=getHistoricalSaved?.();
          if (saved) {
            const stamp=epoch(); requireTrue(guard());
            if (!issued?.historical || issued.saved !== saved || issued.epoch !== stamp) issued={saved,historical:true,epoch:stamp,
              summary:Object.freeze({state:'saved',projectId:saved.projectId,asOf:saved.asOf,generation:randomUUID()})};
            return issued.summary;
          }
        }
      }
      if (issued?.historical) issued=undefined; // A normal selection cannot reuse a scoped saved ticket.
      if (cur.state !== 'idle' && cur.state !== 'snapshot') { issued=undefined; return cur; }
      const ticket=archive.latest(), barrier=archive.barrier?.();
      if (!ticket && barrier && (cur.state==='idle' || !barrier.endedAt || cur.endedAt <= barrier.endedAt)) {
        issued=undefined; return unavailable; // A known newer unfinished/invalid capture cannot be replaced by yesterday's result.
      }
      if (cur.state === 'idle' && ((!ticket && !barrier) || (ticket && barrier?.state === 'published'))) {
        const saved=getSaved?.();
        // A confirmed stale publication, even for another project, is not
        // a reason to hide the creator's separately authorized current read.
        // Never read the superseded archive. Exceptions/unknown do not count
        // as a negative freshness witness; a valid terminal archive wins.
        if (saved && (!ticket || allowed(ticket) === false)) {
          const stamp=epoch(); requireTrue(guard());
          if (issued?.saved !== saved || issued.epoch !== stamp) issued={saved,epoch:stamp,summary:Object.freeze({state:'saved',projectId:saved.projectId,
            asOf:saved.asOf,generation:randomUUID()})};
          return issued.summary;
        }
      }
      if (ticket && cur.state === 'snapshot' && cur.endedAt === ticket.endedAt && cur.projectId !== ticket.projectId) {
        issued=undefined; return unavailable; // Neither project is demonstrably more recent.
      }
      if (!ticket || cur.state === 'snapshot' && cur.endedAt > ticket.endedAt) { issued=undefined; return cur; }
      return selectPublication(ticket,guard);
    } catch { issued=undefined; return unavailable; }
  }
  function current(guard) {
    const cur=select(guard), bound=issued;
    // A persisted live opt-in never discloses even the project metadata until
    // its creator and current Host main binding have been rechecked.
    const verify = bound?.saved ? bound.saved.authorize : bound ? check => authorize(bound.ticket,check) : liveOwnerCheck?.(cur);
    if (!verify) return cur;
    const check=()=>{ requireTrue(select(guard) === cur && issued === bound); return true; };
    return (async()=>{
      try { await verify(check); check(); return cur; }
      catch { return unavailable; }
    })();
  }
  async function read(selection,generation,guard) {
    try {
      const cur=select(guard), bound=issued;
      if (!cur.generation || cur.generation !== generation) return unavailable;
      if (!bound) {
        const value=await live.read(selection,generation,guard);
        return select(guard) === cur ? value : unavailable;
      }
      const check=()=>{ requireTrue(select(guard) === cur && issued === bound); return true; };
      if (bound.saved) {
        // Fixed vocabulary only, separate from the verified terminal archive.
        requireTrue(livePaths.some(path=>dashboardSelection(path) === selection));
        await bound.saved.authorize(check); check();
        try { const value=await bound.saved.read(selection,check,bound.saved.asOf); check(); return value; }
        catch (error) { check(); return error === workspaceProjectBusy ? workspaceProjectBusy : unavailable; }
      }
      await authorize(bound.ticket,check); check();
      const value=archive.read(bound.ticket,selection); check(); return value;
    } catch { return unavailable; }
  }
  return Object.freeze({current,read});
}
