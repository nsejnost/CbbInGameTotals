// --- Projection Logic ---
// College basketball: two 20-minute halves
// 46.5% of points in 1st half, 53.5% in 2nd half
//
// Vegas-calibrated projection formula:
//   V = Pregame Vegas total, S = Current points scored
//   t1 = Minutes remaining in 1st half, t2 = Minutes remaining in 2nd half
//
//   1st half: Projected = S + V * (0.465 * (t1/20) + 0.535)
//   2nd half: Projected = S + V * (0.535 * (t2/20))

function parseClockMinutes(clockStr) {
  if (!clockStr || clockStr === '') return null;
  const parts = clockStr.split(':');
  if (parts.length !== 2) return null;
  const mins = parseInt(parts[0], 10);
  const secs = parseInt(parts[1], 10);
  if (isNaN(mins) || isNaN(secs)) return null;
  return mins + secs / 60;
}

function calculateProjectedTotal(currentTotal, period, timeRemainingStr, pregameTotal) {
  if (currentTotal === null) return null;

  const minutesRemaining = parseClockMinutes(timeRemainingStr);
  if (minutesRemaining === null || period === null) return null;

  const V = pregameTotal;

  if (V !== null && V > 0) {
    // Vegas-calibrated formula
    if (period === 1) {
      return currentTotal + V * (0.465 * (minutesRemaining / 20) + 0.535);
    } else if (period >= 2) {
      return currentTotal + V * (0.535 * (minutesRemaining / 20));
    }
  }

  // Fallback: pace-based projection when no pregame total available
  if (currentTotal === 0) return null;
  let proportion;
  if (period === 1) {
    const elapsed = 20 - minutesRemaining;
    proportion = elapsed * (0.465 / 20);
  } else if (period >= 2) {
    const elapsed = 20 - minutesRemaining;
    proportion = 0.465 + elapsed * (0.535 / 20);
  }
  if (proportion && proportion > 0) {
    return currentTotal / proportion;
  }
  return null;
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
  // Show error explanation instead of generic "Live"
  if (game.timeError) return `<span class="error-text">${game.timeError}</span>`;
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

function formatNumberOrError(val, error) {
  if (val !== null && val !== undefined) return val.toFixed(1);
  if (error) return `<span class="error-text">${error}</span>`;
  return '--';
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

    // Build projection error: explain why it's null
    let projDisplay;
    if (projected !== null) {
      projDisplay = projected.toFixed(1);
    } else if (game.gameStatus === 'scheduled' || game.gameStatus === 'final') {
      projDisplay = '--';
    } else if (game.projError) {
      projDisplay = `<span class="error-text">${game.projError}</span>`;
    } else {
      projDisplay = '--';
    }

    const projDk = (projected !== null && game.dkLiveTotal !== null)
      ? projected - game.dkLiveTotal : null;
    const projFd = (projected !== null && game.fdLiveTotal !== null)
      ? projected - game.fdLiveTotal : null;

    const errSpan = game.projError ? `<span class="error-text">${game.projError}</span>` : '--';
    const projDkDisplay = projDk !== null ? formatDiff(projDk) : (projected === null && game.projError ? errSpan : '--');
    const projFdDisplay = projFd !== null ? formatDiff(projFd) : (projected === null && game.projError ? errSpan : '--');

    return `<tr class="${getRowClass(game)}">
      <td>${formatTime(game.commenceTime)}</td>
      <td>${game.awayTeam}</td>
      <td>${game.homeTeam}</td>
      <td>${formatTimeRemaining(game)}</td>
      <td>${formatScore(game)}</td>
      <td>${formatNumberOrError(game.pregameTotal, game.pregameError)}</td>
      <td>${formatNumber(game.dkLiveTotal)}</td>
      <td>${formatNumber(game.fdLiveTotal)}</td>
      <td class="projected">${projDisplay}</td>
      <td class="${diffClass(projDk)}">${projDkDisplay}</td>
      <td class="${diffClass(projFd)}">${projFdDisplay}</td>
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
  } else if (data.espnStatus && !data.espnStatus.ok) {
    warning.textContent = `ESPN issue: ${data.espnStatus.error || 'unavailable'} — clock/pregame data may be missing.`;
    warning.classList.remove('hidden');
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
