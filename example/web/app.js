/*
 * The tea room's front end.
 *
 * Plain browser JavaScript, no build step — the interesting code is on the
 * server. All this does is press four buttons and poll two endpoints.
 */
;(function () {
  'use strict'

  var POLL_MS = 400

  var config = null
  var pollTimer = null

  function el(id) {
    return document.getElementById(id)
  }

  function showError(message) {
    var banner = el('error')
    banner.hidden = !message
    banner.textContent = message || ''
  }

  async function api(path, options) {
    var response = await fetch(path, options)
    var body = await response.json()
    if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status)
    return body
  }

  function seconds(ms) {
    if (ms < 950) return Math.round(ms) + 'ms'
    return (ms / 1000).toFixed(ms < 9500 ? 1 : 0) + 's'
  }

  // ── the buttons ──────────────────────────────────────────────────────────

  var BUSY_LABEL = {
    tea: 'brewing… ⊂(◉‿◉)つ',
    pie: 'baking… (っ˘ڡ˘ς)',
    showstopper: 'attempting… (ง •̀_•́)ง',
  }

  async function orderInline(button, kind) {
    button.disabled = true
    button.classList.add('working')

    var label = button.querySelector('.label')
    var original = label ? label.textContent : ''
    if (label) label.textContent = BUSY_LABEL[kind] || 'making…'

    try {
      // The handler's return value comes back with the response — that is
      // what inline delivery is for. The refresh below picks it up from the
      // ledger too, tagged 'counter'.
      var body = await api('/api/order/inline?kind=' + kind, { method: 'POST' })

      // A showstopper fails about half the time. The event is not lost — it
      // goes back in the queue and retries on its own — so say so kindly
      // rather than shouting about an error.
      showError(
        body.failed
          ? 'oh no — ' + body.message + '  …it is back in the queue, it will try again ♡'
          : '',
      )
      await refresh()
    } catch (error) {
      showError(error.message)
    } finally {
      if (label) label.textContent = original
      button.classList.remove('working')
      button.disabled = false
    }
  }

  async function orderBulk(button, kind) {
    var input = el(kind + '-count')
    var count = Math.max(1, Math.min(1000, Number(input.value) || 1))

    button.disabled = true
    try {
      await api('/api/order/bulk?kind=' + kind, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: count }),
      })
      showError('')
      await refresh()
    } catch (error) {
      showError(error.message)
    } finally {
      button.disabled = false
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────

  function renderTiles(stats) {
    var counts = stats.counts
    var tiles = [
      tile('🧺', 'waiting', counts.pending, 'v-pending', stats.dueNow + ' ready now'),
      tile('👩‍🍳', 'being made', counts.leased, 'v-leased', 'hands in the kitchen'),
      tile('☕', 'served', counts.done, 'v-done', 'all time ♡'),
      tile('💔', 'gave up', counts.dead, 'v-dead', 'out of retries'),
      tile(
        '⏰',
        'longest wait',
        stats.oldestDue ? seconds(stats.oldestDue.waitingMs) : '—',
        '',
        stats.oldestDue ? stats.oldestDue.name : 'nothing waiting ♪',
      ),
    ]
    el('tiles').innerHTML = tiles.join('')
  }

  function tile(emoji, label, value, className, sub) {
    return (
      '<div class="tile"><span class="label">' +
      emoji +
      ' ' +
      label +
      '</span><span class="value ' +
      className +
      '">' +
      value +
      '</span><span class="sub">' +
      escapeHtml(String(sub)) +
      '</span></div>'
    )
  }

  /** Ids currently on screen, so a poll that changed nothing changes nothing. */
  var renderedIds = []

  function renderServed(served, totalDone) {
    el('empty').hidden = served.length > 0

    el('served-note').textContent = served.length
      ? 'newest first · ' +
        served.length +
        ' of ' +
        totalDone +
        ' straight from the ledger'
      : ''

    var ids = served.map(function (item) {
      return item.id
    })

    // Rebuilding identical markup would restart every card's animation, so an
    // idle queue would flicker two and a half times a second.
    if (ids.length === renderedIds.length && ids.join() === renderedIds.join()) {
      return
    }

    var onScreen = new Set(renderedIds)
    el('grid').innerHTML = served
      .map(function (item) {
        return card(item, !onScreen.has(item.id))
      })
      .join('')

    renderedIds = ids
  }

  function card(item, isNew) {
    var wasInline = item.mode === 'inline'
    var retried = item.attempts > 1

    return (
      '<div class="card' +
      (wasInline ? ' inline' : '') +
      (isNew ? ' fresh' : '') +
      '" style="--hue:' +
      item.hue +
      '">' +
      (wasInline ? '<span class="tag">counter</span>' : '') +
      '<span class="emoji">' +
      item.emoji +
      '</span>' +
      '<span class="name">' +
      escapeHtml(item.name) +
      '</span>' +
      // Kept short on purpose: these lines have to survive a 160px card
      // without wrapping. The emoji and the name already say what it is.
      '<span class="meta">made in ' +
      seconds(item.preparedInMs) +
      '</span>' +
      '<span class="meta">waited ' +
      seconds(item.waitedMs) +
      (retried
        ? ' · <span class="retried">' + item.attempts + ' tries</span>'
        : '') +
      '</span>' +
      '</div>'
    )
  }

  function hint(kind, text) {
    var node = document.querySelector('[data-inline="' + kind + '"] .hint')
    if (node) node.textContent = text
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[character]
    })
  }

  // ── polling ──────────────────────────────────────────────────────────────

  async function refresh() {
    try {
      var results = await Promise.all([api('/api/stats'), api('/api/served')])
      renderTiles(results[0])
      renderServed(results[1].served, results[0].counts.done)
    } catch (error) {
      showError(error.message)
    }
  }

  function startPolling() {
    stopPolling()
    pollTimer = setInterval(refresh, POLL_MS)
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button') : null
    if (!button) return

    var inlineKind = button.getAttribute('data-inline')
    if (inlineKind) return void orderInline(button, inlineKind)

    var bulkKind = button.getAttribute('data-bulk')
    if (bulkKind) return void orderBulk(button, bulkKind)

    if (button.id === 'clumsy') {
      button.disabled = true
      api('/api/order/clumsy', { method: 'POST' })
        .then(function () {
          showError('')
          el('clumsy-note').textContent =
            'oops! it retries twice, then waits in the dead-letter queue — open the dashboard to replay it ♡'
        })
        .catch(function (error) {
          showError(error.message)
        })
        .finally(function () {
          button.disabled = false
        })
    }

    if (button.id === 'clear') {
      button.disabled = true
      api('/api/clear', { method: 'POST' })
        .then(refresh)
        .catch(function (error) {
          showError(error.message)
        })
        .finally(function () {
          button.disabled = false
        })
    }
  })

  // Do not keep polling a tab nobody is looking at.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopPolling()
    else {
      refresh()
      startPolling()
    }
  })

  async function boot() {
    try {
      config = await api('/api/config')

      el('mode').textContent = config.mode + ' mode'
      el('description').textContent = config.description
      el('pool-size').textContent = String(config.poolSize)
      el('collection').textContent = config.collection
      el('clear').hidden = !config.canClear

      hint('tea', '≈' + seconds(config.teaBrewMs))
      hint('pie', '≈' + seconds(config.pieBakeMs))
      hint(
        'showstopper',
        '≈' +
          seconds(config.showstopperBakeMs) +
          ' · fails ' +
          Math.round(config.showstopperFailureRate * 100) +
          '% of the time',
      )
    } catch (error) {
      showError('could not reach the server ｡ﾟ(ﾟ´ω`ﾟ)ﾟ｡ ' + error.message)
    }

    await refresh()
    startPolling()
  }

  void boot()
})()
