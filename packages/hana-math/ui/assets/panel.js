import { hana } from './sdk.js';
import { mountMathPanel } from './math-view.mjs';

const root = document.getElementById('math-panel');
let view = null;
let generation = 0;
let unsubscribe = null;
let themeLink = null;
let themeUrl = null;

function followTheme(snapshot) {
  const appearance = ['light', 'dark'].includes(snapshot?.appearance) ? snapshot.appearance : '';
  if (appearance) document.documentElement.style.colorScheme = appearance;
  else document.documentElement.style.removeProperty('color-scheme');
  if (typeof snapshot?.cssUrl !== 'string' || !snapshot.cssUrl.trim() || snapshot.cssUrl === themeUrl) return;
  themeUrl = snapshot.cssUrl;
  if (!themeLink) {
    themeLink = document.createElement('link');
    themeLink.rel = 'stylesheet';
    themeLink.addEventListener('load', () => { document.getElementById('theme-status').hidden = true; });
    themeLink.addEventListener('error', () => { document.getElementById('theme-status').hidden = false; });
    document.head.appendChild(themeLink);
  }
  themeLink.setAttribute('href', snapshot.cssUrl);
}

async function start() {
  const current = ++generation;
  try {
    await hana.ready();
    if (current !== generation) return;
    followTheme(hana.theme.getSnapshot());
    unsubscribe?.(); unsubscribe = hana.theme.subscribe(followTheme);
    view?.destroy(); root.replaceChildren();
    view = mountMathPanel(root, { request: (path, init) => hana.api.fetch(path, init) });
  } catch {
    if (current !== generation) return;
    const error = document.createElement('p');
    error.className = 'panel-error'; error.setAttribute('role', 'alert'); error.textContent = '暂时无法打开 Math 面板';
    root.replaceChildren(error);
  }
}

window.addEventListener('pagehide', () => { generation += 1; unsubscribe?.(); unsubscribe = null; view?.destroy(); view = null; });
window.addEventListener('pageshow', (event) => { if (event.persisted) void start(); });
void start();
