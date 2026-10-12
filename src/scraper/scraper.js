/**
 * scraper.js - Fetches live cricket data
 * Uses 1xbet API with fallback to demo data
 */

const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const store = require('../store/dataStore');

const SCRAPE_INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS, 10) || 20000;

const TARGET_LEAGUES = [
  { id: 'agra-district-womens-league', keywords: ['agra'] },
  { id: 'akluj-rural-championship',    keywords: ['akluj'] },
  { id: 'chandigarh-league',           keywords: ['chandigarh'] },
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; CPH2731) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://1xbet.com',
        'Referer': 'https://1xbet.com/en/live/Cricket',
      },
    };
    const req = proto.get(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

class Scraper extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this._timer  = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('[Scraper] Starting...');
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
      console.error('[Scraper] Error:', err.message);
    }
    this._timer = setTimeout(() => this._runCycle(), SCRAPE_INTERVAL_MS);
  }

  async _scrape() {
    // Try 1xbet live cricket API
    const apiUrls = [
      'https://1xbet.com/LineFeed/GetGameZip?id=0&lng=en&isSubGames=true&GroupEvents=true&countryId=0&grType=0&sportAlias=Cricket',
      'https://1xbet.com/LineFeed/Get1x2_3?sportId=1&chunkSize=50&lng=en&LiveEvents=true',
    ];

    for (const url of apiUrls) {
      try {
        console.log('[Scraper] Trying API...');
        const res = await fetchJson(url);
        if (res.status === 200 && res.data.length > 200) {
          const found = this._parseAndUpdate(res.data);
          if (found) {
            console.log('[Scraper] Got live data from API!');
            this.emit('update', store.getAllEvents());
            return;
          }
        }
      } catch (e) {
        console.log('[Scraper] API error:', e.message);
      }
    }

    // Fallback: use realistic demo data
    console.log('[Scraper] Using demo data');
    this._updateDemoData();
    this.emit('update', store.getAllEvents());
  }

  _parseAndUpdate(raw) {
    try {
      const json = JSON.parse(raw);
      const events = json.Value || json.data || [];
      if (!Array.isArray(events) || events.length === 0) return false;

      let found = false;
      for (const ev of events) {
        const name = (ev.League || ev.SN || ev.name || '').toLowerCase();
        for (const target of TARGET_LEAGUES) {
          if (target.keywords.every(k => name.includes(k))) {
            const homeScore = ev.SC?.FS?.S1 != null ? String(ev.SC.FS.S1) : '';
            const awayScore = ev.SC?.FS?.S2 != null ? String(ev.SC.FS.S2) : '';
            const over = ev.SC?.CG != null ? String(ev.SC.CG) : '';
            const odds = ev.E || [];
            store.updateEvent(target.id, {
              status: 'live',
              teams: {
                home: ev.O1 || ev.T1 || 'Home',
                away: ev.O2 || ev.T2 || 'Away'
              },
              score: { home: homeScore, away: awayScore },
              over,
              period: over ? `Over ${over}` : 'In Progress',
              ratios: {
                home: parseFloat(odds[0]?.CE || odds[0]?.C || 0),
                draw: parseFloat(odds[1]?.CE || odds[1]?.C || 0),
                away: parseFloat(odds[2]?.CE || odds[2]?.C || 0),
              }
            });
            console.log(`[Scraper] ✓ ${target.id} | score: ${homeScore}/${awayScore}`);
            found = true;
          }
        }
      }
      return found;
    } catch (e) {
      console.log('[Scraper] Parse error:', e.message);
      return false;
    }
  }

  _updateDemoData() {
    // Realistic demo - scores change slightly each cycle to simulate live
    const now = Date.now();
    const tick = Math.floor(now / 20000); // changes every 20s

    store.updateEvent('agra-district-womens-league', {
      status: 'live',
      teams: { home: 'AG Sports (Women)', away: 'Agra Royals (Women)' },
      score: { home: `${53 + (tick % 8)}/0`, away: '' },
      over: `${7 + (tick % 5)}.${tick % 6}`,
      period: 'In Progress',
      ratios: { home: 1.78, draw: 0, away: 2.01 }
    });

    store.updateEvent('akluj-rural-championship', {
      status: 'soon',
      teams: { home: '—', away: '—' },
      score: { home: '', away: '' },
      over: '',
      period: 'Starting Soon',
      ratios: { home: 0, draw: 0, away: 0 }
    });

    store.updateEvent('chandigarh-league', {
      status: 'live',
      teams: { home: 'Tanaji Cricketers', away: 'Shani Shignapur Sports' },
      score: { home: `${20 + (tick % 12)}/1`, away: '' },
      over: `${1 + (tick % 3)}.${tick % 6}`,
      period: 'In Progress',
      ratios: { home: 2.15, draw: 0, away: 1.685 }
    });
  }
}

module.exports = new Scraper();
