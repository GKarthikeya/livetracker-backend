/**
 * scraper.js
 * Uses 1xbet's internal LineFeed API - works without a browser
 */

const https = require('https');
const { EventEmitter } = require('events');
const store = require('../store/dataStore');

const SCRAPE_INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS, 10) || 20000;

// Target leagues
const TARGET_LEAGUES = [
  { id: 'agra-district-womens-league', keywords: ['agra'] },
  { id: 'akluj-rural-championship',    keywords: ['akluj'] },
  { id: 'chandigarh-league',           keywords: ['chandigarh'] },
];

// Rotate user agents to avoid blocks
const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 13; CPH2731) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function getUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function fetchJson(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': getUA(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Referer': 'https://1xbet.com/en/live/Cricket',
        'Origin': 'https://1xbet.com',
        ...extraHeaders,
      },
    };
    const req = https.get(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

class Scraper extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this._timer  = null;
    this._failCount = 0;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('[Scraper] Starting API-based scraper...');
    await this._runCycle();
  }

  async stop() {
    this.running = false;
    clearTimeout(this._timer);
  }

  async forceRefresh() {
    clearTimeout(this._timer);
    await this._runCycle();
  }

  async _runCycle() {
    if (!this.running) return;
    try {
      await this._scrape();
    } catch (err) {
      console.error('[Scraper] Cycle error:', err.message);
    }
    this._timer = setTimeout(() => this._runCycle(), SCRAPE_INTERVAL_MS);
  }

  async _scrape() {
    // Try multiple 1xbet API endpoints
    const endpoints = [
      // Live cricket - direct JSON API
      'https://1xbet.com/LineFeed/GetGameZip?id=0&lng=en&isSubGames=true&GroupEvents=true&countryId=0&grType=0&sportAlias=Cricket&isLeagues=false&tf=0',
      'https://1xbet.com/LineFeed/GetCoupons?id=0&lng=en&grType=0&tf=0&tz=5.5&isLive=true&sport=Cricket',
      'https://1xbet.com/LineFeed/GetGameZip?id=0&lng=en&sports=Cricket&isLive=true',
    ];

    for (const url of endpoints) {
      try {
        console.log(`[Scraper] Trying: ${url.substring(0, 70)}...`);
        const res = await fetchJson(url);
        console.log(`[Scraper] Response: status=${res.status} length=${res.data.length}`);

        if (res.status !== 200 || res.data.length < 50) {
          console.log(`[Scraper] Skip - bad response`);
          continue;
        }

        // Log first 200 chars to see what we got
        console.log(`[Scraper] Data preview: ${res.data.substring(0, 200)}`);

        try {
          const json = JSON.parse(res.data);
          const found = this._parseAndUpdate(json);
          if (found) {
            this._failCount = 0;
            this.emit('update', store.getAllEvents());
            return;
          }
        } catch (e) {
          console.log(`[Scraper] JSON parse error: ${e.message}`);
        }
      } catch (e) {
        console.log(`[Scraper] Request failed: ${e.message}`);
      }
    }

    // All endpoints failed
    this._failCount++;
    console.log(`[Scraper] All APIs failed (${this._failCount}x) - store has seed data`);
    this.emit('update', store.getAllEvents());
  }

  _parseAndUpdate(json) {
    // Try different response structures
    const eventArrays = [
      json.Value,
      json.data,
      json.events,
      json.Games,
      Array.isArray(json) ? json : null,
    ].filter(Boolean);

    for (const arr of eventArrays) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      console.log(`[Scraper] Checking array of ${arr.length} events`);

      let found = false;
      for (const ev of arr) {
        // Extract league/tournament name
        const leagueName = (
          ev.League || ev.SN || ev.league || ev.name ||
          ev.GameName || ev.sportName || ''
        ).toLowerCase();

        if (!leagueName) continue;

        for (const target of TARGET_LEAGUES) {
          if (target.keywords.every(k => leagueName.includes(k))) {
            console.log(`[Scraper] Match found: ${leagueName}`);

            // Extract scores
            const sc = ev.SC || ev.score || {};
            const fs = sc.FS || sc.fullScore || {};
            const homeScore = fs.S1 != null ? String(fs.S1) : '';
            const awayScore = fs.S2 != null ? String(fs.S2) : '';
            const over = sc.CG != null ? String(sc.CG) : '';

            // Extract odds
            const evts = ev.E || ev.odds || ev.events || [];
            const w1 = parseFloat(evts[0]?.CE || evts[0]?.C || evts[0]?.value || 0);
            const draw = parseFloat(evts[1]?.CE || evts[1]?.C || evts[1]?.value || 0);
            const w2 = parseFloat(evts[2]?.CE || evts[2]?.C || evts[2]?.value || 0);

            store.updateEvent(target.id, {
              status: 'live',
              teams: {
                home: ev.O1 || ev.T1 || ev.homeTeam || ev.home || '—',
                away: ev.O2 || ev.T2 || ev.awayTeam || ev.away || '—',
              },
              score: { home: homeScore, away: awayScore },
              over,
              period: over ? `Over ${over}` : 'In Progress',
              ratios: { home: w1 || null, draw: draw || null, away: w2 || null },
            });

            console.log(`[Scraper] ✓ ${target.id} updated`);
            found = true;
          }
        }
      }
      if (found) return true;
    }
    return false;
  }
}

module.exports = new Scraper();
