// dsh-workflow-assistant — 客户端 Web 模块
// 格式：window.__ModuleLoader__.load({ id, factory })；导出 { apply, inject }。
// 与动态版差异：数据经 fetch 调 /workorders-api；确认消息经
// sessions.scope(id).get('conversation').send() 直发（静态模块无 guard 限制）。

window.__ModuleLoader__.load({
  id: 'dsh-workflow-assistant',
  factory: (require) => {
    "use strict";
    const React = require("react");

    const inject = ["sessions", "slots", "timer"];

    const store = {
      sessionId: null,
      state: null,
      panelOpen: false,
      tab: 'todos',
      sending: false,
      error: null,
      inputActions: null,
      version: 0
    };
    const listeners = new Set();
    function emit() { store.version++; for (const fn of Array.from(listeners)) { try { fn() } catch {} } }
    function subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } }
    function getVersion() { return store.version }
    function useStore() {
      if (React.useSyncExternalStore) return React.useSyncExternalStore(subscribe, getVersion);
      const [v, setV] = React.useState(store.version);
      React.useEffect(() => subscribe(() => setV(store.version)), []);
      return v;
    }

    const PANEL_W = 480;
    let sessionsSvc = null;
    let refreshToken = 0;

    async function fetchState(sid) {
      const res = await fetch('/workorders-api?sessionId=' + encodeURIComponent(sid));
      return res.json();
    }
    async function refresh() {
      const sid = store.sessionId;
      if (!sid) return;
      const token = ++refreshToken;
      try {
        const res = await fetchState(sid);
        if (token !== refreshToken || store.sessionId !== sid) return;
        if (!res || !res.ok) { store.error = (res && res.error) || 'getState failed'; emit(); return }
        store.state = res.state;
        store.error = res.state.error || null;
        emit();
      } catch (err) {
        if (token === refreshToken && store.sessionId === sid) {
          store.error = String((err && err.message) || err);
          emit();
        }
      }
    }

    function worksheetTitle(file) {
      const s = store.state;
      if (!s || !s.worksheets) return file;
      const w = s.worksheets.find((x) => x.file === file);
      if (!w) return file;
      return (w.title || '未命名') + (w.taskId ? '（' + w.taskId + '）' : '');
    }
    function approveText(todo) {
      const name = worksheetTitle(todo.worksheet);
      if (todo.kind === 'review-pending') return '✅ 工作单「' + name + '」评审通过，请按计划继续。';
      return '✅ 工作单「' + name + '」验收通过，请收尾并交付。';
    }
    function rejectText(todo) {
      const name = worksheetTitle(todo.worksheet);
      if (todo.kind === 'review-pending') return '✗ 工作单「' + name + '」评审未通过，请根据我的意见修改工作单后重新提交评审：';
      return '✗ 工作单「' + name + '」验收未通过，请根据验收意见修复后重新提交验收：';
    }
    function openViewer(file) {
      try {
        window.open(window.location.origin + '/workorders-viewer?file=' + encodeURIComponent(file), '_blank');
      } catch (err) {
        store.error = String((err && err.message) || err);
        emit();
      }
    }

    async function actTodo(todo, action) {
      if (store.sending) return;
      store.sending = true;
      emit();
      try {
        if (action === 'approve') {
          // ① 插件直接勾选工作单对应项（评审→工作单整体评审通过；验收→最终验收）
          //    待办由文件状态推导，勾选后立即消失，无需等 AI 响应。
          const r = await fetch('/workorders-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: store.sessionId,
              worksheet: todo.worksheet,
              kind: todo.kind === 'review-pending' ? 'review' : (todo.kind === 'deliver-pending' ? 'deliver' : 'accept')
            })
          });
          const j = await r.json();
          if (!j || !j.ok) throw new Error((j && j.error) || '勾选失败');
          // ② 评审/验收通过时通过对话框发送确认文案；交付确认直接勾选完成，不打扰 AI
          if (todo.kind !== 'deliver-pending') {
            const scoped = sessionsSvc ? sessionsSvc.scope(store.sessionId) : undefined;
            const conversation = scoped ? scoped.get('conversation') : undefined;
            if (!conversation || typeof conversation.send !== 'function') throw new Error('对话通道不可用');
            await conversation.send(approveText(todo));
          }
          // ③ 关闭插件面板
          store.panelOpen = false;
          store.tab = 'todos';
        } else {
          // 打回/验收未通过：预填输入框供补充原因，并关闭面板
          if (store.inputActions && typeof store.inputActions.setDraft === 'function') {
            store.inputActions.setDraft(rejectText(todo));
          } else {
            store.error = '输入框不可用，无法预填文案';
          }
          store.panelOpen = false;
          store.tab = 'todos';
        }
        await refresh();
      } catch (err) {
        store.error = String((err && err.message) || err);
      } finally {
        store.sending = false;
        emit();
      }
    }
    function togglePanel() {
      store.panelOpen = !store.panelOpen;
      if (!store.panelOpen) { store.tab = 'todos' } else { refresh() }
      emit();
    }
    function switchTab(tab) { store.tab = tab; emit() }
    function resetForSession() {
      store.state = null;
      store.panelOpen = false;
      store.tab = 'todos';
      store.inputActions = null;
      store.error = null;
    }

    // ---------- styles ----------
    const CSS = '.wo-capsule{position:fixed;right:16px;bottom:16px;pointer-events:auto;z-index:2100;display:flex;align-items:center;gap:8px;max-width:340px;padding:8px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#333);background:var(--dsw-alias-bg-overlay,#1e1f24);color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.4;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.22)}' +
      '.wo-capsule:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff)}' +
      '.wo-panel{position:fixed;pointer-events:auto;z-index:2150;width:480px;max-width:calc(100vw - 24px);height:min(680px,calc(100vh - 24px));min-height:300px;background:var(--dsw-alias-bg-layer-1,#232429);border:1px solid var(--dsw-alias-border-l1,#333);border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.22);display:flex;flex-direction:column;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#eee);overflow:hidden}' +
      '.wo-panel-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#333)}' +
      '.wo-panel-title{font-weight:600;font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.wo-tabs{display:flex;gap:4px;padding:8px 14px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#333);flex:none}' +
      '.wo-tab{cursor:pointer;background:transparent;border:none;color:var(--dsw-alias-label-secondary,#999);font-size:13px;padding:6px 12px;border-radius:8px 8px 0 0;border-bottom:2px solid transparent}' +
      '.wo-tab-active{color:var(--dsw-alias-label-primary,#eee);border-bottom-color:var(--dsw-alias-brand-primary,#4c8dff)}' +
      '.wo-body{flex:1;overflow:auto;padding:12px 14px}' +
      '.wo-refresh-row{display:flex;justify-content:flex-end;margin-bottom:8px}' +
      '.wo-todo{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-2,#1f2126)}' +
      '.wo-todo-title{font-weight:600;font-size:13px}' +
      '.wo-todo-note{color:var(--dsw-alias-label-secondary,#999);font-size:12px}' +
      '.wo-todo-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}' +
      '.wo-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#444);background:var(--dsw-alias-bg-layer-2,#26282e);color:var(--dsw-alias-label-primary,#eee);border-radius:8px;padding:4px 12px;font-size:12px}' +
      '.wo-btn:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff)}' +
      '.wo-btn-primary{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent;color:#fff}' +
      '.wo-btn-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}' +
      '.wo-empty{color:var(--dsw-alias-label-secondary,#999);font-size:12px;padding:12px 4px}' +
      '.wo-file{cursor:pointer;padding:8px 10px;border-radius:8px;border:1px solid transparent;font-size:12px;color:var(--dsw-alias-label-secondary,#999);margin-bottom:4px;display:flex;align-items:center;gap:8px;justify-content:space-between}' +
      '.wo-file:hover{border-color:var(--dsw-alias-border-l1,#333)}' +
      '.wo-file-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.wo-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--dsw-alias-border-l1,#333);color:var(--dsw-alias-label-secondary,#999);flex:none}' +
      '.wo-badge-warn{color:var(--dsw-alias-state-warn-primary,#e5a50a);border-color:currentColor}' +
      '.wo-badge-ok{color:var(--dsw-alias-state-success-primary,#2fbf71);border-color:currentColor}' +
      '.wo-muted{color:var(--dsw-alias-label-secondary,#999)}' +
      '.wo-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;margin-top:6px}' +
      '.wo-close{cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l1,#333);color:var(--dsw-alias-label-secondary,#999);border-radius:8px;padding:3px 10px;font-size:12px;flex:none}';

    const STYLE_ID = 'wrkflw-styles';
    function adoptStyles() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const el = React.createElement;
    function chip(text, cls) { return el('span', { className: 'wo-badge ' + (cls || '') }, text) }

    function todosOf(state) { return (state && state.todos) || [] }

    // 状态 = 勾选数映射：0 未开始 · 1-4 确认中 · 5 实现中 · 6 待验收 · 7 验收中 · 8 已完成
    function statusOf(w) {
      const c = w.progress.done;
      if (w.progress.total > 0 && c === w.progress.total) return { text: '已完成', cls: 'wo-badge-ok' };
      if (c <= 0) return { text: '未开始', cls: '' };
      if (c <= 4) return { text: '确认中', cls: '' };
      if (c === 5) return { text: '实现中', cls: '' };
      if (c === 6) return { text: '验收中', cls: 'wo-badge-warn' };
      if (c === 7) return { text: '待交付', cls: 'wo-badge-warn' };
      return { text: '已完成', cls: 'wo-badge-ok' };
    }

    function TodoItem(props) {
      const todo = props.todo;
      const busy = store.sending;
      const actions = (todo.kind === 'review-pending')
        ? [
            el('button', { key: 'rb', className: 'wo-btn wo-btn-danger', disabled: busy, onClick: () => actTodo(todo, 'reject') }, '✗ 打回'),
            el('button', { key: 'ra', className: 'wo-btn wo-btn-primary', disabled: busy, onClick: () => actTodo(todo, 'approve') }, '✓ 通过')
          ]
        : (todo.kind === 'deliver-pending')
          ? [
              el('button', { key: 'da', className: 'wo-btn wo-btn-primary', disabled: busy, onClick: () => actTodo(todo, 'approve') }, '✓ 确认交付')
            ]
          : [
              el('button', { key: 'ab', className: 'wo-btn wo-btn-danger', disabled: busy, onClick: () => actTodo(todo, 'reject') }, '✗ 验收未通过'),
              el('button', { key: 'aa', className: 'wo-btn wo-btn-primary', disabled: busy, onClick: () => actTodo(todo, 'approve') }, '✓ 验收通过')
            ];
      return el('div', { className: 'wo-todo' },
        el('div', { className: 'wo-todo-title' }, todo.title),
        el('div', { className: 'wo-todo-note' }, todo.note),
        el('div', { className: 'wo-muted', style: { fontSize: 12 } }, '工作单：' + worksheetTitle(todo.worksheet)),
        el('div', { className: 'wo-todo-actions' },
          el('button', { className: 'wo-btn', disabled: busy, onClick: () => openViewer(todo.worksheet) }, '查看'),
          actions));
    }

    function WorksheetList() {
      const s = store.state;
      if (!s) return el('div', { className: 'wo-empty' }, '加载中…');
      if (!s.worksheets || s.worksheets.length === 0) return el('div', { className: 'wo-empty' }, '暂无工作单（workorders/ 下没有 T-YYYYMMDD-xxx.md）。');
      return el('div', null,
        el('div', { className: 'wo-refresh-row' },
          el('button', { className: 'wo-btn', onClick: () => refresh() }, '🔄 更新')),
        s.worksheets.map((w) => {
          const st = statusOf(w);
          return el('div', { key: w.file, className: 'wo-file', onClick: () => openViewer(w.file) },
            el('span', { className: 'wo-file-name' }, w.file),
            chip(st.text, st.cls));
        }));
    }

    function TodosPanel() {
      const todos = todosOf(store.state);
      if (todos.length === 0) return el('div', { className: 'wo-empty' }, '暂无待办。有需要你评审或交付确认的操作时会出现在这里。');
      return el('div', null, todos.map((t) => el(TodoItem, { key: t.key, todo: t })));
    }

    function Panel() {
      useStore();
      const todos = todosOf(store.state);
      const w = Math.min(PANEL_W, window.innerWidth - 24);
      const h = Math.min(680, window.innerHeight - 24);
      const top = Math.max(16, Math.round((window.innerHeight - h) / 2));
      const left = Math.max(16, window.innerWidth - w - 16);
      return el('div', { className: 'wo-panel', style: { left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' } },
        el('div', { className: 'wo-panel-head' },
          el('span', { className: 'wo-panel-title' }, '📋 工作单助手'),
          store.error && el('span', { className: 'wo-error' }, store.error),
          el('button', { className: 'wo-close', onClick: () => togglePanel() }, '关闭')),
        el('div', { className: 'wo-tabs' },
          el('button', { className: 'wo-tab ' + (store.tab === 'todos' ? 'wo-tab-active' : ''), onClick: () => switchTab('todos') }, '待办' + (todos.length ? ' ' + todos.length : '')),
          el('button', { className: 'wo-tab ' + (store.tab === 'work' ? 'wo-tab-active' : ''), onClick: () => switchTab('work') }, '工作单')),
        el('div', { className: 'wo-body' },
          store.tab === 'todos' ? el(TodosPanel) : el(WorksheetList)));
    }

    function Capsule() {
      useStore();
      const s = store.state;
      if (!s) return null;
      if (!s.hasWorkflow) return null;
      const todos = todosOf(s);
      const label = todos.length > 0 ? '📋 有 ' + todos.length + ' 项待办' : '📋 暂无待办';
      return el('button', { className: 'wo-capsule', onClick: () => togglePanel() },
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label));
    }

    function Overlay(props) {
      useStore();
      const useSessions = props.useSessions;
      const sessionId = useSessions((s) => s.current);
      React.useEffect(() => {
        if (!sessionId) {
          store.sessionId = null;
          resetForSession();
          emit();
          return;
        }
        if (store.sessionId !== sessionId) {
          store.sessionId = sessionId;
          resetForSession();
          emit();
          refresh();
        }
      }, [sessionId]);
      const s = store.state;
      const showWidget = !!s && !!s.hasWorkflow;
      return el('div', null,
        showWidget && el(Capsule),
        showWidget && store.panelOpen && el(Panel));
    }

    // 输入桥：捕获 inputActions（打回预填）+ 监听对话节点变化（AI 活动即重扫）
    function InputBridge(props) {
      if (props && props.inputActions) store.inputActions = props.inputActions;
      const useSession = props.useSession;
      const nodeCount = typeof useSession === 'function'
        ? useSession((s) => (s && s.chat && s.chat.nodes ? s.chat.nodes.size : 0))
        : 0;
      React.useEffect(() => { refresh() }, [nodeCount]);
      return null;
    }

    function apply(ctx) {
      adoptStyles();
      sessionsSvc = ctx.sessions;
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'wrkflw-widget', order: 95, label: '工作单助手小组件'
      }, (props) => el(Overlay, props)));
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'wrkflw-inputbridge', order: 300, label: '工作单助手输入桥'
      }, (props) => el(InputBridge, props)));
      ctx.timer.interval(() => refresh(), 60000);
      refresh();
    }

    return { apply, inject };
  }
});
