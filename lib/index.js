// dsh-workflow-assistant — Host 半
// 工作单为本：状态 = 进度清单勾选数；待办 = 评审门 / 最终验收门。
// 提供：
//   GET  /workorders-viewer?file=xxx        → HTML 查看器（动态生成，客户端 marked 渲染）
//   GET  /workorders-vendor/marked.min.js   → 本地 markdown 解析器（marked, MIT）
//   GET  /workorders-api?sessionId=..       → 工作单状态 JSON
// 监听 AI 对 workorders/ 的 write/edit → 立即重扫（与轮询同一套逻辑）。

import { fileURLToPath } from 'node:url'

export const name = 'workflow-assistant'
export const inject = ['webServer', 'sessions', 'fs', 'agents']

const WORKDIR = 'workorders'
let MARKED_PATH = null
try { MARKED_PATH = fileURLToPath(new URL('./vendor/marked.min.js', import.meta.url)) } catch { MARKED_PATH = null }

const norm = (p) => String(p || '').replace(/\\/g, '/')
const lower = (p) => norm(p).toLowerCase()

let cache = { cwd: null, state: null, error: null }

// ---------- fs helpers ----------
async function readText(cwd, rel, fs) {
  const target = await fs.resolve(rel, { cwd })
  return fs.readText(target)
}
async function safeReadText(cwd, rel, fs) {
  try { return await readText(cwd, rel, fs) } catch { return null }
}

// ---------- worksheet parsing ----------
function tableRows(lines) {
  const rows = []
  let skipHeader = false
  for (const raw of lines) {
    const t = raw.trim()
    if (!t.startsWith('|')) { skipHeader = false; continue }
    if (/^\|[\s:|-]+\|$/.test(t)) { skipHeader = true; continue }
    const cells = t.split('|').slice(1, -1).map((c) => c.trim())
    if (skipHeader) { skipHeader = false; continue }
    rows.push(cells)
  }
  return rows
}
function parseWorksheet(text) {
  const lines = text.split(/\r?\n/)
  const titleMatch = text.match(/^#\s+任务工作单\s*[：:]\s*(.+?)\s*$/m)
  const checklist = []
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/)
    if (m) checklist.push({ label: m[2].trim(), done: m[1].toLowerCase() === 'x' })
  }
  const sections = {}
  let current = null
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) { current = h[1].trim(); sections[current] = []; continue }
    if (current) sections[current].push(line)
  }
  const info = {}
  for (const row of tableRows(sections['基本信息'] || [])) {
    if (row.length >= 2) info[row[0]] = row.slice(1).join('|')
  }
  const taskId = info['任务编号'] || ''
  const rawTier = info['规模档位'] || ''
  const tier = (rawTier.match(/[低中高]/) || [])[0] || ''
  const related = info['关联需求 / 工单'] || info['关联需求/工单'] || ''
  const reqText = (sections['需求'] || []).join('\n')
  const acCount = (reqText.match(/^\s*-\s*AC\d+/gm) || []).length
  const slicesCount = tableRows(sections['任务切片'] || []).length
  const tcCount = tableRows(sections['测试用例清单'] || []).length
  return { title: titleMatch ? titleMatch[1].trim() : '', checklist, taskId, tier, related, acCount, slicesCount, tcCount }
}
function derive(checklist) {
  const total = checklist.length
  const done = checklist.filter((c) => c.done).length
  let stage = '已交付'
  let next = ''
  for (const item of checklist) {
    if (!item.done) { stage = '待：' + item.label; next = item.label; break }
  }
  return { stage, next, progress: { done, total } }
}
function reviewInfo(checklist, tier) {
  const idx = checklist.findIndex((c) => c.label.indexOf('工作单整体评审通过') >= 0)
  if (idx < 0) return { pending: false }
  const needsGate = tier === '中' || tier === '高'
  const ready = checklist.slice(0, idx).every((c) => c.done)
  const boxDone = checklist[idx].done
  return { pending: needsGate && ready && !boxDone }
}

