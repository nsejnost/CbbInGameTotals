const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SPORT = 'basketball_ncaab';

// --- State ---
let cache = {
  scores: { data: null, timestamp: 0 },
  odds: { data: null, timestamp: 0 },
  espn: { data: null, timestamp: 0 },
};
let apiRequestCount = 0;
let maxApiBudget = 50;
let apiQuotaRemaining = null;
let apiQuotaUsed = null;

const CACHE_TTL_MS = 30000; // 30 seconds

// --- Helpers ---

async function fetchJson(url) {
  const res = await fetch(url);
  const headers = {
    remaining: res.headers.get('x-requests-remaining'),
    used: res.headers.get('x-requests-used'),
  };
  if (headers.remaining !== null) apiQuotaRemaining = parseInt(headers.remaining);
  if (headers.used !== null) apiQuotaUsed = parseInt(headers.used);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function getCachedScores() {
  const now = Date.now();
  if (cache.scores.data && now - cache.scores.timestamp < CACHE_TTL_MS) {
    return cache.scores.data;
  }
  if (apiRequestCount >= maxApiBudget) return cache.scores.data;

  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=1`;
  const data = await fetchJson(url);
  apiRequestCount++;
  cache.scores = { data, timestamp: now };
  return data;
}

async function getCachedOdds() {
  const now = Date.now();
  if (cache.odds.data && now - cache.odds.timestamp < CACHE_TTL_MS) {
    return cache.odds.data;
  }
  if (apiRequestCount >= maxApiBudget) return cache.odds.data;

  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&bookmakers=fanduel,draftkings&oddsFormat=american`;
  const data = await fetchJson(url);
  apiRequestCount++;
  cache.odds = { data, timestamp: now };
  return data;
}

async function getCachedEspn() {
  const now = Date.now();
  if (cache.espn.data && now - cache.espn.timestamp < CACHE_TTL_MS) {
    return cache.espn.data;
  }
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';
    const res = await fetch(url);
    if (!res.ok) return cache.espn.data;
    const data = await res.json();
    cache.espn = { data, timestamp: now };
    return data;
  } catch {
    return cache.espn.data;
  }
}

// Normalize team names for matching between Odds API and ESPN
function normalizeTeam(name) {
  return name
    .toLowerCase()
    .replace(/state/g, 'st')
    .replace(/university/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findEspnGame(espnData, homeTeam, awayTeam) {
  if (!espnData || !espnData.events) return null;
  const normHome = normalizeTeam(homeTeam);
  const normAway = normalizeTeam(awayTeam);

  for (const event of espnData.events) {
    const competitors = event.competitions?.[0]?.competitors || [];
    const espnHome = competitors.find(c => c.homeAway === 'home');
    const espnAway = competitors.find(c => c.homeAway === 'away');
    if (!espnHome || !espnAway) continue;

    const eHome = normalizeTeam(espnHome.team?.displayName || espnHome.team?.name || '');
    const eAway = normalizeTeam(espnAway.team?.displayName || espnAway.team?.name || '');
    const eHomeShort = normalizeTeam(espnHome.team?.shortDisplayName || '');
    const eAwayShort = normalizeTeam(espnAway.team?.shortDisplayName || '');

    if (
      (eHome.includes(normHome) || normHome.includes(eHome) || eHomeShort.includes(normHome) || normHome.includes(eHomeShort)) &&
      (eAway.includes(normAway) || normAway.includes(eAway) || eAwayShort.includes(normAway) || normAway.includes(eAwayShort))
    ) {
      const status = event.status || {};
      const competition = event.competitions?.[0] || {};
      return {
        clock: status.displayClock || '',
        period: status.period || 0,
        statusType: status.type?.name || '',
        statusDetail: status.type?.shortDetail || status.type?.detail || '',
      };
    }
  }
  return null;
}

function getBookmakerTotal(bookmakers, bookmakerKey) {
  if (!bookmakers) return null;
  const bk = bookmakers.find(b => b.key === bookmakerKey);
  if (!bk) return null;
  const market = bk.markets?.find(m => m.key === 'totals');
  if (!market) return null;
  const over = market.outcomes?.find(o => o.name === 'Over');
  return over ? over.point : null;
}

// --- Routes ---

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/settings', (req, res) => {
  const { maxBudget } = req.body;
  if (typeof maxBudget === 'number' && maxBudget > 0) {
    maxApiBudget = maxBudget;
  }
  res.json({ maxBudget: maxApiBudget, requestCount: apiRequestCount });
});

