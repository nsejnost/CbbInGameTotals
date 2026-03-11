// --- Projection Logic ---
// College basketball: two 20-minute halves
// 46.5% of points in 1st half, 53.5% in 2nd half

function parseClockMinutes(clockStr) {
  // Parse "12:34" or "5:00" format into decimal minutes remaining in the period
  if (!clockStr || clockStr === '') return null;
  const parts = clockStr.split(':');
  if (parts.length !== 2) return null;
  const mins = parseInt(parts[0], 10);
  const secs = parseInt(parts[1], 10);
  if (isNaN(mins) || isNaN(secs)) return null;
  return mins + secs / 60;
}

function getExpectedProportion(period, timeRemainingStr) {
  // Returns the expected proportion of total points scored so far
  // period: 1 = 1st half, 2 = 2nd half
  const minutesRemaining = parseClockMinutes(timeRemainingStr);

  if (period === 1 && minutesRemaining !== null) {
    const minutesElapsed = 20 - minutesRemaining;
    return minutesElapsed * (0.465 / 20);
  } else if (period === 2 && minutesRemaining !== null) {
    const minutesElapsed = 20 - minutesRemaining;
    return 0.465 + minutesElapsed * (0.535 / 20);
  }
  return null;
}

function calculateProjectedTotal(currentTotal, period, timeRemainingStr, pregameTotal) {
  if (currentTotal === null || currentTotal === 0) return pregameTotal;

  const proportion = getExpectedProportion(period, timeRemainingStr);
  if (proportion === null || proportion <= 0) return pregameTotal;

  return currentTotal / proportion;
}

// --- UI ---


function formatTime(isoString) {
  if (!isoString) return '--';
  const d = new Date(isoString);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatTimeRemaining(game) {
  if (game.gameStatus === 'final') return 'Final';
  if (game.gameStatus === 'halftime') return 'Half';
  if (game.gameStatus === 'scheduled') return '--';
  if (game.timeRemaining && game.period) {
    const halfLabel = game.period === 1 ? '1H' : game.period === 2 ? '2H' : `OT`;
    return `${game.timeRemaining} ${halfLabel}`;
  }
  if (game.gameStatus === 'live') return 'Live';
  return '--';
}

function formatScore(game) {
  if (game.homeScore === null || game.awayScore === null) return '--';
  return `${game.awayScore} - ${game.homeScore}`;
}

function formatNumber(val) {
  if (val === null || val === undefined) return '--';
  return val.toFixed(1);
}

function formatDiff(val) {
  if (val === null || val === undefined) return '--';
  const prefix = val > 0 ? '+' : '';
  return prefix + val.toFixed(1);
}

function diffClass(val) {
  if (val === null || val === undefined) return '';
  if (val > 2) return 'positive';
  if (val < -2) return 'negative';
  return 'neutral';
}

function getRowClass(game) {
  if (game.gameStatus === 'live' || game.gameStatus === 'halftime') return 'row-live';
  if (game.gameStatus === 'final') return 'row-final';
  return '';
}

function renderGames(games) {
  const tbody = document.getElementById('gamesBody');
  const noGames = document.getElementById('noGames');
  const loading = document.getElementById('loading');

  loading.classList.add('hidden');

  if (!games || games.length === 0) {
    tbody.innerHTML = '';
    noGames.classList.remove('hidden');
    return;
  }

  noGames.classList.add('hidden');

  // Sort: live games first, then by start time
  const statusOrder = { live: 0, halftime: 1, scheduled: 2, final: 3 };
  games.sort((a, b) => {
    const sa = statusOrder[a.gameStatus] ?? 2;
    const sb = statusOrder[b.gameStatus] ?? 2;
    if (sa !== sb) return sa - sb;
    return new Date(a.commenceTime) - new Date(b.commenceTime);
  });

  tbody.innerHTML = games.map(game => {
    const projected = calculateProjectedTotal(
      game.currentTotal, game.period, game.timeRemaining, game.pregameTotal
    );
    const projDk = (projected !== null && game.dkLiveTotal !== null)
      ? projected - game.dkLiveTotal : null;
    const projFd = (projected !== null && game.fdLiveTotal !== null)
      ? projected - game.fdLiveTotal : null;

    return `<tr class="${getRowClass(game)}">
      <td>${formatTime(game.commenceTime)}</td>
      <td>${game.awayTeam}</td>
      <td>${game.homeTeam}</td>
      <td>${formatTimeRemaining(game)}</td>
      <td>${formatScore(game)}</td>
      <td>${formatNumber(game.pregameTotal)}</td>
      <td>${formatNumber(game.dkLiveTotal)}</td>
      <td>${formatNumber(game.fdLiveTotal)}</td>
      <td class="projected">${formatNumber(projected)}</td>
      <td class="${diffClass(projDk)}">${formatDiff(projDk)}</td>
      <td class="${diffClass(projFd)}">${formatDiff(projFd)}</td>
    </tr>`;
  }).join('');
}

function updateStatusBar(data) {
  document.getElementById('lastUpdated').textContent =
    `Last updated: ${new Date(data.lastUpdated).toLocaleTimeString()}`;
  document.getElementById('apiUsage').textContent =
    `API Requests: ${data.requestCount} / ${data.maxBudget}`;
  document.getElementById('quotaRemaining').textContent =
    data.apiQuotaRemaining !== null
      ? `Odds API Quota Remaining: ${data.apiQuotaRemaining}`
      : 'Odds API Quota: --';

  const warning = document.getElementById('warning');
  if (data.budgetExhausted) {
    warning.textContent = 'API budget exhausted — showing cached data.';
    warning.classList.remove('hidden');
    document.getElementById('refreshBtn').disabled = true;
  } else {
    warning.classList.add('hidden');
  }
}

async function fetchGames() {
  try {
    const res = await fetch('/api/games');
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to fetch');
    }
    const data = await res.json();
    renderGames(data.games);
    updateStatusBar(data);
  } catch (err) {
    console.error('Fetch error:', err);
    document.getElementById('loading').textContent = `Error: ${err.message}`;
    document.getElementById('loading').classList.remove('hidden');
  }
}

// --- Init ---

document.getElementById('setBudget').addEventListener('click', async () => {
  const val = parseInt(document.getElementById('maxBudget').value, 10);
  if (isNaN(val) || val < 1) return;
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxBudget: val }),
    });
    // Re-fetch to reflect updated budget
    fetchGames();
  } catch (err) {
    console.error('Failed to set budget:', err);
  }
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  fetchGames();
});

// Load data once on page load
fetchGames();
