const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
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

// Track ESPN fetch status for error reporting
let espnStatus = { ok: false, error: null, eventCount: 0 };

// Persistent cache of pregame totals keyed by game ID (from Odds API pre-match)
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

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${today}&limit=200`,
    `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?limit=200`,
  ];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        espnStatus = { ok: false, error: `ESPN HTTP ${res.status}`, eventCount: 0 };
        console.error(`ESPN API returned ${res.status}`);
        continue;
      }
      const data = await res.json();
      const eventCount = data.events?.length || 0;
      console.log(`ESPN: fetched ${eventCount} events from ${url.includes('dates=') ? 'dated' : 'default'} endpoint`);

      if (eventCount > 0) {
        espnStatus = { ok: true, error: null, eventCount };
        cache.espn = { data, timestamp: now };
        return data;
      }
      espnStatus = { ok: false, error: 'ESPN returned 0 events', eventCount: 0 };
    } catch (err) {
      const errMsg = err.name === 'AbortError' ? 'ESPN timeout (5s)' : `ESPN: ${err.message}`;
      espnStatus = { ok: false, error: errMsg, eventCount: 0 };
      console.error(`ESPN fetch error: ${errMsg}`);
    }
  }

  return cache.espn.data;
}

// --- Team Name Matching ---

const NOISE_WORDS = new Set(['university', 'of', 'the', 'state', 'st', 'at', 'a']);

function getSignificantWords(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !NOISE_WORDS.has(w));
}

function teamsMatch(name1, name2) {
  const words1 = getSignificantWords(name1);
  const words2 = getSignificantWords(name2);
  if (words1.length === 0 || words2.length === 0) return false;
  return words1.some(w => words2.includes(w));
}

function buildEspnLookup(espnData) {
  if (!espnData || !espnData.events) return [];

  return espnData.events.map(event => {
    const competitors = event.competitions?.[0]?.competitors || [];
    const espnHome = competitors.find(c => c.homeAway === 'home');
    const espnAway = competitors.find(c => c.homeAway === 'away');
    if (!espnHome || !espnAway) return null;

    const homeNames = [
      espnHome.team?.displayName,
      espnHome.team?.shortDisplayName,
      espnHome.team?.name,
      espnHome.team?.location,
      espnHome.team?.abbreviation,
    ].filter(Boolean);
    const awayNames = [
      espnAway.team?.displayName,
      espnAway.team?.shortDisplayName,
      espnAway.team?.name,
      espnAway.team?.location,
      espnAway.team?.abbreviation,
    ].filter(Boolean);

    const odds = event.competitions?.[0]?.odds;
    let overUnder = null;
    if (odds && odds.length > 0) {
      overUnder = odds[0].overUnder || null;
    }

    const status = event.status || {};

    return {
      homeNames,
      awayNames,
      overUnder,
      clock: status.displayClock || null,
      period: status.period || 0,
      statusType: status.type?.name || '',
      statusDetail: status.type?.shortDetail || status.type?.detail || '',
    };
  }).filter(Boolean);
}

function findEspnGame(espnLookup, homeTeam, awayTeam) {
  for (const espnEvent of espnLookup) {
    const homeMatches = espnEvent.homeNames.some(n => teamsMatch(homeTeam, n));
    const awayMatches = espnEvent.awayNames.some(n => teamsMatch(awayTeam, n));
    if (homeMatches && awayMatches) return espnEvent;
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

    const espnLookup = buildEspnLookup(espn);
    const espnAvailable = espnLookup.length > 0;

    const oddsMap = {};
    for (const event of odds) {
      oddsMap[event.id] = event;
    }

    const games = scores.map(scoreEvent => {
      const oddsEvent = oddsMap[scoreEvent.id];
      const bookmakers = oddsEvent?.bookmakers || [];

      const dkTotal = getBookmakerTotal(bookmakers, 'draftkings');
      const fdTotal = getBookmakerTotal(bookmakers, 'fanduel');

      const homeScore = scoreEvent.scores?.find(s => s.name === scoreEvent.home_team)?.score;
      const awayScore = scoreEvent.scores?.find(s => s.name === scoreEvent.away_team)?.score;
      const currentTotal = homeScore != null && awayScore != null
        ? parseInt(homeScore) + parseInt(awayScore)
        : null;

      const isLive = !scoreEvent.completed && scoreEvent.scores && scoreEvent.scores.length > 0;
      const isScheduled = !scoreEvent.completed && (!scoreEvent.scores || scoreEvent.scores.length === 0);

      // Cache Odds API pregame totals when games are still scheduled
      if (isScheduled && (dkTotal || fdTotal)) {
        const totals = [dkTotal, fdTotal].filter(t => t !== null);
        pregameTotalsCache[scoreEvent.id] = totals.reduce((a, b) => a + b, 0) / totals.length;
      }

      // ESPN match
      const espnGame = findEspnGame(espnLookup, scoreEvent.home_team, scoreEvent.away_team);

      // Pregame total with error tracking
      let pregameTotal = null;
      let pregameError = null;
      if (espnGame?.overUnder) {
        pregameTotal = espnGame.overUnder;
      } else if (pregameTotalsCache[scoreEvent.id]) {
        pregameTotal = pregameTotalsCache[scoreEvent.id];
      } else if (!espnAvailable) {
        pregameError = espnStatus.error || 'ESPN unavailable';
      } else if (!espnGame) {
        pregameError = 'ESPN: no match';
      } else {
        pregameError = 'No odds data';
      }

      // Live totals
      const dkLiveTotal = isLive ? dkTotal : null;
      const fdLiveTotal = isLive ? fdTotal : null;

      // Game status and time with error tracking
      let timeRemaining = null;
      let period = null;
      let gameStatus = 'scheduled';
      let timeError = null;

      if (scoreEvent.completed) {
        gameStatus = 'final';
        timeRemaining = '0:00';
        period = 2;
      } else if (isLive) {
        gameStatus = 'live';
        if (espnGame && espnGame.clock) {
          timeRemaining = espnGame.clock;
          period = espnGame.period;
          if (espnGame.statusType === 'STATUS_HALFTIME') {
            gameStatus = 'halftime';
          } else if (espnGame.statusType === 'STATUS_FINAL') {
            gameStatus = 'final';
          } else if (espnGame.statusType === 'STATUS_END_PERIOD' && espnGame.period === 1) {
            gameStatus = 'halftime';
          }
        } else if (!espnAvailable) {
          timeError = espnStatus.error || 'ESPN unavailable';
        } else if (!espnGame) {
          timeError = 'ESPN: no match for game';
        } else {
          timeError = 'ESPN: no clock data';
        }
      }

      // Projection error tracking
      let projError = null;
      if (isLive) {
        if (currentTotal === null) {
          projError = 'No score data';
        } else if (timeRemaining === null || period === null) {
          projError = timeError || 'No clock data';
        } else if (pregameTotal === null) {
          projError = 'No pregame total (pace fallback)';
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
        pregameError,
        dkLiveTotal,
        fdLiveTotal,
        timeRemaining,
        period,
        gameStatus,
        timeError,
        projError,
        espnMatched: !!espnGame,
      };
    });

    // Log match results
    const matched = games.filter(g => g.espnMatched).length;
    const liveGames = games.filter(g => g.gameStatus === 'live' || g.gameStatus === 'halftime').length;
    console.log(`Games: ${games.length} total, ${liveGames} live, ${matched} ESPN-matched, ${espnLookup.length} ESPN events`);

    res.json({
      games,
      requestCount: apiRequestCount,
      maxBudget: maxApiBudget,
      apiQuotaRemaining,
      apiQuotaUsed,
      budgetExhausted,
      espnStatus,
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

  const espnLookup = buildEspnLookup(espn);

  const espnTeams = espnLookup.map(e => ({
    home: e.homeNames,
    away: e.awayNames,
    overUnder: e.overUnder,
    status: e.statusType,
    clock: e.clock,
    period: e.period,
  }));

  const oddsApiTeams = (scores || []).map(s => {
    const espnMatch = findEspnGame(espnLookup, s.home_team, s.away_team);
    return {
      id: s.id,
      home: s.home_team,
      away: s.away_team,
      hasScores: !!(s.scores && s.scores.length > 0),
      completed: s.completed,
      espnMatched: !!espnMatch,
      espnOverUnder: espnMatch?.overUnder || null,
      espnClock: espnMatch?.clock || null,
      espnPeriod: espnMatch?.period || null,
    };
  });

  res.json({
    espnEventCount: espn?.events?.length || 0,
    espnStatus,
    espnTeams,
    oddsApiTeams,
    pregameTotalsCache,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  if (!ODDS_API_KEY) {
    console.warn('WARNING: ODDS_API_KEY is not set. Set it as an environment variable.');
  }
});