app.get('/api/status', (req, res) => {
  res.json({
    requestCount: apiRequestCount,
    maxBudget: maxApiBudget,
    apiQuotaRemaining,
    apiQuotaUsed,
    budgetExhausted: apiRequestCount >= maxApiBudget,
  });
});

app.get('/api/games', async (req, res) => {
  try {
    if (!ODDS_API_KEY) {
      return res.status(500).json({ error: 'ODDS_API_KEY not configured' });
    }

    const budgetExhausted = apiRequestCount >= maxApiBudget;

    // Fetch all data in parallel
    const [scores, odds, espn] = await Promise.all([
      getCachedScores(),
      getCachedOdds(),
      getCachedEspn(),
    ]);

    if (!scores || !odds) {
      return res.status(503).json({
        error: budgetExhausted
          ? 'API budget exhausted and no cached data available'
          : 'Failed to fetch data from Odds API',
      });
    }

    // Build odds lookup by event id
    const oddsMap = {};
    for (const event of odds) {
      oddsMap[event.id] = event;
    }

    // Merge scores + odds + ESPN clock
    const games = scores.map(scoreEvent => {
      const oddsEvent = oddsMap[scoreEvent.id];
      const bookmakers = oddsEvent?.bookmakers || [];

      // Get totals from each bookmaker
      const dkTotal = getBookmakerTotal(bookmakers, 'draftkings');
      const fdTotal = getBookmakerTotal(bookmakers, 'fanduel');

      // Pregame total: average of available bookmaker lines from odds data
      // (odds endpoint returns current lines; for pregame we use these if game hasn't started)
      const pregameTotal = dkTotal || fdTotal || null;

      // Current score
      const homeScore = scoreEvent.scores?.find(s => s.name === scoreEvent.home_team)?.score;
      const awayScore = scoreEvent.scores?.find(s => s.name === scoreEvent.away_team)?.score;
      const currentTotal = homeScore != null && awayScore != null
        ? parseInt(homeScore) + parseInt(awayScore)
        : null;

      // ESPN clock data
      const espnGame = findEspnGame(espn, scoreEvent.home_team, scoreEvent.away_team);

      // Determine game status and time
      let timeRemaining = null;
      let period = null;
      let gameStatus = 'scheduled'; // scheduled, live, halftime, final

      if (scoreEvent.completed) {
        gameStatus = 'final';
        timeRemaining = '0:00';
        period = 2;
      } else if (scoreEvent.scores && scoreEvent.scores.length > 0) {
        gameStatus = 'live';
        if (espnGame) {
          timeRemaining = espnGame.clock;
          period = espnGame.period;
          if (espnGame.statusType === 'STATUS_HALFTIME') {
            gameStatus = 'halftime';
          } else if (espnGame.statusType === 'STATUS_FINAL') {
            gameStatus = 'final';
          } else if (espnGame.statusType === 'STATUS_END_PERIOD' && espnGame.period === 1) {
            gameStatus = 'halftime';
          }
        }
      }

      return {
        id: scoreEvent.id,
        homeTeam: scoreEvent.home_team,
        awayTeam: scoreEvent.away_team,
        commenceTime: scoreEvent.commence_time,
        homeScore: homeScore != null ? parseInt(homeScore) : null,
        awayScore: awayScore != null ? parseInt(awayScore) : null,
        currentTotal,
        pregameTotal,
        dkLiveTotal: dkTotal,
        fdLiveTotal: fdTotal,
        timeRemaining,
        period,
        gameStatus,
      };
    });

    res.json({
      games,
      requestCount: apiRequestCount,
      maxBudget: maxApiBudget,
      apiQuotaRemaining,
      apiQuotaUsed,
      budgetExhausted,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error fetching games:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!ODDS_API_KEY) {
    console.warn('WARNING: ODDS_API_KEY is not set. Set it as an environment variable.');
  }
});