// ---------- todos: 纯工作单状态驱动 ----------
// 仅两个需要用户出手的门：中/高复杂度评审门、最终验收
function todosFor(state) {
  const todos = []
  if (!state || !state.exists || !state.file) return todos
  if (reviewInfo(state.checklist, state.tier).pending) {
    todos.push({ key: 'review:' + state.file, kind: 'review-pending', worksheet: state.file, title: '工作单待人工评审（中/高复杂度）', note: '工作单已齐备（需求/契约/切片/用例），进入实现前需人工评审通过。' })
  }
  const c = state.progress.done
  if (c === 6) {
    todos.push({ key: 'accept:' + state.file, kind: 'accept-pending', worksheet: state.file, title: '工作单待最终验收', note: '实现已完成（勾选数 6/8），请按验收标准核对并给出验收结果。' })
  }
  return todos
}

// ---------- state building ----------
async function scanWorkorders(cwd, fs) {
  let entries = []
  let exists = false
  try {
    const dir = await fs.resolve(WORKDIR, { cwd })
    entries = await fs.listDir(dir)
    exists = true
  } catch { exists = false }
  const out = []
  for (const e of entries) {
    if (e.type === 'directory') continue
    const m = /^T-(\d{8})-([^.]*)\.md$/i.exec(e.name)
    if (m) out.push({ name: e.name, date: Number(m[1]), seq: m[2] })
  }
  out.sort((a, b) => (b.date - a.date) || String(b.seq).localeCompare(String(a.seq)))
  return { exists, files: out }
}
async function buildOne(cwd, file, fs) {
  const text = await safeReadText(cwd, WORKDIR + '/' + file, fs)
  if (text === null) return null
  const parsed = parseWorksheet(text)
  const d = derive(parsed.checklist)
  const base = {
    file, exists: true, path: norm(cwd) + '/' + WORKDIR + '/' + file,
    title: parsed.title, taskId: parsed.taskId, tier: parsed.tier, related: parsed.related,
    stage: d.stage, next: d.next, progress: d.progress, checklist: parsed.checklist,
    acCount: parsed.acCount, slicesCount: parsed.slicesCount, tcCount: parsed.tcCount,
    content: text
  }
  base.todos = todosFor(base)
  return base
}
async function buildState(cwd, fs) {
  const scan = await scanWorkorders(cwd, fs)
  const worksheets = []
  for (const f of scan.files) {
    const one = await buildOne(cwd, f.name, fs)
    if (one) worksheets.push(one)
  }
  const todos = []
  for (const w of worksheets) todos.push.apply(todos, w.todos)
  return {
    ok: true, cwd,
    hasWorkflow: scan.exists,
    exists: worksheets.length > 0,
    latest: worksheets.length ? worksheets[0] : null,
    worksheets, todos,
    files: worksheets.map((w) => w.file),
    error: null
  }
}
async function refresh(cwd, fs) {
  try {
    const state = await buildState(cwd, fs)
    cache = { cwd, state, error: null }
    return state
  } catch (err) {
    const message = String((err && err.message) || err)
    cache = { cwd, state: null, error: message }
    return { ok: false, cwd, exists: false, hasWorkflow: false, error: message }
  }
}
async function cwdOf(sessions, sessionId) {
  const session = sessions ? sessions.get(sessionId) : undefined
  const cwd = session && session.header ? session.header.cwd : undefined
  if (!cwd) throw new Error('无法解析会话 ' + sessionId + ' 的工作区目录')
  return cwd
}

