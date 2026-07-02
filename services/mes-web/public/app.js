/*
 * Nova MES frontend controller.
 *
 * Real User Monitoring is powered by OpenTelemetry (see rum-otel.js), exposed as
 * window.novaRum. Each user action runs inside an OTel span that:
 *   - carries action attributes (batchId / orderId / journey),
 *   - parents the fetch() span to the backend, so the click and the server work
 *     land on ONE distributed trace via W3C context propagation,
 *   - reports UI errors and RUM business events as spans.
 * All calls are guarded so the app still works if the SDK didn't load.
 */
(function () {
  function rum() {
    return window.novaRum && window.novaRum.ready ? window.novaRum : null;
  }

  var health = document.getElementById('health');
  function setHealth(state, label) {
    health.className = 'health ' + state;
    health.textContent = label;
  }

  async function doFetch(url, body, outEl, clientMsRef) {
    outEl.textContent = 'Running…';
    var t0 = performance.now();

    // RUM JS-error demo: throw inside the user action when the flag is on.
    var f = await fetch('/api/flags/rum').then(function (r) { return r.json(); }).catch(function () { return {}; });
    if (f.rum_js_error) {
      var boom = new Error('RUM demo: unhandled UI error');
      if (rum()) rum().reportError(boom);
      throw boom;
    }

    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var json = await res.json();
    clientMsRef.ms = Math.round(performance.now() - t0);
    return json;
  }

  async function run(actionName, url, body, outEl, props) {
    var clientMsRef = { ms: 0 };
    var r = rum();
    try {
      var work = function () { return doFetch(url, body, outEl, clientMsRef); };
      var json = r
        ? await r.action(actionName, props, work)
        : await work();

      outEl.textContent = JSON.stringify(json, null, 2) + '\n\n(' + clientMsRef.ms + ' ms client-observed)';
      if (json.ok) {
        setHealth('ok', 'System healthy');
        if (r) r.bizEvent('rum.journey.ok', { action: actionName, clientMs: clientMsRef.ms });
      } else {
        setHealth('danger', 'Journey failed — see Dynatrace');
        if (r) r.bizEvent('rum.journey.failed', { action: actionName, clientMs: clientMsRef.ms });
      }
    } catch (e) {
      if (r) r.reportError(e);
      outEl.textContent = 'Error: ' + (e && e.message || e);
      setHealth('danger', 'UI error captured by RUM');
    }
  }

  document.getElementById('btn-release').addEventListener('click', function () {
    var batchId = document.getElementById('batchId').value;
    run('Release batch', '/api/journey/batch-release', { batchId: batchId },
      document.getElementById('out-release'), { batchId: batchId, journey: 'batch_release' });
  });

  document.getElementById('btn-dispense').addEventListener('click', function () {
    var orderId = document.getElementById('orderId').value;
    run('Dispense material', '/api/journey/dispense', { orderId: orderId },
      document.getElementById('out-dispense'), { orderId: orderId, journey: 'dispense' });
  });

  // ---- Demo control panel ----
  var FLAG_LABELS = {
    slow_dispensing: 'Slow dispensing (+4s)',
    db_error_batch_release: 'DB error on release',
    gxp_integration_failure: 'GxP integration 503',
    dispensing_exception: 'Dispensing exception',
    slow_review: 'Slow review (+2.5s)',
    rum_js_error: 'RUM JS error',
  };

  function renderFlags(flags) {
    var wrap = document.getElementById('flags');
    wrap.innerHTML = '';
    Object.keys(FLAG_LABELS).forEach(function (name) {
      var on = !!flags[name];
      var b = document.createElement('button');
      b.className = 'flag' + (on ? ' on' : '');
      b.textContent = (on ? '● ' : '○ ') + FLAG_LABELS[name];
      b.addEventListener('click', function () {
        fetch('/_flags', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flag: name, value: !on }),
        }).then(function (r) { return r.json(); }).then(function (d) { renderFlags(d.flags); });
      });
      wrap.appendChild(b);
    });
  }

  function loadFlags() {
    fetch('/_flags').then(function (r) { return r.json(); }).then(renderFlags);
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-scenario]'), function (btn) {
    btn.addEventListener('click', function () {
      var s = btn.getAttribute('data-scenario');
      fetch('/_flags/scenario', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: s }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        renderFlags(d.flags);
        setHealth(s === 'healthy' ? 'ok' : (s === 'deviation' ? 'warn' : 'danger'),
          s === 'healthy' ? 'System healthy' : 'Scenario armed: ' + s);
      });
    });
  });

  loadFlags();
})();
