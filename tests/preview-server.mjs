// Software-only visual fixture. It never loads the Hana SDK or calls a host API.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ui = path.resolve(fileURLToPath(new URL('../packages/hana-math/ui/', import.meta.url)));
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const fixtureScript = `
import { mountMathPanel } from '/ui/assets/math-view.mjs';
const assistants = [
  {id:'shiraha',name:'Shiraha',isPrimary:true,isCurrent:false,avatarUrl:'./assets/avatars/shiraha.png',avatarSource:'reference'},
  {id:'xiaojingyu',name:'小鲸鱼',isPrimary:false,isCurrent:true,avatarUrl:'./assets/avatars/xiaojingyu.png',avatarSource:'reference'}
];
const roles = ['main','worker','verifier'].map(id=>({id,name:id,agentId:null,avatarUrl:'./assets/avatars/preset.png',avatarSource:'reference'}));
const drafts = new Map();
const fixture = window.__mathPreview = {calls:[],failNext:false,saves:0};
function editor(kind,id) {
  const item = (kind==='assistant'?assistants:roles).find(item=>item.id===id);
  if (!item) throw new Error('Unknown fixture member');
  const key=kind+':'+id;
  if (!drafts.has(key)) drafts.set(key, {kind,id,agentId:kind==='assistant'?id:null,name:item.name,latinName:id,model:{provider:'openai-codex',id:'gpt-6.1-sol'},identity:'用于浏览器布局测试的身份简介，不是宿主 Agent 提示词。',agentsMd:'# 人格定义\\n\\n- 先确定本轮目标、假设、范围和交付标准。\\n- 将问题拆成可验证的子目标，并说明每个子目标的依赖关系。\\n- 区分已核实事实、推测和未验证内容，不把候选结果当成结论。\\n- 先检查证据，再给出结论；证据不足时说明缺少什么。\\n- 保留关键约束、停止条件、错误处理方式和交付要求。\\n- 对复杂任务先列出可执行步骤，并检查步骤之间是否冲突。\\n- 每次修改前确认目标文件和允许的改动范围。\\n- 保存前逐项复核名称、模型、身份简介和完整指令。\\n- 发生冲突、部分失败或权限拒绝时保留草稿并停止覆盖。\\n- 只使用已经授权的接口和资源，不读取底层目录或凭据。\\n- 不把预览数据、示例文字或测试结果写入真实配置。\\n- 对不确定内容明确说明，并指出哪些部分尚未核验。\\n- 任务要求与已有指令冲突时先停止并报告，不擅自扩展范围。\\n- 交付前检查功能状态、键盘焦点、滚动区域和窄屏布局。\\n- 保持回答准确、克制，删除无法由证据支持的承诺。\\n- 完成后记录验证命令、实际结果和仍然存在的限制。',avatarUrl:item.avatarUrl,avatarSource:'reference',revision:'fixture-1',models:[{provider:'deepseek',id:'deepseek-flash',name:'DeepSeek Flash'},{provider:'openai-codex',id:'gpt-6.1-sol',name:'GPT-6.1 Sol'},{provider:'xai-oauth',id:'grok-4.7',name:'Grok 4.7'},{provider:'zivelian',id:'test-model',name:'测试模型（仅预览）'},{provider:'zivelian',id:'other-model',name:'另一测试模型'}],isPreset:kind==='role'});
  return structuredClone(drafts.get(key));
}
async function request(url, init={}) {
  fixture.calls.push({url,method:init.method||'GET'});
  await new Promise(resolve=>setTimeout(resolve,60));
  if (url==='/panel') return Response.json({assistants:{state:'ready',items:assistants},roles:{state:'ready',items:roles}});
  const match=/^\\/editor\\/(assistant|role)\\/([^/?]+)$/.exec(url);
  if (!match) return Response.json({ok:false,error:{code:'NOT_FOUND',message:'未知测试请求'}},{status:404});
  const kind=match[1], id=decodeURIComponent(match[2]);
  if ((init.method||'GET')==='GET') return Response.json({ok:true,editor:editor(kind,id)});
  if (fixture.failNext) {fixture.failNext=false; return Response.json({ok:false,error:{code:'FIXTURE_SAVE_ERROR',message:'模拟保存失败：草稿应被保留，真实 Agent 未被修改。'}},{status:500});}
  const body=JSON.parse(init.body); const current=editor(kind,id);
  if (body.revision!==current.revision) return Response.json({ok:false,error:{code:'CONFLICT',message:'模拟版本冲突'}},{status:409});
  const updated={...current,...body,revision:'fixture-'+(++fixture.saves+1),isPreset:false};
  if (body.avatarDataUrl) {updated.avatarUrl=body.avatarDataUrl;updated.avatarSource='math';}
  drafts.set(kind+':'+id, updated);
  const item=(kind==='assistant'?assistants:roles).find(item=>item.id===id); item.name=updated.name; item.avatarUrl=updated.avatarUrl;
  return Response.json({ok:true,editor:structuredClone(updated)});
}
window.__mathPreviewReady = Promise.resolve(mountMathPanel(document.querySelector('main'), {request}));
`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/narrow') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>Math narrow visual fixture</title></head><body style="margin:0;background:#ddd"><iframe title="360px layout fixture" src="/" style="display:block;border:0;width:360px;height:800px"></iframe></body></html>');
      return;
    }
    if (url.pathname === '/') {
      const source = await readFile(path.join(ui, 'panel.html'), 'utf8');
      const fixtureTheme = '<style id="isolated-fixture-theme">:root{color-scheme:light;--bg:#f7f3eb;--bg-card:#fffdf9;--bg-input:#fffdf9;--text:#3b342b;--text-light:#7b7469;--text-muted:#847d73;--border:#d5cec2;--accent:#668da0;--accent-hover:#557b8d;--accent-light:#dce9ed;--accent-rgb:102,141,160;--overlay-subtle:rgba(35,30,24,.035);--overlay-medium:rgba(35,30,24,.08);--overlay-light:rgba(35,30,24,.03);--shadow:rgba(35,30,24,.14)}</style>';
      const document = source.replace('</head>', fixtureTheme + '</head>')
        .replace(/<script\b[^>]*src=["'][^"']*panel\.js["'][^>]*>\s*<\/script>/i, '<script type="module">' + fixtureScript + '</script>')
        .replace('<title>Math</title>', '<title>Math · isolated software fixture</title>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(document);
      return;
    }
    const relative = decodeURIComponent(url.pathname.replace(/^\/ui\//, '/')).replace(/^\/+/, '');
    const target = path.resolve(ui, relative);
    if (!target.startsWith(ui + path.sep) || !mime[path.extname(target)]) throw new Error('Unsupported fixture path');
    const content = await readFile(target);
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Fixture resource not ready');
  }
});
server.listen(0, '127.0.0.1', () => console.log('PREVIEW_READY http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