// ---------- HTML 查看器（移植自 template/build-workorders.cjs） ----------
const VIEWER_STATUSES = ['未开始', '确认中', '实现中', '待验收', '验收中', '已完成']
const VIEWER_STATUS_BY_INDEX = [0, 1, 1, 1, 1, 2, 3, 4, 5]
function vSplitRow(line) {
  const s = line.trim()
  if (s.startsWith('|') && s.endsWith('|')) return s.slice(1, -1).split('|').map((x) => x.trim())
  return s.split('|').map((x) => x.trim())
}
function vParseBlocks(lines) {
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (!line) { i++; continue }
    if (line.startsWith('# ')) { i++; continue }
    if (line.startsWith('### ')) { blocks.push({ t: 'h3', text: line.slice(4).trim() }); i++; continue }
    if (line.startsWith('## ')) { blocks.push({ t: 'h2', text: line.slice(3).trim() }); i++; continue }
    if (line.startsWith('|')) {
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(vSplitRow(lines[i])); i++ }
      blocks.push({ t: 'table', rows: rows.filter((r) => !(r.length && r.every((c) => /^-+$/.test(c)))) })
      continue
    }
    if (/^-\s*\[[ x]\]\s/.test(line)) {
      const items = []
      while (i < lines.length && /^-\s*\[[ x]\]\s/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^-\s*\[([ x])\]\s*(.*)$/)
        items.push({ checked: m[1] === 'x', text: m[2] })
        i++
      }
      blocks.push({ t: 'checklist', items })
      continue
    }
    if (line.startsWith('- ')) {
      const items = []
      while (i < lines.length && lines[i].trim().startsWith('- ') && !/^-\s*\[[ x]\]\s/.test(lines[i].trim())) { items.push(lines[i].trim().slice(2)); i++ }
      blocks.push({ t: 'ul', items })
      continue
    }
    if (line.startsWith('> ')) {
      const text = []
      while (i < lines.length && lines[i].trim().startsWith('> ')) { text.push(lines[i].trim().slice(2)); i++ }
      blocks.push({ t: 'quote', text: text.join(' ') })
      continue
    }
    if (/^(`{3,}|~{3,})\s*/.test(line)) {
      const fence = line.match(/^(`{3,}|~{3,})\s*(.*)$/)
      const lang = (fence[2] || '').trim()
      const body = []
      i++
      while (i < lines.length && !/^(`{3,}|~{3,})\s*$/.test(lines[i].trim())) { body.push(lines[i]); i++ }
      i++
      blocks.push({ t: 'code', lang, text: body.join('\n') })
      continue
    }
    const text = []
    while (i < lines.length) {
      const l = lines[i].trim()
      if (!l || l.startsWith('#') || l.startsWith('|') || l.startsWith('-') || l.startsWith('>')) break
      text.push(l); i++
    }
    blocks.push({ t: 'p', text: text.join(' ') })
  }
  return blocks
}
function vParseWorksheet(content, file) {
  const lines = content.split(/\r?\n/)
  const title = (lines[0] || '').replace(/^#\s*任务工作单[:：]\s*/, '').trim() || file.replace(/\.md$/, '')
  const blocks = vParseBlocks(lines)
  const checklist = blocks.find((b) => b.t === 'checklist')
  const progress = checklist ? { total: checklist.items.length, checked: checklist.items.filter((x) => x.checked).length, items: checklist.items } : { total: 0, checked: 0, items: [] }
  const status = VIEWER_STATUSES[VIEWER_STATUS_BY_INDEX[Math.min(progress.checked, 8)]] || '未开始'
  const basic = {}
  for (let idx = 0; idx < blocks.length; idx++) {
    if (blocks[idx].t === 'h2' && blocks[idx].text.indexOf('基本信息') >= 0) {
      for (let j = idx + 1; j < blocks.length; j++) {
        if (blocks[j].t === 'table') {
          blocks[j].rows.forEach((r) => { if (r[0]) basic[r[0]] = r[1] || '' })
          break
        }
      }
      break
    }
  }
  return { file, title, id: basic['任务编号'] || file.replace(/\.md$/, ''), date: (basic['任务编号'] || '').match(/T-(\d{8})/)?.[1] || '', status, progress, blocks }
}
const VIEWER_CSS = ':root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#1f2733;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.7}.wrap{max-width:980px;margin:0 auto;padding:0 20px 64px}header{position:sticky;top:0;z-index:20;background:rgba(245,246,248,.92);backdrop-filter:blur(8px);border-bottom:1px solid #e2e6ec}header .wrap{display:flex;align-items:baseline;gap:14px;padding-top:14px;padding-bottom:14px}header h1{margin:0;font-size:19px}header .stats{color:#6b7686;font-size:13px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 16px;align-items:center}.search{flex:1;min-width:200px;padding:9px 14px;border:1px solid #e2e6ec;border-radius:9px;background:#fff;font-size:14px;outline:none}.search:focus{border-color:#2563eb}.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{border:1px solid #e2e6ec;background:#fff;border-radius:999px;padding:5px 13px;font-size:13px;cursor:pointer}.chip.on{background:#2563eb;color:#fff;border-color:#2563eb}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}.card{background:#fff;border:1px solid #e2e6ec;border-radius:12px;padding:16px 18px;cursor:pointer;transition:border-color .15s,box-shadow .15s}.card:hover{border-color:#2563eb;box-shadow:0 4px 14px rgba(37,99,235,.12)}.card .id{font-size:12px;color:#6b7686;font-family:"SF Mono",Consolas,monospace}.card h3{margin:4px 0 8px;font-size:15.5px}.card .meta{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:#6b7686}.tag{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}.t-未开始{background:#f1f3f6;color:#6b7686}.t-确认中{background:#fef3c7;color:#92400e}.t-实现中{background:#dbeafe;color:#1d4ed8}.t-待验收{background:#e9d5ff;color:#6b21a8}.t-验收中{background:#fde68a;color:#a16207}.t-已完成{background:#dcfce7;color:#15803d}.bar{height:5px;background:#eef2f7;border-radius:3px;overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;background:#2563eb}.back{display:inline-block;margin:18px 0 10px;border:1px solid #e2e6ec;background:#fff;border-radius:9px;padding:7px 16px;font-size:13.5px;cursor:pointer}.detail{background:#fff;border:1px solid #e2e6ec;border-radius:14px;padding:26px 30px;margin-bottom:30px}.detail h1{font-size:22px;margin:0 0 4px}.detail .sub{color:#6b7686;font-size:13px;margin-bottom:16px}.detail h2{font-size:16.5px;border-bottom:1px solid #e2e6ec;padding-bottom:6px;margin:26px 0 10px}.detail p{margin:8px 0}.detail blockquote{border-left:3px solid #c7d8ff;background:#f7f9fd;margin:10px 0;padding:8px 14px;border-radius:0 8px 8px 0;color:#4b5563;font-size:13.5px}.detail table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13.5px}.detail th,.detail td{border:1px solid #e2e6ec;padding:7px 10px;text-align:left;vertical-align:top}.detail th{background:#f7f8fa;font-weight:600}.detail th.nowrap,.detail td.nowrap{white-space:nowrap}.detail ul{margin:8px 0;padding-left:22px}.detail .checks{list-style:none;padding-left:0}.detail .checks li{display:flex;align-items:center;gap:9px;padding:5px 0}.detail .box{width:17px;height:17px;border:1.5px solid #c3ccd6;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex:0 0 auto}.detail .checks li.on .box{background:#2563eb;border-color:#2563eb;color:#fff}.detail .checks li.on{color:#6b7686}.progress-line{display:flex;align-items:center;gap:10px;margin:10px 0 4px}.scene{display:inline-block;border-radius:6px;padding:0 7px;font-size:12px;font-weight:600;white-space:nowrap}.scene.norm{background:#dcfce7;color:#15803d}.scene.edge{background:#fef3c7;color:#92400e}.scene.err{background:#fee2e2;color:#b91c1c}.empty{text-align:center;color:#9aa4b2;padding:50px 0}@media (prefers-color-scheme:dark){body{background:#12161c;color:#dfe4ec}header{background:rgba(18,22,28,.92);border-color:#2a323e}.search,.card,.detail,.back,.chip{background:#1a202a;border-color:#2a323e;color:#dfe4ec}.card:hover{border-color:#5c8def}.detail th{background:#202833}.detail table th,.detail table td{border-color:#2a323e}.detail blockquote{background:#161c25;border-color:#2a4a8f;color:#aab4c2}.bar{background:#202833}.t-未开始{background:#202833;color:#96a1b0}.t-确认中{background:#3a2f14;color:#f0c46a}.t-实现中{background:#16233f;color:#8ab0ff}.t-待验收{background:#2a1f3a;color:#c9a0f0}.t-验收中{background:#3a3214;color:#f0d06a}.t-已完成{background:#14301f;color:#7fd6a0}.scene.norm{background:#14301f;color:#7fd6a0}.scene.edge{background:#3a2f14;color:#f0c46a}.scene.err{background:#3a1f22;color:#f0a0a0}}'
const VIEWER_EXTRA_CSS = 'pre.code{background:#0f172a;color:#e2e8f0;border:1px solid #1e293b;border-radius:10px;padding:14px 16px;overflow:auto;font-family:"SF Mono",Consolas,"Cascadia Code",monospace;font-size:13px;line-height:1.6;margin:10px 0}pre.code code{background:none;color:inherit;padding:0;border-radius:0;font-size:inherit}code{background:#eef1f5;color:#c2410c;border-radius:5px;padding:1px 6px;font-family:"SF Mono",Consolas,"Cascadia Code",monospace;font-size:.88em}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}blockquote{border-left:3px solid #cbd5e1;margin:10px 0;padding:2px 14px;color:#6b7686;background:#f8fafc;border-radius:0 8px 8px 0}strong{font-weight:700}'
function buildViewerHtml(worksheets, selectedFile) {
  const data = JSON.stringify(worksheets.map((w) => ({
    file: w.file, title: w.title, id: w.id, date: w.date, status: w.status, progress: w.progress, blocks: w.blocks
  })))
  const js = `var DATA = ${data};
var STATUSES = ['全部','未开始','确认中','实现中','待验收','验收中','已完成'];
var INITIAL_FILE = ${JSON.stringify(selectedFile || '')};
var state = { query: '', status: '全部', current: null };
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function sceneTag(cell){if(cell==='正常')return '<span class="scene norm">正常</span>';if(cell==='边界')return '<span class="scene edge">边界</span>';if(cell==='错误')return '<span class="scene err">错误</span>';return esc(cell);}
function md(s){s=String(s==null?'':s);if(window.marked&&window.marked.parseInline){try{return window.marked.parseInline(s);}catch(e){}}return esc(s);}
function renderBlocks(blocks){return blocks.map(function(b){switch(b.t){case 'h2':return '<h2>'+md(b.text)+'</h2>';case 'h3':return '<h3 style="font-size:14.5px;margin:18px 0 6px;color:#2563eb">'+md(b.text)+'</h3>';case 'p':return '<p>'+md(b.text)+'</p>';case 'quote':return '<blockquote>'+md(b.text)+'</blockquote>';case 'ul':return '<ul>'+b.items.map(function(x){return '<li>'+md(x)+'</li>';}).join('')+'</ul>';case 'checklist':return '<ul class="checks">'+b.items.map(function(x){return '<li class="'+(x.checked?'on':'')+'"><span class="box">'+(x.checked?'✓':'')+'</span>'+md(x.text)+'</li>';}).join('')+'</ul>';case 'code':return '<pre class="code'+(b.lang?' lang-'+esc(b.lang):'')+'"><code>'+esc(b.text)+'</code></pre>';case 'table':var head=b.rows[0]||[];var rows=b.rows.slice(1);var nwh=[];for(var hi=0;hi<head.length;hi++){if(head[hi]==='序号'||head[hi]==='所属切片')nwh.push(hi);}var nwb=[];for(var ni=0;ni<head.length;ni++){if(head[ni]==='依赖'||head[ni]==='状态'||head[ni]==='所属切片')nwb.push(ni);}return '<table><thead><tr>'+head.map(function(h,hi){return '<th'+(nwh.indexOf(hi)>=0?' class="nowrap"':'')+'>'+esc(h)+'</th>';}).join('')+'</tr></thead><tbody>'+rows.map(function(r){return '<tr>'+r.map(function(c,i){return '<td'+(nwb.indexOf(i)>=0?' class="nowrap"':'')+'>'+sceneTag(c)+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table>';default:return '';}}).join('');}
function renderDetail(w){var pb=w.blocks.find(function(b){return b.t==='checklist';});var bar=pb?'<div class="progress-line"><span class="tag t-'+w.status+'">'+w.status+'</span><div class="bar" style="flex:1"><i style="width:'+(w.progress.total?Math.round(w.progress.checked/w.progress.total*100):0)+'%"></i></div><span style="font-size:12.5px;color:#6b7686">'+w.progress.checked+'/'+w.progress.total+'</span></div>':'';document.getElementById('app').innerHTML='<button class="back" id="back">← 返回列表</button><div class="detail"><h1>'+esc(w.title)+'</h1><div class="sub">'+esc(w.id)+(w.date?' · '+esc(w.date):'')+'</div>'+bar+renderBlocks(w.blocks)+'</div>';window.scrollTo({top:0});var b=document.getElementById('back');if(b)b.addEventListener('click',function(){state.current=null;if(history.replaceState)history.replaceState(null,'',location.pathname);render();});}
function renderList(){var q=state.query.trim();var list=DATA.filter(function(w){return (state.status==='全部'||w.status===state.status)&&(!q||w.title.indexOf(q)>=0||w.id.indexOf(q)>=0);});var stats={};DATA.forEach(function(w){stats[w.status]=(stats[w.status]||0)+1;});document.getElementById('stats').textContent='共 '+DATA.length+' 张 · '+STATUSES.slice(1).map(function(s){return s+' '+(stats[s]||0);}).join(' · ');var chips=STATUSES.map(function(s){return '<button class="chip'+(state.status===s?' on':'')+'" data-status="'+s+'">'+s+'</button>';}).join('');var cards=list.length?'<div class="grid">'+list.map(function(w,i){return '<div class="card" data-idx="'+i+'"><div class="id">'+esc(w.id)+'</div><h3>'+esc(w.title)+'</h3><div class="meta"><span class="tag t-'+w.status+'">'+w.status+'</span><span>'+(w.progress.total?w.progress.checked+'/'+w.progress.total:'')+'</span></div><div class="bar"><i style="width:'+(w.progress.total?Math.round(w.progress.checked/w.progress.total*100):0)+'%"></i></div></div>';}).join('')+'</div>':'<div class="empty">没有匹配的工作单</div>';document.getElementById('app').innerHTML='<div class="toolbar"><input class="search" id="search" placeholder="搜索标题 / 编号…" value="'+esc(state.query)+'"><div class="chips">'+chips+'</div></div>'+cards;var si=document.getElementById('search');if(si)si.addEventListener('input',function(){state.query=this.value;renderList();});var cs=document.querySelectorAll('.chip');Array.prototype.forEach.call(cs,function(bt){bt.addEventListener('click',function(){state.status=this.getAttribute('data-status');render();});});var cds=document.querySelectorAll('.card');Array.prototype.forEach.call(cds,function(cd){cd.addEventListener('click',function(){state.current=Number(cd.getAttribute('data-idx'));if(history.replaceState)history.replaceState(null,'',location.pathname+'?file='+encodeURIComponent(DATA[state.current].file));render();});});}
function render(){if(state.current!==null&&DATA[state.current])renderDetail(DATA[state.current]);else if(INITIAL_FILE){var i=DATA.findIndex(function(w){return w.file===INITIAL_FILE;});INITIAL_FILE='';if(i>=0){state.current=i;renderDetail(DATA[i]);}else renderList();}else renderList();}
render();`
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>工作单查看器</title><style>' + VIEWER_CSS + VIEWER_EXTRA_CSS + '</style><script src="/workorders-vendor/marked.min.js"></script></head><body><header><div class="wrap"><h1>📋 工作单查看器</h1><div class="stats" id="stats"></div></div></header><main class="wrap"><div id="app"></div></main><script>' + js + '</script></body></html>'
}
async function buildViewer(cwd, selectedFile, fs) {
  const scan = await scanWorkorders(cwd, fs)
  const worksheets = []
  for (const f of scan.files) {
    const text = await safeReadText(cwd, WORKDIR + '/' + f.name, fs)
    if (text === null) continue
    worksheets.push(vParseWorksheet(text, f.name))
  }
  return buildViewerHtml(worksheets, selectedFile)
}
function queryParam(url, key) {
  const q = (url || '').split('?')[1] || ''
  for (const part of q.split('&')) {
    const eq = part.indexOf('=')
    const k = eq >= 0 ? part.slice(0, eq) : part
    if (k === key) {
      const v = eq >= 0 ? part.slice(eq + 1) : ''
      try { return decodeURIComponent(v) } catch { return v }
    }
  }
  return ''
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
// 勾选工作单进度清单中的一项（如「工作单整体评审通过」「最终验收」）。
// 插件写工作单文件是用户明确决定的行为；写入显式携带 workspace-write 策略。
async function checkBox(cwd, file, label, fs) {
  const rel = WORKDIR + '/' + file
  const target = await fs.resolve(rel, { cwd })
  const text = await fs.readText(target)
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('^(\\s*-\\s*)\\[ \\](' + esc + '\\s*)$', 'm')
  const m = text.match(re)
  if (!m) return false
  await fs.editText(target, { oldString: m[0], newString: m[1] + '[x]' + m[2] }, undefined, undefined, { mode: 'workspace-write', workspaceRoot: cwd })
  return true
}

// ---------- plugin ----------
export function apply(ctx) {
  const fs = ctx.fs
  const sessions = ctx.get('sessions')
  const webServer = ctx.get('webServer')

  const sendHtml = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
  }
  const sendJson = (res, obj, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  if (webServer && typeof webServer.register === 'function') {
    // HTML 查看器
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/workorders-viewer',
      handler: async (req, res) => {
        try {
          const cwd = cache.cwd
          if (!cwd) { sendHtml(res, '<meta charset="utf-8"><h3>工作单查看器</h3><p>尚未确定工作区：请先打开工作单助手面板一次。</p>'); return }
          const html = await buildViewer(cwd, queryParam(req.url, 'file'), fs)
          sendHtml(res, html)
        } catch (err) {
          sendHtml(res, '生成查看器失败: ' + String((err && err.message) || err), 500)
        }
      }
    }))
    // 本地 markdown 解析器（marked, MIT）—— 查看器页面在浏览器端用它渲染
    if (MARKED_PATH) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/workorders-vendor/marked.min.js',
        handler: async (req, res) => {
          try {
            const text = await fs.readText(MARKED_PATH)
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
            res.end(text)
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('vendor marked 缺失: ' + String((err && err.message) || err))
          }
        }
      }))
    }
    // 数据 API：GET ?sessionId=xxx → 工作单状态 JSON；POST {sessionId, worksheet, kind} → 勾选对应项
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/workorders-api',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const body = await readBody(req)
            let data = {}
            try { data = JSON.parse(body || '{}') } catch { data = {} }
            const sessionId = data.sessionId
            const worksheet = data.worksheet
            if (!sessionId || !worksheet) { sendJson(res, { ok: false, error: '缺少 sessionId/worksheet' }, 400); return }
            const cwd = await cwdOf(sessions, sessionId)
            const label = data.kind === 'review' ? '工作单整体评审通过' : '最终验收'
            await checkBox(cwd, worksheet, label, fs)
            const state = await refresh(cwd, fs)
            sendJson(res, { ok: true, state })
            return
          }
          const sessionId = queryParam(req.url, 'sessionId')
          if (!sessionId) { sendJson(res, { ok: false, error: '缺少 sessionId' }, 400); return }
          const cwd = await cwdOf(sessions, sessionId)
          const state = await refresh(cwd, fs)
          sendJson(res, { ok: state.ok !== false, state })
        } catch (err) {
          sendJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
      }
    }))
  }

  // AI 写/改 workorders/ → 立即全量重扫（与轮询同一套逻辑）
  ctx.on('tools/result', (exec) => {
    try {
      const name = exec && exec.name
      if (name !== 'write' && name !== 'edit') return
      const args = (exec && (exec.arguments || exec.input)) || {}
      const filePath = args.file_path
      if (!filePath) return
      const agent = exec.agent
      const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
      if (!cwd) return
      const p = lower(filePath)
      const prefix = lower(cwd).replace(/\/+$/, '') + '/workorders/'
      if (p.indexOf(prefix) < 0 && p.indexOf('/workorders/') < 0) return
      refresh(cwd, fs).catch(() => {})
    } catch { /* watcher is best-effort */ }
  })
}
