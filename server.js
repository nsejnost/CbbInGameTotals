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

// Persistent cache of pregame totals keyed by game ID
// Stores the totals seen when a game was still "scheduled" (not started)
const pregameTotalsCache = {};

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

// Word-overlap team name matching between Odds API and ESPN
const NOISE_WORDS = new Set(['university', 'of', 'the', 'state', 'st', 'at']);

function getSignificantWords(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0 && !NOISE_WORDS.has(w));
}

function teamsMatch(name1, name2) {
  const words1 = getSignificantWords(name1);
  const words2 = getSignificantWords(name2);
  // Match if at least one significant word overlaps
  return words1.some(w => words2.includes(w));
}

function findEspnGame(espnData, homeTeam, awayTeam) {
  if (!espnData || !espnData.events) return null;

  for (const event of espnData.events) {
    const competitors = event.competitions?.[0]?.competitors || [];
    const espnHome = competitors.find(c => c.homeAway === 'home');
    const espnAway = competitors.find(c => c.homeAway === 'away');
    if (!espnHome || !espnAway) continue;

    // Collect all ESPN name variants for each team
    const espnHomeNames = [
      espnHome.team?.displayName,
      espnHome.team?.shortDisplayName,
      espnHome.team?.name,
      espnHome.team?.abbreviation,
    ].filter(Boolean);
    const espnAwayNames = [
      espnAway.team?.displayName,
      espnAway.team?.shortDisplayName,
      espnAway.team?.name,
      espnAway.team?.abbreviation,
    ].filter(Boolean);

    const homeMatches = espnHomeNames.some(n => teamsMatch(homeTeam, n));
    const awayMatches = espnAwayNames.some(n => teamsMatch(awayTeam, n));

    if (homeMatches && awayMatches) {
      const status = event.status || {};
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

      // Get current totals from each bookmaker (these are live-adjusted for in-progress games)
      const dkTotal = getBookmakerTotal(bookmakers, 'draftkings');
      const fdTotal = getBookmakerTotal(bookmakers, 'fanduel');

      // Current score
      const homeScore = scoreEvent.scores?.find(s => s.name === scoreEvent.home_team)?.score;
      const awayScore = scoreEvent.scores?.find(s => s.name === scoreEvent.away_team)?.score;
      const currentTotal = homeScore != null && awayScore != null
        ? parseInt(homeScore) + parseInt(awayScore)
        : null;

      const isLive = !scoreEvent.completed && scoreEvent.scores && scoreEvent.scores.length > 0;
      const isScheduled = !scoreEvent.completed && (!scoreEvent.scores || scoreEvent.scores.length === 0);

      // Pregame totals: capture when game is still scheduled, use cached value once live
      if (isScheduled && (dkTotal || fdTotal)) {
        // Average the available bookmaker lines for pregame total
        const totals = [dkTotal, fdTotal].filter(t => t !== null);
        pregameTotalsCache[scoreEvent.id] = totals.reduce((a, b) => a + b, 0) / totals.length;
      }
      const pregameTotal = pregameTotalsCache[scoreEvent.id] || null;

      // Live totals: only show for in-progress games (these are live-adjusted lines)
      const dkLiveTotal = isLive ? dkTotal : null;
      const fdLiveTotal = isLive ? fdTotal : null;

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
        dkLiveTotal,
        fdLiveTotal,
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

app.get('/api/debug', async (req, res) => {
  const espn = await getCachedEspn();
  const scores = cache.scores.data;

  const espnTeams = (espn?.events || []).map(e => {
    const comp = e.competitions?.[0]?.competitors || [];
    const home = comp.find(c => c.homeAway === 'home');
    const away = comp.find(c => c.homeAway === 'away');
    return {
      home: {
        displayName: home?.team?.displayName,
        shortDisplayName: home?.team?.shortDisplayName,
        name: home?.team?.name,
        abbreviation: home?.team?.abbreviation,
      },
      away: {
        displayName: away?.team?.displayName,
        shortDisplayName: away?.team?.shortDisplayName,
        name: away?.team?.name,
        abbreviation: away?.team?.abbreviation,
      },
      status: e.status?.type?.name,
      clock: e.status?.displayClock,
      period: e.status?.period,
    };
  });

  const oddsApiTeams = (scores || []).map(s => ({
    id: s.id,
    home: s.home_team,
    away: s.away_team,
    hasScores: !!(s.scores && s.scores.length > 0),
    completed: s.completed,
    espnMatch: findEspnGame(espn, s.home_team, s.away_team) ? 'MATCHED' : 'NO MATCH',
  }));

  res.json({ espnTeams, oddsApiTeams, pregameTotalsCache });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!ODDS_API_KEY) {
    console.warn('WARNING: ODDS_API_KEY is not set. Set it as an environment variable.');
  }
});
