/** Optional example: the Host owns accounting; this view only queries and renders it. */
export default {
  apply(context) {
    context.register('settings.usage.panel', (container, initial, scope) => {
      const heading = document.createElement('h3'); heading.textContent = 'Session';
      const select = document.createElement('select'); select.setAttribute('aria-label', 'Session');
      const output = document.createElement('p'); output.setAttribute('role', 'status');
      container.append(heading, select, output);
      let input = initial, pending;
      const render = report => {
        const t = report.totals;
        output.textContent = `${t.calls} calls · ${t.reportedCalls ? `${t.inputTokens.toLocaleString()} input / ${t.outputTokens.toLocaleString()} output` : 'Usage unavailable'} · ${t.estimatedCost === null ? 'Price unavailable' : `$${t.estimatedCost.toFixed(4)}${t.pricedCalls < t.calls ? ' (partial)' : ''}`}`;
      };
      const update = next => {
        pending?.abort(); input = next;
        if (input.kind !== 'settings.usage') throw new Error('Expected usage settings input');
        select.replaceChildren();
        const all = new Option('All sessions', ''); select.append(all);
        for (const session of input.report.sessions) select.append(new Option(session.sessionId, session.sessionId));
        render(input.report);
      };
      select.addEventListener('change', async () => {
        pending?.abort(); const controller = pending = new AbortController();
        try {
          if (!scope.usage) throw new Error('usage.read is required');
          const report = await scope.usage.query({ ...input.query, ...(select.value ? { sessionId: select.value } : {}) }, controller.signal);
          if (!controller.signal.aborted && !scope.signal.aborted) render(report);
        } catch (error) { if (!controller.signal.aborted && !scope.signal.aborted) output.textContent = String(error); }
      });
      update(initial);
      return { update, dispose() { pending?.abort(); container.replaceChildren(); } };
    });
  },
};
