/*
 * Nova MES frontend controller — SPA with hash-based router.
 *
 * Real User Monitoring is powered by OpenTelemetry (see rum-otel.js), exposed as
 * window.novaRum. Each user action and page navigation runs inside an OTel span
 * that parents the fetch() spans to the backend, stitching browser and server
 * into a single distributed trace via W3C context propagation.
 */
(function () {
  // ---- RUM helpers ----
  function rum() {
    return window.novaRum && window.novaRum.ready ? window.novaRum : null;
  }

  var health = document.getElementById('health');
  function setHealth(state, label) {
    health.className = 'health ' + state;
    health.textContent = label;
  }

  // ---- Cleanup hook — clears intervals and Chart instances on navigation ----
  var _cleanup = null;
  function registerCleanup(fn) { _cleanup = fn; }

  // ---- Utilities ----
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    var secs = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (secs < 60)   return secs + 's ago';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return Math.floor(secs / 86400) + 'd ago';
  }

  function badge(value) {
    var cls = 'badge badge-' + (value || 'unknown').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    return '<span class="' + cls + '">' + (value || '—') + '</span>';
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ---- Journey runner (shared by Batches and Work Orders pages) ----
  function runJourney(actionName, url, body, outEl, rumProps, onDone) {
    outEl.innerHTML = '<div class="result-banner running"><div class="banner-title">Running…</div></div>';
    var clientMsRef = { ms: 0 };
    var r = rum();

    async function doWork() {
      var flagRes = await fetch('/api/flags/rum').then(function(r) { return r.json(); }).catch(function() { return {}; });
      if (flagRes.rum_js_error) {
        var boom = new Error('RUM demo: unhandled UI error');
        if (r) r.reportError(boom);
        throw boom;
      }
      var t0 = performance.now();
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var json = await res.json();
      clientMsRef.ms = Math.round(performance.now() - t0);
      return json;
    }

    var work = r
      ? function() { return r.action(actionName, rumProps, doWork); }
      : doWork;

    Promise.resolve().then(work).then(function(json) {
      if (json.ok) {
        setHealth('ok', 'System healthy');
        var detail = json.batchId
          ? 'Batch ' + json.batchId + ' · ' + json.durMs + 'ms server · ' + clientMsRef.ms + 'ms client'
          : 'Order ' + json.orderId + ' · ' + (json.weigh ? json.weigh.netWeightKg + ' kg net · ' : '') + clientMsRef.ms + 'ms client';
        outEl.innerHTML = '<div class="result-banner ok"><div class="banner-title">Success</div><div class="banner-detail">' + esc(detail) + '</div></div>';
        if (r) r.bizEvent('rum.journey.ok', { action: actionName, clientMs: clientMsRef.ms });
      } else {
        setHealth('danger', 'Journey failed — see Dynatrace');
        outEl.innerHTML = '<div class="result-banner fail"><div class="banner-title">Failed</div><div class="banner-detail">' + esc(json.error || 'Unknown error') + '</div></div>';
        if (r) r.bizEvent('rum.journey.failed', { action: actionName, clientMs: clientMsRef.ms });
      }
      if (onDone) onDone();
    }).catch(function(e) {
      if (r) r.reportError(e);
      outEl.innerHTML = '<div class="result-banner fail"><div class="banner-title">UI Error</div><div class="banner-detail">' + esc(e && e.message || String(e)) + '</div></div>';
      setHealth('danger', 'UI error captured by RUM');
    });
  }

  // ---- Expandable table row ----
  function makeExpandableRow(tr, colCount, detailHtml) {
    tr.classList.add('data-row');
    tr.addEventListener('click', function() {
      var next = tr.nextElementSibling;
      if (next && next.classList.contains('detail-row')) {
        next.remove();
      } else {
        var det = document.createElement('tr');
        det.className = 'detail-row';
        det.innerHTML = '<td colspan="' + colCount + '" class="detail-cell">' + detailHtml + '</td>';
        tr.insertAdjacentElement('afterend', det);
      }
    });
  }

  // ---- Sort helper ----
  function makeSorter(rows, key, dir) {
    return rows.slice().sort(function(a, b) {
      var av = a[key], bv = b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  // ================================================================
  //  PAGE: Dashboard
  // ================================================================
  function renderDashboard(container) {
    container.innerHTML =
      '<div class="page-header"><h1>Dashboard</h1><div class="page-sub">Live KPIs · auto-refreshes every 15s</div></div>' +
      '<div class="kpi-grid" id="kpi-grid"></div>' +
      '<div class="dashboard-lower">' +
        '<div>' +
          '<div class="chart-wrap"><h3>Recent batch value (USD)</h3><div class="chart-box"><canvas id="batch-chart"></canvas></div></div>' +
        '</div>' +
        '<div class="activity-wrap"><h3>Recent activity</h3><ul class="activity-feed" id="activity-feed"></ul></div>' +
      '</div>';

    var chartInstance = null;

    function renderKpis(data) {
      var g = document.getElementById('kpi-grid');
      if (!g) return;
      g.innerHTML =
        '<div class="kpi-tile' + (data.batchesToday > 0 ? ' kpi-ok' : '') + '">' +
          '<div class="kpi-label">Batches today</div>' +
          '<div class="kpi-value">' + (data.batchesToday || 0) + '</div>' +
        '</div>' +
        '<div class="kpi-tile' + (data.activeWorkOrders > 0 ? ' kpi-ok' : '') + '">' +
          '<div class="kpi-label">Active work orders</div>' +
          '<div class="kpi-value">' + (data.activeWorkOrders || 0) + '</div>' +
        '</div>' +
        '<div class="kpi-tile' + (data.openDeviations > 0 ? ' kpi-warn' : '') + '">' +
          '<div class="kpi-label">Open deviations</div>' +
          '<div class="kpi-value">' + (data.openDeviations || 0) + '</div>' +
        '</div>' +
        '<div class="kpi-tile' + (data.equipmentFaults > 0 ? ' kpi-danger' : '') + '">' +
          '<div class="kpi-label">Equipment faults</div>' +
          '<div class="kpi-value">' + (data.equipmentFaults || 0) + '</div>' +
        '</div>';
    }

    function renderChart(batches) {
      var ctx = document.getElementById('batch-chart');
      if (!ctx || !batches || !batches.length) return;

      var labels = batches.map(function(b) { return b.batch_id; });
      var data = batches.map(function(b) { return parseFloat(b.value_usd) || 0; });
      var bg = batches.map(function(b) {
        return b.status === 'failed' ? 'rgba(220,38,38,.6)' : 'rgba(59,130,246,.6)';
      });
      var bd = batches.map(function(b) {
        return b.status === 'failed' ? 'rgba(220,38,38,1)' : 'rgba(59,130,246,1)';
      });

      // Update data in place on refresh — avoids destroy/recreate flicker.
      if (chartInstance) {
        chartInstance.data.labels = labels;
        chartInstance.data.datasets[0].data = data;
        chartInstance.data.datasets[0].backgroundColor = bg;
        chartInstance.data.datasets[0].borderColor = bd;
        chartInstance.update();
        return;
      }

      chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{ label: 'Value (USD)', data: data, backgroundColor: bg, borderColor: bd, borderWidth: 1 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: function(ctx) { return '$' + ctx.parsed.y.toLocaleString(); } } },
          },
          scales: {
            x: { ticks: { color: '#98a2b3', font: { size: 9 }, maxRotation: 45 }, grid: { color: '#262c34' } },
            y: {
              beginAtZero: true,
              ticks: { color: '#98a2b3', font: { size: 10 }, callback: function(v) { return '$' + (v/1000).toFixed(0) + 'k'; } },
              grid: { color: '#262c34' },
            },
          },
        },
      });
    }

    function renderActivity(items) {
      var el = document.getElementById('activity-feed');
      if (!el) return;
      if (!items || !items.length) {
        el.innerHTML = '<li class="activity-empty">No recent activity</li>';
        return;
      }
      el.innerHTML = items.map(function(item) {
        var icon = item.type === 'deviation' ? '⚠' : (item.status === 'released' ? '✓' : '●');
        var color = item.status === 'released' || item.status === 'completed' ? '#4ade80' :
                    item.status === 'failed'   || item.status === 'deviation'  ? '#f87171' : '#60a5fa';
        return '<li><span style="color:' + color + '">' + icon + '</span>' +
          '<span>' + esc(item.ref) + ' · ' + badge(item.status) + '</span>' +
          '<span class="activity-time">' + timeAgo(item.created_at) + '</span></li>';
      }).join('');
    }

    function loadKpis() {
      fetch('/api/dashboard/kpis')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          renderKpis(data);
          renderChart(data.recentBatches);
          renderActivity(data.recentActivity);
        })
        .catch(function() {
          var g = document.getElementById('kpi-grid');
          if (g) g.innerHTML = '<p style="color:var(--muted);font-size:13px;grid-column:1/-1">No database connected — KPIs unavailable. Run <code>docker compose up</code> to enable.</p>';
        });
    }

    loadKpis();
    var iv = setInterval(loadKpis, 15000);
    registerCleanup(function() {
      clearInterval(iv);
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    });
  }

  // ================================================================
  //  PAGE: Batch Records
  // ================================================================
  function renderBatches(container) {
    var sortState = { key: 'created_at', dir: -1 };
    var allRows = [];

    container.innerHTML =
      '<div class="page-header"><h1>Batch Records</h1><div class="page-sub">Electronic batch records — GxP release history</div></div>' +
      '<div class="journey-card">' +
        '<h2>Release Batch</h2>' +
        '<div class="journey-form">' +
          '<div><label>Batch ID<input id="batchId" value="NX-88431" /></label></div>' +
          '<button id="btn-release" class="primary" data-action="Release batch">Release batch</button>' +
        '</div>' +
        '<div id="out-release"></div>' +
      '</div>' +
      '<div class="table-wrap"><table class="data-table">' +
        '<thead><tr>' +
          '<th data-col="batch_id">Batch ID <span class="sort-arrow"></span></th>' +
          '<th data-col="product_name">Product <span class="sort-arrow"></span></th>' +
          '<th data-col="status">Status <span class="sort-arrow"></span></th>' +
          '<th data-col="quantity_units">Qty (units) <span class="sort-arrow"></span></th>' +
          '<th data-col="value_usd">Value (USD) <span class="sort-arrow"></span></th>' +
          '<th data-col="site">Site / Line <span class="sort-arrow"></span></th>' +
          '<th data-col="created_at">Created <span class="sort-arrow"></span></th>' +
        '</tr></thead>' +
        '<tbody id="batches-tbody"><tr><td colspan="7" style="color:var(--muted);padding:20px">Loading…</td></tr></tbody>' +
      '</table></div>';

    function renderTable() {
      var tbody = document.getElementById('batches-tbody');
      if (!tbody) return;
      if (!allRows.length) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><strong>No batch records</strong>Release a batch above or check your database connection.</div></td></tr>';
        return;
      }
      var sorted = makeSorter(allRows, sortState.key, sortState.dir);
      tbody.innerHTML = '';
      sorted.forEach(function(row) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><code style="font-size:12px">' + esc(row.batch_id) + '</code></td>' +
          '<td>' + esc(row.product_name || '—') + '</td>' +
          '<td>' + badge(row.status) + '</td>' +
          '<td>' + (row.quantity_units ? Number(row.quantity_units).toLocaleString() : '—') + '</td>' +
          '<td>' + (row.value_usd ? '$' + Number(row.value_usd).toLocaleString('en-US', {minimumFractionDigits:2}) : '—') + '</td>' +
          '<td style="color:var(--muted);font-size:12px">' + esc((row.site || '') + ' / ' + (row.line || '')) + '</td>' +
          '<td style="color:var(--muted);font-size:12px">' + fmtDate(row.created_at) + '</td>';
        var detail = 'Product: ' + esc(row.product_name || '—') + ' · Code: ' + esc(row.product_code || '—') +
          (row.released_at ? ' · Released: ' + fmtDate(row.released_at) : '') +
          ' · Review exceptions: ' + (row.review_exceptions || 0) +
          (row.notes ? ' · Notes: ' + esc(row.notes) : '');
        makeExpandableRow(tr, 7, detail);
        tbody.appendChild(tr);
      });
    }

    function loadBatches() {
      fetch('/api/batches')
        .then(function(r) { return r.json(); })
        .then(function(rows) { allRows = Array.isArray(rows) ? rows : []; renderTable(); })
        .catch(function() {
          var tbody = document.getElementById('batches-tbody');
          if (tbody) tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><strong>Database unavailable</strong>Run docker compose up to enable persistence.</div></td></tr>';
        });
    }

    document.getElementById('btn-release').addEventListener('click', function() {
      var batchId = document.getElementById('batchId').value;
      runJourney('Release batch', '/api/journey/batch-release', { batchId: batchId },
        document.getElementById('out-release'), { batchId: batchId, journey: 'batch_release' }, loadBatches);
    });

    container.querySelectorAll('.data-table thead th[data-col]').forEach(function(th) {
      th.addEventListener('click', function() {
        var col = th.getAttribute('data-col');
        if (sortState.key === col) sortState.dir *= -1;
        else { sortState.key = col; sortState.dir = -1; }
        container.querySelectorAll('.data-table thead th .sort-arrow').forEach(function(a) { a.textContent = ''; });
        th.querySelector('.sort-arrow').textContent = sortState.dir === 1 ? ' ↑' : ' ↓';
        renderTable();
      });
    });

    loadBatches();
  }

  // ================================================================
  //  PAGE: Work Orders
  // ================================================================
  function renderWorkOrders(container) {
    var sortState = { key: 'created_at', dir: -1 };
    var allRows = [];

    container.innerHTML =
      '<div class="page-header"><h1>Work Orders</h1><div class="page-sub">Weigh & dispense queue — shop-floor dispensing operations</div></div>' +
      '<div class="journey-card">' +
        '<h2>Dispense Material</h2>' +
        '<div class="journey-form">' +
          '<div><label>Work Order <input id="orderId" value="WO-5117" /></label></div>' +
          '<button id="btn-dispense" class="primary" data-action="Dispense material">Dispense material</button>' +
        '</div>' +
        '<div id="out-dispense"></div>' +
      '</div>' +
      '<div class="table-wrap"><table class="data-table">' +
        '<thead><tr>' +
          '<th data-col="order_id">WO# <span class="sort-arrow"></span></th>' +
          '<th data-col="material_name">Material <span class="sort-arrow"></span></th>' +
          '<th data-col="target_kg">Target kg <span class="sort-arrow"></span></th>' +
          '<th data-col="actual_kg">Actual kg <span class="sort-arrow"></span></th>' +
          '<th data-col="status">Status <span class="sort-arrow"></span></th>' +
          '<th data-col="priority">Priority <span class="sort-arrow"></span></th>' +
          '<th data-col="created_at">Created <span class="sort-arrow"></span></th>' +
        '</tr></thead>' +
        '<tbody id="wo-tbody"><tr><td colspan="7" style="color:var(--muted);padding:20px">Loading…</td></tr></tbody>' +
      '</table></div>';

    function renderTable() {
      var tbody = document.getElementById('wo-tbody');
      if (!tbody) return;
      if (!allRows.length) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><strong>No work orders</strong>Dispense a material above or check your database connection.</div></td></tr>';
        return;
      }
      var sorted = makeSorter(allRows, sortState.key, sortState.dir);
      tbody.innerHTML = '';
      sorted.forEach(function(row) {
        var delta = (row.actual_kg != null && row.target_kg != null)
          ? (parseFloat(row.actual_kg) - parseFloat(row.target_kg)).toFixed(3) : null;
        var deltaColor = delta == null ? '' : Math.abs(delta) > 0.5 ? 'color:#f87171' : 'color:#4ade80';
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><code style="font-size:12px">' + esc(row.order_id) + '</code></td>' +
          '<td>' + esc(row.material_name || '—') + '</td>' +
          '<td>' + (row.target_kg != null ? parseFloat(row.target_kg).toFixed(3) : '—') + '</td>' +
          '<td>' + (row.actual_kg != null ? '<span style="' + deltaColor + '">' + parseFloat(row.actual_kg).toFixed(3) + '</span>' : '—') + '</td>' +
          '<td>' + badge(row.status) + '</td>' +
          '<td>' + badge(row.priority || 'normal') + '</td>' +
          '<td style="color:var(--muted);font-size:12px">' + fmtDate(row.created_at) + '</td>';
        var detail = 'Material: ' + esc(row.material_name || '—') + ' · Code: ' + esc(row.material_code || '—') +
          ' · Target: ' + (row.target_kg || '—') + ' kg · Actual: ' + (row.actual_kg != null ? parseFloat(row.actual_kg).toFixed(3) : '—') + ' kg' +
          (delta != null ? ' · Delta: ' + (delta > 0 ? '+' : '') + delta + ' kg' : '') +
          ' · Site: ' + esc(row.site || '—') + ' / ' + esc(row.line || '—') +
          (row.completed_at ? ' · Completed: ' + fmtDate(row.completed_at) : '');
        makeExpandableRow(tr, 7, detail);
        tbody.appendChild(tr);
      });
    }

    function loadWorkOrders() {
      fetch('/api/work-orders')
        .then(function(r) { return r.json(); })
        .then(function(rows) { allRows = Array.isArray(rows) ? rows : []; renderTable(); })
        .catch(function() {
          var tbody = document.getElementById('wo-tbody');
          if (tbody) tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><strong>Database unavailable</strong>Run docker compose up to enable persistence.</div></td></tr>';
        });
    }

    document.getElementById('btn-dispense').addEventListener('click', function() {
      var orderId = document.getElementById('orderId').value;
      runJourney('Dispense material', '/api/journey/dispense', { orderId: orderId },
        document.getElementById('out-dispense'), { orderId: orderId, journey: 'dispense' }, loadWorkOrders);
    });

    container.querySelectorAll('.data-table thead th[data-col]').forEach(function(th) {
      th.addEventListener('click', function() {
        var col = th.getAttribute('data-col');
        if (sortState.key === col) sortState.dir *= -1;
        else { sortState.key = col; sortState.dir = -1; }
        container.querySelectorAll('.data-table thead th .sort-arrow').forEach(function(a) { a.textContent = ''; });
        th.querySelector('.sort-arrow').textContent = sortState.dir === 1 ? ' ↑' : ' ↓';
        renderTable();
      });
    });

    loadWorkOrders();
  }

  // ================================================================
  //  PAGE: Equipment
  // ================================================================
  function renderEquipment(container) {
    container.innerHTML =
      '<div class="page-header"><h1>Equipment Status</h1><div class="page-sub">Shop-floor instruments · auto-refreshes every 15s</div></div>' +
      '<div class="equipment-grid" id="equip-grid"></div>';

    function loadEquipment() {
      fetch('/api/equipment')
        .then(function(r) { return r.json(); })
        .then(function(rows) {
          var grid = document.getElementById('equip-grid');
          if (!grid) return;
          if (!rows || !rows.length) {
            grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><strong>No equipment records</strong>Database not connected.</div>';
            return;
          }
          grid.innerHTML = rows.map(function(row) {
            var reading = row.last_reading_json || {};
            var readingLines = Object.keys(reading).map(function(k) { return k + ': ' + reading[k]; }).join('\n');
            return '<div class="equip-card">' +
              '<div class="equip-id">' + esc(row.equipment_id) + '</div>' +
              '<div class="equip-name">' + esc(row.name || row.equipment_id) + '</div>' +
              '<div class="equip-status-row">' +
                '<div class="equip-meta">' + esc(row.type || '') + ' · ' + esc(row.line || '') + '</div>' +
                badge(row.status) +
              '</div>' +
              (readingLines ? '<pre class="equip-readings">' + esc(readingLines) + '</pre>' : '') +
              '<div class="equip-last-seen">Last seen: ' + timeAgo(row.last_seen_at) + '</div>' +
            '</div>';
          }).join('');
        })
        .catch(function() {
          var grid = document.getElementById('equip-grid');
          if (grid) grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><strong>Database unavailable</strong>Run docker compose up to enable equipment tracking.</div>';
        });
    }

    loadEquipment();
    var iv = setInterval(loadEquipment, 15000);
    registerCleanup(function() { clearInterval(iv); });
  }

  // ================================================================
  //  PAGE: Deviations
  // ================================================================
  function renderDeviations(container) {
    var sortState = { key: 'created_at', dir: -1 };
    var allRows = [];

    container.innerHTML =
      '<div class="page-header"><h1>Deviations</h1><div class="page-sub">Quality events requiring investigation — auto-logged from journey failures</div></div>' +
      '<div class="table-wrap"><table class="data-table">' +
        '<thead><tr>' +
          '<th data-col="id">ID <span class="sort-arrow"></span></th>' +
          '<th data-col="reference_id">Reference <span class="sort-arrow"></span></th>' +
          '<th data-col="reference_type">Type <span class="sort-arrow"></span></th>' +
          '<th data-col="severity">Severity <span class="sort-arrow"></span></th>' +
          '<th data-col="description">Description <span class="sort-arrow"></span></th>' +
          '<th data-col="status">Status <span class="sort-arrow"></span></th>' +
          '<th data-col="created_at">Opened <span class="sort-arrow"></span></th>' +
        '</tr></thead>' +
        '<tbody id="dev-tbody"><tr><td colspan="7" style="color:var(--muted);padding:20px">Loading…</td></tr></tbody>' +
      '</table></div>';

    function renderTable() {
      var tbody = document.getElementById('dev-tbody');
      if (!tbody) return;
      if (!allRows.length) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><strong>No deviations</strong>Deviations are auto-logged when journeys fail. Inject a fault via Control Panel and run a journey.</div></td></tr>';
        return;
      }
      var sorted = makeSorter(allRows, sortState.key, sortState.dir);
      tbody.innerHTML = '';
      sorted.forEach(function(row) {
        var desc = (row.description || '').slice(0, 80) + ((row.description || '').length > 80 ? '…' : '');
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td style="color:var(--muted);font-size:12px">DEV-' + row.id + '</td>' +
          '<td><code style="font-size:12px">' + esc(row.reference_id) + '</code></td>' +
          '<td style="color:var(--muted);font-size:12px">' + esc(row.reference_type === 'batch' ? 'Batch release' : 'Work order') + '</td>' +
          '<td>' + badge(row.severity) + '</td>' +
          '<td style="font-size:12px;color:var(--muted)">' + esc(desc) + '</td>' +
          '<td>' + badge(row.status) + '</td>' +
          '<td style="color:var(--muted);font-size:12px">' + fmtDate(row.created_at) + '</td>';
        var detail = 'Full description: ' + esc(row.description || '—') +
          ' · Site: ' + esc(row.site || '—') +
          (row.closed_at ? ' · Closed: ' + fmtDate(row.closed_at) : '');
        makeExpandableRow(tr, 7, detail);
        tbody.appendChild(tr);
      });
    }

    function loadDeviations() {
      fetch('/api/deviations')
        .then(function(r) { return r.json(); })
        .then(function(rows) { allRows = Array.isArray(rows) ? rows : []; renderTable(); })
        .catch(function() {
          var tbody = document.getElementById('dev-tbody');
          if (tbody) tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><strong>Database unavailable</strong></div></td></tr>';
        });
    }

    container.querySelectorAll('.data-table thead th[data-col]').forEach(function(th) {
      th.addEventListener('click', function() {
        var col = th.getAttribute('data-col');
        if (sortState.key === col) sortState.dir *= -1;
        else { sortState.key = col; sortState.dir = -1; }
        container.querySelectorAll('.data-table thead th .sort-arrow').forEach(function(a) { a.textContent = ''; });
        th.querySelector('.sort-arrow').textContent = sortState.dir === 1 ? ' ↑' : ' ↓';
        renderTable();
      });
    });

    loadDeviations();
  }

  // ================================================================
  //  PAGE: Control Panel
  // ================================================================
  function renderControl(container) {
    var FLAG_LABELS = {
      slow_dispensing:        'Slow dispensing (+4s)',
      db_error_batch_release: 'DB error on release',
      gxp_integration_failure:'GxP integration 503',
      dispensing_exception:   'Dispensing exception',
      slow_review:            'Slow review (+2.5s)',
      rum_js_error:           'RUM JS error',
    };

    container.innerHTML =
      '<div class="page-header"><h1>Control Panel</h1><div class="page-sub">Fault injection — flip scenarios or individual flags to trigger failures visible in Dynatrace</div></div>' +
      '<div class="card" style="max-width:760px">' +
        '<h2 style="margin-bottom:12px">Scenario presets</h2>' +
        '<div class="scenarios">' +
          '<button data-scenario="healthy" class="chip">Reset · healthy</button>' +
          '<button data-scenario="deviation" class="chip warn">Scenario · dispensing deviation</button>' +
          '<button data-scenario="release_failure" class="chip danger">Scenario · release failure</button>' +
        '</div>' +
        '<h2 style="margin-bottom:12px;margin-top:4px">Individual flags</h2>' +
        '<div id="flags" class="flags"></div>' +
      '</div>';

    function renderFlags(flags) {
      var wrap = document.getElementById('flags');
      if (!wrap) return;
      wrap.innerHTML = '';
      Object.keys(FLAG_LABELS).forEach(function(name) {
        var on = !!flags[name];
        var b = document.createElement('button');
        b.className = 'flag' + (on ? ' on' : '');
        b.textContent = (on ? '● ' : '○ ') + FLAG_LABELS[name];
        b.addEventListener('click', function() {
          fetch('/_flags', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ flag: name, value: !on }),
          }).then(function(r) { return r.json(); }).then(function(d) { renderFlags(d.flags); });
        });
        wrap.appendChild(b);
      });
    }

    fetch('/_flags').then(function(r) { return r.json(); }).then(renderFlags);

    container.querySelectorAll('[data-scenario]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var s = btn.getAttribute('data-scenario');
        fetch('/_flags/scenario', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: s }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          renderFlags(d.flags);
          setHealth(
            s === 'healthy' ? 'ok' : s === 'deviation' ? 'warn' : 'danger',
            s === 'healthy' ? 'System healthy' : 'Scenario armed: ' + s
          );
        });
      });
    });
  }

  // ================================================================
  //  Router
  // ================================================================
  var PAGES = {
    'dashboard':   renderDashboard,
    'batches':     renderBatches,
    'work-orders': renderWorkOrders,
    'equipment':   renderEquipment,
    'deviations':  renderDeviations,
    'control':     renderControl,
  };

  function navigate() {
    if (_cleanup) { _cleanup(); _cleanup = null; }

    var hash = window.location.hash.slice(1) || 'dashboard';
    var pageFn = PAGES[hash] || PAGES['dashboard'];

    document.querySelectorAll('.nav-item').forEach(function(a) {
      a.classList.toggle('active', a.dataset.page === hash);
    });

    var content = document.getElementById('content');
    content.innerHTML = '';

    var r = rum();
    if (r) {
      r.action('nav:' + hash, { page: hash }, function() { pageFn(content); }).catch(function() { pageFn(content); });
    } else {
      pageFn(content);
    }
  }

  window.addEventListener('hashchange', navigate);
  navigate();
})();
