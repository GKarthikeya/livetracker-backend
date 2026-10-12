/**
 * scraper.js - Puppeteer scraper for 1xbet live cricket
 * Works on Railway.app (has Chrome installed)
 */

const puppeteer = require('puppeteer');
const { EventEmitter } = require('events');
const store = require('../store/dataStore');

const SCRAPE_INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS, 10) || 20000;
const BASE_URL = 'https://1xbet.com/en/live/Cricket';

const EVENT_KEYWORDS = {
  'agra-district-womens-league': ['agra', 'women'],
  'akluj-rural-championship':    ['akluj'],
  'chandigarh-league':           ['chandigarh'],
};

class Scraper extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.page    = null;
    this.running = false;
    this._timer  = null;
    this.loggedIn = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('[Scraper] Starting...');
    await this._launchBrowser();
    await this._runCycle();
  }

  async stop() {
    this.running = false;
    clearTimeout(this._timer);
    await this.browser?.close().catch(() => {});
  }

  async forceRefresh() {
    clearTimeout(this._timer);
    await this._runCycle();
  }

  async _launchBrowser() {
    try {
      this.browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--window-size=1280,900',
        ],
      });
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 900 });
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
      );
      await this.page.setRequestInterception(true);
      this.page.on('request', req => {
        if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
      });
      console.log('[Scraper] Browser launched.');
    } catch (err) {
      console.error('[Scraper] Launch failed:', err.message);
    }
  }

  async _ensureBrowser() {
    if (!this.browser?.isConnected()) {
      console.warn('[Scraper] Relaunching browser...');
      await this._launchBrowser();
      this.loggedIn = false;
    }
  }

  async _runCycle() {
    if (!this.running) return;
    try {
      await this._ensureBrowser();
      if (!this.loggedIn) await this._login();
      await this._scrapeLivePage();
    } catch (err) {
      console.error('[Scraper] Cycle error:', err.message);
    }
    this._timer = setTimeout(() => this._runCycle(), SCRAPE_INTERVAL_MS);
  }

  async _login() {
    const username = process.env.ONEX_USERNAME;
    const password = process.env.ONEX_PASSWORD;
    if (!username || username === 'your_demo_username') {
      console.log('[Scraper] No credentials - using public data.');
      this.loggedIn = true;
      return;
    }
    try {
      console.log('[Scraper] Logging in...');
      await this.page.goto('https://1xbet.com/en', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(2000);
      await this.page.evaluate(() => {
        const btn = document.querySelector('.btn-login, [class*="login"]');
        if (btn) btn.click();
      });
      await this.page.waitForTimeout(1500);
      await this.page.type('input[name="login"], input[type="text"]', username, { delay: 50 }).catch(() => {});
      await this.page.type('input[name="password"], input[type="password"]', password, { delay: 50 }).catch(() => {});
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(3000);
      this.loggedIn = true;
      console.log('[Scraper] Login done.');
    } catch (err) {
      console.warn('[Scraper] Login failed:', err.message);
      this.loggedIn = true;
    }
  }

  async _scrapeLivePage() {
    try {
      await this.page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await this.page.waitForTimeout(3000);
    } catch (err) {
      console.warn('[Scraper] Nav error:', err.message);
      return;
    }

    const cards = await this.page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const LEAGUES = [['agra', 'women'], ['akluj'], ['chandigarh']];

      function textOf(el) { return (el.innerText || el.textContent || '').trim(); }

      document.querySelectorAll('*').forEach(el => {
        const t = textOf(el).toLowerCase();
        if (t.length < 4 || t.length > 120) return;
        const matched = LEAGUES.find(kws => kws.every(k => t.includes(k)));
        if (!matched) return;

        let card = el;
        for (let i = 0; i < 10; i++) {
          if (!card.parentElement) break;
          card = card.parentElement;
          const ct = textOf(card);
          if (ct.length > 60 && /\d+[.,]\d+/.test(ct)) break;
        }

        const key = textOf(card).substring(0, 80);
        if (seen.has(key)) return;
        seen.add(key);

        results.push({
          leagueText: t,
          rawText: textOf(card).toLowerCase(),
          lines: textOf(card).split('\n').map(s => s.trim()).filter(s => s.length > 0),
        });
      });
      return results;
    });

    console.log(`[Scraper] Found ${cards.length} cricket card(s).`);

    for (const [eventId, keywords] of Object.entries(EVENT_KEYWORDS)) {
      const card = cards.find(c => keywords.every(k => c.rawText.includes(k)));
      if (!card) {
        console.log(`[Scraper] Not found: ${eventId}`);
        continue;
      }

      // Parse teams
      const UI = ['t20','t10','odi','team wins','1x2','live','total','event in progress',
        'agra','akluj','chandigarh','league','championship','district','womens','rural','u','+7','w1','w2','cricket'];
      const teams = card.lines.filter(line => {
        const l = line.toLowerCase();
        if (/^[\d\/\.\s\(\)ov]+$/i.test(line)) return false;
        if (line.length < 3 || /^\+\d+$/.test(line)) return false;
        if (UI.some(w => l === w || l.startsWith(w + ' '))) return false;
        if (!/^[A-Z]/.test(line)) return false;
        return true;
      });

      // Parse scores
      let homeScore = '', awayScore = '', over = '';
      for (const line of card.lines) {
        const m = line.match(/^(\d+(?:\/\d+)?)\s*(?:\((\d+\.\d+)(?:\s*ov)?\))?/i);
        if (m) {
          if (!homeScore) { homeScore = m[1]; if (m[2]) over = m[2]; }
          else if (!awayScore) { awayScore = m[1]; }
        }
      }

      // Parse odds
      const odds = card.lines
        .filter(l => /^\d{1,2}\.\d{2,4}$/.test(l.trim()))
        .map(l => parseFloat(l))
        .filter(v => v >= 1.01 && v < 10);

      store.updateEvent(eventId, {
        status: 'live',
        teams: { home: teams[0] || '—', away: teams[1] || '—' },
        score: { home: homeScore, away: awayScore },
        over,
        period: over ? `Over ${over}` : 'In Progress',
        ratios: { home: odds[0] ?? null, draw: null, away: odds[1] ?? null }
      });
      console.log(`[Scraper] ✓ ${eventId} | ${teams[0]} vs ${teams[1]} | ${homeScore}/${awayScore} | ${over}ov`);
    }

    this.emit('update', store.getAllEvents());
  }
}

module.exports = new Scraper();

