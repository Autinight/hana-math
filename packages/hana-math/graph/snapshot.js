(() => {
  'use strict';
  const snapshot = JSON.parse(document.getElementById('snapshot-data').textContent);
  const $ = id => document.getElementById(id);
  const text = (id, value) => { $(id).textContent = value; };
  const ns = 'http://www.w3.org/2000/svg';
  function element(tag, value, attributes = {}, svg = false) {
    const node = svg ? document.createElementNS(ns, tag) : document.createElement(tag);
    if (value !== null) node.textContent = value;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  const nodes = new Map(snapshot.facts.map(f => [f.fact_id, { ...f, missing: false, dependents: [], layer: 0 }]));
  for (const fact of snapshot.facts) for (const id of fact.predecessors) {
    if (!nodes.has(id)) nodes.set(id, { fact_id: id, predecessors: [], dependents: [], missing: true, layer: 0 });
    nodes.get(id).dependents.push(fact.fact_id);
  }
  const ordered = [...nodes.values()].sort((a, b) => a.fact_id.localeCompare(b.fact_id));
  for (const node of ordered) { node.dependents.sort(); node.remaining = node.predecessors.length; }
  const queue = ordered.filter(node => !node.remaining);
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    node.layered = true;
    for (const id of node.dependents) {
      const child = nodes.get(id);
      child.layer = Math.max(child.layer, node.layer + 1);
      if (--child.remaining === 0) queue.push(child);
    }
  }
  const missing = ordered.filter(node => node.missing).length;
  const unlayered = ordered.filter(node => !node.layered).length;
  const edgeCount = snapshot.facts.reduce((sum, f) => sum + f.predecessors.length, 0);
  text('metadata', `Project ${snapshot.projectId} · Captured ${new Date(snapshot.capturedAt).toISOString()}`);
  text('revision', `Snapshot revision: ${snapshot.asOf}`);
  text('summary', `${snapshot.facts.length} verified facts · ${edgeCount} predecessor → dependent relations · ${missing} missing placeholders`);
  text('warnings', [missing ? `${missing} predecessor(s) missing in snapshot; placeholders are not verified facts in this index.` : '',
    unlayered ? `Cycle detected. ${unlayered} node(s) are unlayered: in a cycle or downstream of one. No dependency depth is assigned to this group.` : ''].filter(Boolean).join(' '));
  const layers = new Map();
  for (const node of ordered) {
    const key = node.layered ? node.layer : 'unlayered';
    if (!layers.has(key)) layers.set(key, []);
    layers.get(key).push(node);
  }
  const keys = [...layers.keys()].filter(key => key !== 'unlayered').sort((a, b) => a - b);
  if (layers.has('unlayered')) keys.push('unlayered');
  let width = 1000, height = 520;
  keys.forEach((key, column) => {
    $('nodes').append(element('text', key === 'unlayered' ? 'Unlayered · cycle / blocked' : `Relation layer ${key}`, { x: 30 + column * 290, y: 26, class: 'group-label' }, true));
    layers.get(key).forEach((node, row) => {
      node.x = 30 + column * 290; node.y = 48 + row * 82;
      width = Math.max(width, node.x + 270); height = Math.max(height, node.y + 90);
      node.graphElement = element('g', null, { class: `node${node.missing ? ' missing' : ''}`, 'data-fact-id': node.fact_id, transform: `translate(${node.x} ${node.y})` }, true);
      node.graphElement.append(element('rect', null, { width: 240, height: 56, rx: 3 }, true),
        element('text', node.fact_id, { x: 12, y: 23 }, true),
        element('text', node.missing ? 'Missing in snapshot' : 'Verified fact · preview only', { x: 12, y: 43 }, true));
      node.graphElement.addEventListener('pointerdown', event => event.stopPropagation());
      node.graphElement.addEventListener('click', () => select(node.fact_id));
      $('nodes').append(node.graphElement);
    });
  });
  for (const node of ordered) for (const id of node.predecessors) {
    const from = nodes.get(id);
    const x1 = from.x + 240, y1 = from.y + 28, x2 = node.x, y2 = node.y + 28;
    const bend = x2 > x1 ? (x1 + x2) / 2 : Math.max(x1, x2) + 35;
    $('edges').append(element('path', null, { class: 'edge', 'data-source': id, 'data-target': node.fact_id,
      d: `M ${x1} ${y1} C ${bend} ${y1 - (id === node.fact_id ? 65 : 0)}, ${bend} ${y2 + (id === node.fact_id ? 65 : 0)}, ${x2} ${y2}`,
      'marker-end': 'url(#arrow)' }, true));
  }
  let scale = 1, panX = 0, panY = 0;
  function updateView() {
    $('viewport').setAttribute('transform', `translate(${panX} ${panY}) scale(${scale})`);
    text('zoom-status', `${Math.round(scale * 100)}%`);
  }
  function reset() {
    scale = Math.max(.25, Math.min(1, 960 / width, 480 / height));
    panX = 20; panY = 20; updateView();
  }
  function zoom(factor) {
    const next = Math.max(.1, Math.min(4, scale * factor));
    panX = 500 - (500 - panX) * next / scale;
    panY = 260 - (260 - panY) * next / scale;
    scale = next; updateView();
  }
  function relationList(host, ids) {
    host.replaceChildren();
    if (!ids.length) host.append(element('li', 'None recorded.'));
    for (const id of ids) {
      const button = element('button', `${id}${nodes.get(id).missing ? ' · missing in snapshot' : ''}`, { type: 'button', 'data-fact-id': id });
      button.addEventListener('click', () => select(id));
      const item = element('li', null); item.append(button); host.append(item);
    }
  }
  function select(id, center = true) {
    const node = nodes.get(id);
    for (const item of ordered) {
      item.graphElement.setAttribute('class', `node${item.missing ? ' missing' : ''}${item.fact_id === id ? ' selected' : ''}`);
      item.listButton.setAttribute('aria-pressed', String(item.fact_id === id));
    }
    $('fact-id').value = id;
    text('selection-status', node.missing ? 'Missing in snapshot · placeholder' : 'Verified fact · preview only');
    text('preview', node.missing ? 'No statement is available for this missing predecessor.' : node.statementPreview);
    text('fact-meta', node.missing ? 'Canonical size unavailable.' : `${node.canonicalBytes} canonical bytes · ${node.statementPreviewTruncated ? 'Statement preview truncated.' : 'Statement preview not truncated.'}`);
    text('proof-example', JSON.stringify({ action: 'result', projectId: snapshot.projectId, factId: id }, null, 2));
    relationList($('predecessors'), node.predecessors); relationList($('dependents'), node.dependents);
    if (center) { scale = Math.max(scale, .8); panX = 500 - (node.x + 120) * scale; panY = 260 - (node.y + 28) * scale; updateView(); }
  }
  for (const node of ordered) {
    const button = element('button', `${node.fact_id}${node.missing ? ' · missing in snapshot' : ''}`, { type: 'button', 'aria-pressed': 'false', 'data-fact-id': node.fact_id });
    node.listButton = button;
    button.addEventListener('click', () => select(node.fact_id));
    const item = element('li', null); item.append(button); node.listItem = item; $('node-list').append(item);
  }
  function filter() {
    const query = $('filter').value.trim().toLowerCase();
    let visible = 0;
    for (const node of ordered) {
      const matches = `${node.fact_id} ${node.statementPreview || ''} ${node.missing ? 'missing in snapshot' : ''}`.toLowerCase().includes(query);
      node.listItem.hidden = !matches; if (matches) visible++;
    }
    text('filter-count', `${visible} of ${ordered.length} nodes match. Filter applies to the index; the graph retains all relations.`);
  }
  $('filter').addEventListener('input', filter);
  $('fact-id').addEventListener('click', () => $('fact-id').select());
  $('zoom-in').addEventListener('click', () => zoom(1.25));
  $('zoom-out').addEventListener('click', () => zoom(.8));
  $('reset').addEventListener('click', reset);
  globalThis.addEventListener?.('resize', reset);
  const svg = $('graph');
  let drag = null;
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const bounds = svg.getBoundingClientRect();
    // Default SVG meet alignment uses one scale and may letterbox.
    const ratio = Math.max(1000 / bounds.width, 520 / bounds.height);
    panX = drag.panX + (event.clientX - drag.x) * ratio;
    panY = drag.panY + (event.clientY - drag.y) * ratio; updateView();
  });
  const stop = () => { drag = null; };
  svg.addEventListener('pointerup', stop); svg.addEventListener('pointercancel', stop); svg.addEventListener('lostpointercapture', stop);
  reset(); filter();
  if (ordered.length) select(snapshot.facts[0]?.fact_id || ordered[0].fact_id, width > 4000 || height > 2000);
  else {
    text('selection-status', 'No verified facts in this snapshot.');
    text('preview', 'This index is empty. Capture a new snapshot after verified facts become available.');
    text('proof-example', 'Select a fact to see a result lookup example.');
    relationList($('predecessors'), []); relationList($('dependents'), []);
  }
})();
