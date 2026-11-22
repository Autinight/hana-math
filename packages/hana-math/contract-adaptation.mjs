// Danus -> Hana environment adaptation of the three role contracts (parity D-03).
// Only environment statements are replaced. Mathematical discipline, gates, verdict
// rules and stop rules stay byte-identical. The upstream originals remain untouched in
// references/danus/** and are the left-hand side of every replacement, so a test can
// prove: adapted(upstream) === card.prompts.agents, and the replacement list is the only
// difference. See docs/design/contract-hana-adaptation.md.

const REPLACEMENTS = {
  main: [
    {
      from: 'A Goal is not a timer.** Timed wake-ups use the repository-enabled\n`clock.curr_time` and input-interruptible `clock.sleep` tools. The main thread',
      to: 'A Goal is not a timer.** Timed wake-ups come from the App Goal adapter: the\nApp injects a control-beat reminder at the anchored boundary; there is no clock tool. The main thread',
      why: 'Hana has no clock.sleep; the App schedules the beat (parity A-02).',
    },
    {
      from: 'call `clock.curr_time`\nand then `clock.sleep` for the remaining interval; do not end the turn and rely\non memory to wake up. A completed sleep is the scheduled wake-up. Operator input',
      to: 'wait for the App beat with `math_goal_main`\n`wait`; do not end the turn and rely on memory to wake up. A delivered beat is\nthe scheduled wake-up. Operator input',
      why: 'Same boundary, expressed as the Goal wait protocol.',
    },
    {
      from: 're-read the clock and sleep only for the time still remaining. Interruption never',
      to: 're-read the Goal due time with `math_goal_main` `status` and wait only for the time\nstill remaining. Interruption never',
      why: 'Current time comes from the formal status read, not a clock tool.',
    },
    {
      from: 'then advance to the next future boundary rather than producing ceremonial\nduplicate beats.',
      to: 'then advance to the next future boundary rather than producing ceremonial\nduplicate beats.',
      why: 'Unchanged sentence kept here as the anchor that completes this replacement block.',
    },
    {
      from: 'concrete next assignments with `danus assign` wherever needed, ensure no',
      to: 'concrete next assignments with `math_assign` wherever needed, ensure no',
      why: 'danus assign -> math_assign.',
    },
    {
      from: 'The main Codex session is configured in `.codex/config.toml` with `ultra`\nreasoning effort and the main-role Danus MCP servers. Workers use the separately\nconfigured `DANUS_WORKER_MODEL` and their own role-gated MCP surface.\n\nRequired service before proving:\n\n```bash\nbash scripts/services.sh up verify\n```\n\nPrimary controls: `danus list/new/assign/start/status/stop/finalize`; MCP tools\n`gm_add`, `gm_search`, `fact_search`, `fact_revoke`, and\n`search_arxiv_theorems`. Main-agent skills live in `.agents/skills/`.',
      to: 'The main role runs in a Hana Agent session owned by this App, with the models\nsaved in Math settings. Workers and the verifier run in their own App-owned sessions\nwith the same saved-role models; each role\'s tools are fixed by the role table.\n\nServices are started by the Host; there is no shell entrypoint to run. The Core is\nthe App\'s bundled Python engine, reached through the App tools.\n\nPrimary controls: `math_project` (`create`, `list`, `status`, `start`, `stop`,\n`assign`), plus `math_assign` for per-worker tasks; Core tools `gm_add`,\n`gm_search`, `fact_search`, `fact_revoke`, and `search_arxiv_theorems`. Role skills\nare mounted from this App package.',
      why: 'No codex, no services.sh, no danus CLI: the App owns sessions, models and the Core.',
    },
  ],
  worker: [
    {
      from: '# Danus worker — math reasoning agent (codex)\n\nYou are a Danus **worker**: a codex session that solves a research-level math\nproblem by a',
      to: '# Danus worker — math reasoning agent (Hana)\n\nYou are a Danus **worker**: a Hana App session that solves a research-level math\nproblem by a',
      why: 'codex session -> Hana App session.',
    },
    {
      from: 'your own files (`local_memory/notes.jsonl`, `events.jsonl`): raw thinking and\n',
      to: 'your own private notes through `math_local_memory` (append/read): raw thinking and\n',
      why: 'No direct file write; local memory is a tool (parity A-03).',
    },
    {
      from: 'No tool — just files.',
      to: 'No other tool is needed for this notebook.',
      why: 'Follows from the tool mapping above.',
    },
    {
      from: 'verifier-accepted facts. Read a fact directly (`fact_graph/facts/<id>.md`).',
      to: 'verifier-accepted facts. Read a fact through `fact_search` and `math_project`\n`result` with its factId.',
      why: 'No filesystem access to the fact graph.',
    },
    {
      from: 'You run in an autonomous outer loop: each round is a fresh codex session that',
      to: 'You run in an autonomous outer loop: each round is a fresh Hana worker session that',
      why: 'codex session -> Hana worker session.',
    },
    {
      from: 'from `fact_graph/facts/<fact_id>.md` on a relevant hit.',
      to: 'from `math_project` `result` with that factId on a relevant hit.',
      why: 'Same read path as above.',
    },
    {
      from: '- Plus the skills under `agents/skills/worker/` and codex built-ins.',
      to: '- Plus the role skills mounted with this App and the Host built-ins.',
      why: 'Skills are package-mounted; there is no codex.',
    },
  ],
  verifier: [
    {
      from: '`fact_id`, read `runtime/projects/<PROJECT>/fact_graph/facts/<fact_id>.md` to get',
      to: '`fact_id`, read the same fact through `fact_search` and the App `result` action to get',
      why: 'No filesystem path is exposed to the verifier.',
    },
    {
      from: '- `results/{run_id}/verification.json`',
      to: '- the verification report submitted through `math_verification_report`',
      why: 'The report is a tool call, not a file the model writes.',
    },
    {
      from: '5. Persist final JSON to `results/{run_id}/verification.json`.',
      to: '5. Submit the final JSON through `math_verification_report`; the App persists it and\n   the same JSON must be the final answer.',
      why: 'Same requirement, expressed as the write gate (parity A-04).',
    },
  ],
};

const FALLBACK = {
  codex: 'the Hana App session',
};

/** Apply only the registered replacements. Throws if an anchor is missing or duplicated. */
export function adaptContract(role, upstream) {
  const list = REPLACEMENTS[role];
  if (!list) throw new Error(`CONTRACT_ROLE_UNKNOWN: ${role}`);
  let text = upstream;
  for (const { from, to } of list) {
    if (from === to) continue;
    const at = text.indexOf(from);
    if (at < 0) throw new Error(`CONTRACT_ANCHOR_MISSING: ${role}: ${from.slice(0, 60)}`);
    if (text.indexOf(from, at + 1) > -1) throw new Error(`CONTRACT_ANCHOR_AMBIGUOUS: ${role}: ${from.slice(0, 60)}`);
    text = text.slice(0, at) + to + text.slice(at + from.length);
  }
  return text;
}

export const CONTRACT_REPLACEMENTS = Object.freeze(REPLACEMENTS);
