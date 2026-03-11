# CBB In-Game Totals

A college basketball in-game projected totals calculator.

## Overview

This app tracks live NCAA basketball games and calculates projected final totals based on current score, game clock, and pregame betting lines. It pulls data from the Odds API (scores + odds) and ESPN's public scoreboard API.

## Architecture

- **Backend**: Node.js + Express (`server.js`) — serves both the API and static frontend files
- **Frontend**: Vanilla HTML/CSS/JS in `public/` (`index.html`, `styles.css`, `app.js`)
- **Port**: 5000 (0.0.0.0)

## Key Files

- `server.js` — Express server, API routes, data fetching and caching
- `public/index.html` — Main UI page
- `public/app.js` — Frontend logic, projection calculations, table rendering
- `public/styles.css` — Styling

## Environment Variables

- `ODDS_API_KEY` — Required. API key from [The Odds API](https://the-odds-api.com/) for fetching live scores and betting odds.

## API Routes

- `GET /api/games` — Returns merged game data (scores + odds + ESPN clock)
- `GET /api/status` — Returns API request count and quota info
- `POST /api/settings` — Sets max API request budget

## Projection Logic

College basketball uses two 20-minute halves. The projection assumes:
- 46.5% of points scored in the 1st half
- 53.5% of points scored in the 2nd half

Projected total = `currentTotal / expectedProportionScored`

## Running

```bash
npm install
node server.js
```

## Deployment

Configured for autoscale deployment via `node server.js`.
