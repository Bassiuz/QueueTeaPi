/**
 * The dashboard's HTML, CSS and client-side JavaScript, as one string.
 *
 * No build step, no bundler, no CDN: the page is served inline so the
 * dashboard works in a locked-down environment and cannot drift out of sync
 * with the API it talks to.
 *
 * Everything this page displays comes from `QueueInspector`, which is covered
 * by tests. The markup itself is excluded from coverage — see the note in
 * `vitest.config.ts`.
 */
export function renderDashboardPage(options: {
  basePath: string
  title: string
}): string {
  const api = `${options.basePath}/api`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)} — queue</title>
<style>
  :root {
    color-scheme: light dark;
    --ground: #f6f7f9; --surface: #fff; --sunk: #eff1f4;
    --ink: #161b21; --ink-mid: #48525e; --ink-mute: #6b7683;
    --rule: #dce1e6; --accent: #0b6e63;
    --pending: #9a5b00; --leased: #1f5fd0; --done: #0b6e63; --dead: #a8261e;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0f1216; --surface: #161a1f; --sunk: #1b2027;
      --ink: #e3e8ee; --ink-mid: #a9b4c0; --ink-mute: #8b96a3;
      --rule: #252b33; --accent: #4fd1c5;
      --pending: #e0a458; --leased: #7ba7ff; --done: #4fd1c5; --dead: #f2857c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 24px 80px; background: var(--ground); color: var(--ink);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  header { padding: 40px 0 24px; display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
  h1 { font-size: 22px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .path { font-family: var(--mono); font-size: 12px; color: var(--ink-mute); }
  .spacer { flex: 1; }
  .muted { color: var(--ink-mute); font-size: 12px; font-family: var(--mono); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile {
    background: var(--surface); border: 1px solid var(--rule); border-radius: 6px;
    padding: 14px 16px; display: flex; flex-direction: column; gap: 4px;
  }
  .tile .label {
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .09em;
    text-transform: uppercase; color: var(--ink-mute);
  }
  .tile .value { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .tile .sub { font-size: 12px; color: var(--ink-mute); }
  .v-pending { color: var(--pending); } .v-leased { color: var(--leased); }
  .v-done { color: var(--done); } .v-dead { color: var(--dead); }

  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 28px 0 12px; }
  button, select {
    font: inherit; font-size: 13px; color: var(--ink); background: var(--surface);
    border: 1px solid var(--rule); border-radius: 5px; padding: 6px 11px; cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.primary { border-color: var(--accent); color: var(--accent); }

  .table-wrap { border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 780px; font-size: 13.5px; }
  th {
    text-align: left; font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--ink-mute); font-weight: 500;
    padding: 11px 14px; border-bottom: 1px solid var(--rule); white-space: nowrap;
  }
  td { padding: 11px 14px; border-bottom: 1px solid var(--rule); vertical-align: top; color: var(--ink-mid); }
  tr:last-child td { border-bottom: none; }
  td.id { font-family: var(--mono); font-size: 11.5px; color: var(--ink-mute); }
  td.name { color: var(--ink); }
  .pill {
    display: inline-block; font-family: var(--mono); font-size: 11px; padding: 2px 8px;
    border-radius: 20px; background: var(--sunk); white-space: nowrap;
  }
  .err { font-family: var(--mono); font-size: 11.5px; color: var(--dead); word-break: break-word; max-width: 320px; display: block; }
  .empty { padding: 40px; text-align: center; color: var(--ink-mute); }
  .banner { padding: 10px 14px; border-radius: 6px; background: var(--sunk); color: var(--dead); margin-bottom: 12px; font-size: 13px; }
  dialog {
    border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); color: var(--ink);
    max-width: min(760px, 92vw); width: 100%; padding: 0;
  }
  dialog::backdrop { background: rgba(0,0,0,.45); }
  dialog .head { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--rule); }
  dialog h2 { font-size: 15px; margin: 0; }
  dialog pre {
    margin: 0; padding: 18px; overflow: auto; max-height: 60vh;
    font-family: var(--mono); font-size: 12px; line-height: 1.6; color: var(--ink-mid);
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(options.title)}</h1>
    <span class="path" id="collection"></span>
    <span class="spacer"></span>
    <span class="muted" id="updated">loading…</span>
  </header>

  <div id="error"></div>
  <div class="tiles" id="tiles"></div>

  <div class="bar">
    <select id="filter">
      <option value="all">All statuses</option>
      <option value="pending">Pending</option>
      <option value="leased">Leased</option>
      <option value="done">Done</option>
      <option value="dead" selected>Dead</option>
    </select>
    <button id="refresh">Refresh</button>
    <button id="replay-all" class="primary">Replay all dead</button>
    <span class="spacer"></span>
    <label class="muted"><input type="checkbox" id="auto" checked> auto-refresh</label>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Event</th><th>Status</th><th>Attempts</th><th>Next / finished</th><th>Last error</th><th></th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" hidden>Nothing here.</div>
  </div>
</div>

<dialog id="detail">
  <div class="head"><h2>Event</h2><span class="spacer"></span><button id="close">Close</button></div>
  <pre id="detail-body"></pre>
</dialog>

<script>
(function () {
  var API = ${JSON.stringify(api)};
  var STATUSES = ['pending', 'leased', 'done', 'dead'];
  var timer = null;

  function el(id) { return document.getElementById(id); }
  function text(node, value) { node.textContent = value; }

  function ago(ms) {
    if (ms === null || ms === undefined) return '—';
    var s = Math.round(ms / 1000);
    if (Math.abs(s) < 60) return s + 's';
    var m = Math.round(s / 60);
    if (Math.abs(m) < 60) return m + 'm';
    var h = Math.round(m / 60);
    if (Math.abs(h) < 48) return h + 'h';
    return Math.round(h / 24) + 'd';
  }

  function when(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString();
  }

  function showError(message) {
    el('error').innerHTML = message
      ? '<div class="banner">' + escapeHtml(message) + '</div>'
      : '';
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function api(path, options) {
    var response = await fetch(API + path, options);
    var body = await response.json();
    if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
    return body;
  }

  function renderTiles(stats) {
    var tiles = STATUSES.map(function (status) {
      return '<div class="tile"><span class="label">' + status + '</span>' +
        '<span class="value v-' + status + '">' + stats.counts[status] + '</span></div>';
    });

    tiles.unshift(
      '<div class="tile"><span class="label">due now</span><span class="value">' +
      stats.dueNow + '</span><span class="sub">' +
      (stats.oldestDue ? 'oldest waiting ' + ago(stats.oldestDue.waitingMs) : 'nothing waiting') +
      '</span></div>'
    );

    tiles.push(
      '<div class="tile"><span class="label">handlers</span><span class="value">' +
      stats.handlers.length + '</span><span class="sub">registered here</span></div>'
    );

    el('tiles').innerHTML = tiles.join('');
    text(el('collection'), stats.collection);
    text(el('updated'), 'updated ' + new Date(stats.generatedAt).toLocaleTimeString());
  }

  function renderRows(events) {
    el('empty').hidden = events.length > 0;

    el('rows').innerHTML = events.map(function (event) {
      var timing = event.status === 'pending'
        ? when(event.nextAttemptAt)
        : when(event.finishedAt || event.updatedAt);

      return '<tr>' +
        '<td class="name">' + escapeHtml(event.topic) + ' / ' + escapeHtml(event.name) +
          '<br><span class="id">' + escapeHtml(event.id) + '</span></td>' +
        '<td><span class="pill v-' + event.status + '">' + event.status + '</span></td>' +
        '<td>' + event.attempts + ' / ' + event.maxAttempts + '</td>' +
        '<td>' + timing + '</td>' +
        '<td>' + (event.lastError
          ? '<span class="err">' + escapeHtml(event.lastError.message) + '</span>'
          : '—') + '</td>' +
        '<td style="white-space:nowrap">' +
          '<button data-show="' + escapeHtml(event.id) + '">View</button> ' +
          '<button data-replay="' + escapeHtml(event.id) + '">Replay</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  }

  async function refresh() {
    try {
      var filter = el('filter').value;
      var results = await Promise.all([
        api('/stats'),
        api('/events?limit=50&status=' + encodeURIComponent(filter)),
      ]);
      renderTiles(results[0]);
      renderRows(results[1].events);
      showError('');
    } catch (error) {
      showError(error.message);
    }
  }

  document.addEventListener('click', async function (event) {
    var showId = event.target.getAttribute && event.target.getAttribute('data-show');
    if (showId) {
      try {
        var found = await api('/events/' + encodeURIComponent(showId));
        text(el('detail-body'), JSON.stringify(found.event, null, 2));
        el('detail').showModal();
      } catch (error) { showError(error.message); }
      return;
    }

    var replayId = event.target.getAttribute && event.target.getAttribute('data-replay');
    if (replayId) {
      event.target.disabled = true;
      try {
        await api('/events/' + encodeURIComponent(replayId) + '/replay', { method: 'POST' });
        await refresh();
      } catch (error) {
        showError(error.message);
        event.target.disabled = false;
      }
    }
  });

  el('close').addEventListener('click', function () { el('detail').close(); });
  el('refresh').addEventListener('click', refresh);
  el('filter').addEventListener('change', refresh);

  el('replay-all').addEventListener('click', async function () {
    if (!confirm('Replay every dead event? They go back to pending with a fresh attempt budget.')) return;
    try {
      var result = await api('/replay?status=dead&limit=500', { method: 'POST' });
      showError('');
      alert('Replayed ' + result.replayed + ' of ' + result.matched + ' dead events.');
      await refresh();
    } catch (error) { showError(error.message); }
  });

  function applyAuto() {
    clearInterval(timer);
    if (el('auto').checked) timer = setInterval(refresh, 4000);
  }
  el('auto').addEventListener('change', applyAuto);

  refresh();
  applyAuto();
})();
</script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] as string,
  )
}
