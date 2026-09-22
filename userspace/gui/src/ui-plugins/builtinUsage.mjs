const css = `
.dc-usage {position:absolute;pointer-events:auto;width:max-content;font:12px var(--dc-font-ui,system-ui);color:var(--dc-foreground);max-width:min(320px,calc(100% - 32px))}
.dc-usage button {font:inherit;color:inherit;cursor:pointer;border:0;background:transparent;border-radius:8px;padding:9px;text-align:left}
.dc-usage button:hover {background:var(--dc-surface-hover)}
.dc-usage__summary {display:flex;align-items:center;min-width:182px;max-width:100%;background:var(--dc-surface-raised);border:1px solid var(--dc-border);border-radius:12px;box-shadow:0 3px 14px #0000000c}
.dc-usage__body {flex:1;min-width:0;display:grid;gap:4px}.dc-usage strong{font-weight:600}.dc-usage small{color:var(--dc-muted);font-size:11px}
.dc-usage__body small {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dc-usage [data-usage-drag] {cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
.dc-usage[data-dragging] [data-usage-drag] {cursor:grabbing}
.dc-usage__details,.dc-usage__menu {position:absolute;box-sizing:border-box;overflow:auto;background:var(--dc-surface-raised);border:1px solid var(--dc-border);box-shadow:0 6px 24px #00000010;border-radius:12px;padding:14px;width:260px;max-width:calc(var(--dc-usage-boundary-width) - 32px)}
.dc-usage__line {display:flex;justify-content:space-between;gap:12px;margin:10px 0}.dc-usage__menu {width:180px;padding:5px}.dc-usage__menu button {display:block;width:100%}
.dc-usage__chart {height:48px;display:flex;gap:3px;align-items:end;margin-top:14px}.dc-usage__chart i{flex:1;background:var(--dc-accent);opacity:.6;min-height:1px;border-radius:2px}
.dc-usage__error {color:var(--dc-danger);overflow-wrap:anywhere}.dc-usage__handle{background:var(--dc-surface-raised)!important;border:1px solid var(--dc-border)!important;border-radius:8px 0 0 8px!important}
`;
export default { apply(context) {
  context.addStyle(css);
  context.register('usage.widget', (container, initial, scope) => {
    let input = initial, request, requestKey = '', data = null, error = '', loading = false, menu = false, timer;
    let position = null, drag = null, suppressClick = false;
    const root = document.createElement('section'); root.className = 'dc-usage'; container.append(root);
    const zh = () => input.locale === 'zh-CN';
    const text = (cn,en) => zh() ? cn : en;
    const node = (tag, content, cls) => { const el = document.createElement(tag); if (content != null) el.textContent = content; if(cls) el.className = cls; return el; };
    const button = (label, action, cls) => { const el = node('button', label, cls); el.type='button'; el.onclick=action; return el; };
    const money = value => new Intl.NumberFormat(input.locale,{style:'currency',currency:'USD',maximumFractionDigits:4}).format(value);
    const remaining = window => `${Math.max(0, Math.min(100, 100-window.usedPercent)).toFixed(0)}%`;
    const line = (parent,label,value) => { const row=node('div',null,'dc-usage__line'); row.append(node('span',label),node('strong',value));parent.append(row); };
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    function place() {
      if (root.hidden || !container.clientWidth || !container.clientHeight) return;
      const width = container.clientWidth, height = container.clientHeight;
      root.style.setProperty('--dc-usage-boundary-width', `${width}px`);
      const box = root.getBoundingClientRect();
      // Keep the summary's vertical center when docking to the page edge.
      position ??= { x: width - box.width - 16, centerY: height - 16 - box.height / 2 };
      const x = input.visibility === 'collapsed' ? width - box.width : clamp(position.x, 8, width - box.width - 8);
      const y = clamp(position.centerY - box.height / 2, 8, height - box.height - 8);
      root.style.left = `${x}px`; root.style.top = `${y}px`;
      for (const panel of root.querySelectorAll('.dc-usage__details,.dc-usage__menu')) {
        panel.style.maxHeight = `${Math.max(0, height - 16)}px`;
        const size = panel.getBoundingClientRect();
        const panelX = clamp(x + box.width - size.width, 8, width - size.width - 8);
        const panelY = y >= size.height + 16 ? y - size.height - 8
          : clamp(y + box.height + 8, 8, height - size.height - 8);
        panel.style.left = `${panelX - x}px`; panel.style.top = `${panelY - y}px`;
      }
    }
    root.addEventListener('pointerdown', event => {
      suppressClick = false;
      if (event.button !== 0 || !event.isPrimary || !event.target.closest('[data-usage-drag]')) return;
      const box = root.getBoundingClientRect(), bounds = container.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: box.left - bounds.left, centerY: box.top - bounds.top + box.height / 2, started: false };
    });
    const move = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.started && Math.hypot(dx, dy) < 4) return;
      if (!drag.started) { drag.started = true; root.setPointerCapture(event.pointerId); root.dataset.dragging = ''; }
      event.preventDefault(); suppressClick = true;
      const box = root.getBoundingClientRect();
      position = { x: clamp(drag.left + dx, 8, container.clientWidth - box.width - 8),
        centerY: clamp(drag.centerY + dy, box.height / 2 + 8, container.clientHeight - box.height / 2 - 8) };
      place();
    };
    const endDrag = event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null; delete root.dataset.dragging;
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    };
    const cancelDrag = () => { if (drag) endDrag({ pointerId: drag.id }); };
    root.addEventListener('lostpointercapture', endDrag);
    root.addEventListener('click', event => {
      if (suppressClick && event.detail > 0) { event.preventDefault(); event.stopPropagation(); }
    }, true);
    root.addEventListener('keydown', event => {
      if (!event.target.closest('[data-usage-drag]') || event.altKey || event.ctrlKey || event.metaKey) return;
      const offset = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[event.key];
      if (!offset || !position) return;
      event.preventDefault(); const step = event.shiftKey ? 40 : 10;
      const box = root.getBoundingClientRect(), bounds = container.getBoundingClientRect();
      position = { x: clamp(box.left - bounds.left + offset[0] * step, 8, container.clientWidth - box.width - 8),
        centerY: clamp(box.top - bounds.top + box.height / 2 + offset[1] * step, box.height / 2 + 8, container.clientHeight - box.height / 2 - 8) };
      place();
    });
    const sizeObserver = new ResizeObserver(place);
    sizeObserver.observe(container); sizeObserver.observe(root);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', cancelDrag);
    function render() {
      root.replaceChildren(); root.hidden = input.visibility === 'hidden' || !input.connection;
      if (root.hidden) { cancelDrag(); return; }
      root.oncontextmenu = event => {event.preventDefault();menu=true;render();};
      if(menu) { const box=node('div',null,'dc-usage__menu');box.setAttribute('role','menu');box.dataset.nativeOverlay='';
        box.append(button(text('浮窗设置','Widget settings'),()=>{menu=false;render();scope.actions.openUsageSettings();}),button(text('隐藏','Hide'),()=>{menu=false;scope.actions.setUsageVisibility('hidden');}));root.append(box); }
      if(input.visibility === 'collapsed') { const el=button('‹',()=>scope.actions.setUsageVisibility('summary'),'dc-usage__handle');el.setAttribute('aria-label',text('显示用量','Show usage'));root.append(el);place();return; }
      const plan = input.connection.billingMode === 'subscription';
      const windows = plan && data?.windows ? [...data.windows].sort((a,b)=>b.windowDurationSeconds-a.windowDurationSeconds) : [];
      const totals = !plan && data?.totals;
      const amount = loading ? '…' : error ? text('暂不可用','Unavailable') : plan ? windows.length ? remaining(windows[0]) : '—' : totals?.estimatedCost != null ? money(totals.estimatedCost) : totals?.calls === 0 ? text('暂无调用','No calls') : text('费用未计价','Unpriced');
      if(input.expanded && !menu) {
        const detail=node('div',null,'dc-usage__details');detail.dataset.nativeOverlay='';
        detail.append(node('strong',plan ? text('剩余额度','Remaining quota') : text('今日用量','Today’s usage')));
        if(error) detail.append(node('p',error,'dc-usage__error'));
        else if(plan) { for(const window of windows) { line(detail,window.label,remaining(window)); if(window.resetsAt) detail.append(node('small',text('重置 ','Resets ')+new Date(window.resetsAt).toLocaleString(input.locale))); } }
        else if(totals) { line(detail,text('费用估算','Estimated cost'),amount);line(detail,text('输入 / 输出','Input / output'),`${totals.inputTokens.toLocaleString()} / ${totals.outputTokens.toLocaleString()}`);line(detail,text('缓存命中','Cached input'),totals.cacheReadTokens.toLocaleString());line(detail,text('调用次数','Calls'),String(totals.calls));
          if(totals.pricedCalls < totals.calls) detail.append(node('small',text('已计价 ','Priced ')+`${totals.pricedCalls}/${totals.calls}`));
          if(data.coverageFrom > data.query.from) detail.append(node('small',text('记录始于 ','Records since ')+new Date(data.coverageFrom).toLocaleString(input.locale)));
          const chart=node('div',null,'dc-usage__chart'), max=Math.max(1,...data.buckets.map(bucket=>bucket.inputTokens+bucket.outputTokens));chart.setAttribute('aria-label',text('每小时用量','Hourly usage'));
          for(const bucket of data.buckets) { const bar=node('i');bar.style.height=`${(bucket.inputTokens+bucket.outputTokens)/max*100}%`;bar.title=`${bucket.label}: ${bucket.inputTokens+bucket.outputTokens}`;chart.append(bar); }detail.append(chart);
        }
        detail.append(button(text('刷新','Refresh'),()=>void refresh(true)));root.append(detail);
      }
      const summary=node('div',null,'dc-usage__summary');
      const body=button('',()=>scope.actions.setExpanded(!input.expanded),'dc-usage__body');body.setAttribute('aria-expanded',String(input.expanded));
      body.dataset.usageDrag='';
      body.append(node('small',plan ? input.connection.name+' · '+(windows[0]?.label ?? text('剩余额度','remaining quota')) : (input.modelId ?? input.connection.name)+' · '+text('今日估算','today’s estimate')),node('strong',amount));
      const collapse=button('›',()=>scope.actions.setUsageVisibility('collapsed'));collapse.setAttribute('aria-label',text('收起用量','Collapse usage'));summary.append(body,collapse);root.append(summary);
      place();
    }
    async function refresh(force=false) {
      const day=new Date();day.setHours(0,0,0,0);
      const key=JSON.stringify([input.connection?.id,input.connection?.billingMode,input.modelId,day.getTime(),input.revision]);
      if(input.visibility==='hidden'||!input.connection) {clearTimeout(timer);request?.abort();requestKey='';data=null;render();return;}
      if(!force&&key===requestKey) {render();return;}
      clearTimeout(timer);requestKey=key;request?.abort();request=new AbortController();const current=request;
      loading=true;data=null;error='';render();
      try { const value=input.connection.billingMode==='subscription' ? await scope.quota.read(current.signal) : await scope.usage.query({from:day.getTime(),to:Math.max(day.getTime()+1,Date.now()),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,granularity:'hour',connectionId:input.connection.id,modelId:input.modelId},current.signal);
        if(current.signal.aborted||scope.signal.aborted)return;data=value;
      } catch(reason) {if(current.signal.aborted||scope.signal.aborted)return;error=reason instanceof Error?reason.message:String(reason);}
      if(current.signal.aborted||scope.signal.aborted)return;
      loading=false;render();const tomorrow=new Date(day);tomorrow.setDate(tomorrow.getDate()+1);timer=setTimeout(()=>void refresh(true),Math.max(1,tomorrow.getTime()-Date.now()));
    }
    const dismiss = event => { if(menu&&!root.contains(event.target)) {menu=false;render();} };
    const escape = event => { if(event.key==='Escape'&&(menu||input.expanded)) {menu=false;scope.actions.setExpanded(false);render();} };
    document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);
    void refresh();
    return {
      update(next) { if (next.visibility !== input.visibility) { menu = false; cancelDrag(); } input = next; void refresh(); },
      dispose() {
        request?.abort(); clearTimeout(timer); cancelDrag(); sizeObserver.disconnect();
        document.removeEventListener('pointerdown',dismiss); document.removeEventListener('keydown',escape);
        document.removeEventListener('pointermove',move); document.removeEventListener('pointerup',endDrag);
        document.removeEventListener('pointercancel',endDrag); window.removeEventListener('blur',cancelDrag);
        root.remove();
      },
    };
  });
}};
