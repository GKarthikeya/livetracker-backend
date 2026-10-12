/**
 * scraper.js - Puppeteer scraper for 1xbet live cricket
 * Enhanced with page dump for debugging + better selectors
 */

const puppeteer = require('puppeteer');
const { EventEmitter } = require('events');
const store = require('../store/dataStore');

const SCRAPE_INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS, 10) || 25000;
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
    this._cycleCount = 0;
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
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1280,900',
        ],
      });
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 900 });

      // Hide automation
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
      });

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
    this._cycleCount++;
    try {
      await this._ensureBrowser();
      await this._scrapeLivePage();
    } catch (err) {
      console.error('[Scraper] Cycle error:', err.message);
    }
    this._timer = setTimeout(() => this._runCycle(), SCRAPE_INTERVAL_MS);
  }

  async _scrapeLivePage() {
    try {
      console.log('[Scraper] Loading 1xbet Cricket page...');
      await this.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Wait longer for JS to render
      await new Promise(r => setTimeout(r, 6000));

      // Log page title to verify it loaded
      const title = await this.page.title();
      const url = this.page.url();
      console.log(`[Scraper] Page: "${title}" | URL: ${url}`);

      // Check if we got blocked/redirected
      if (url.includes('blocked') || url.includes('captcha') || url.includes('403')) {
        console.log('[Scraper] BLOCKED by 1xbet - using seed data');
        this.emit('update', store.getAllEvents());
        return;
      }

      // Dump first 500 chars of body text to see what loaded
      const bodyText = await this.page.evaluate(() =>
        document.body?.innerText?.substring(0, 500) || 'EMPTY'
      );
      console.log('[Scraper] Page text preview:', bodyText.replace(/\n/g, ' ').substring(0, 200));

      // Try multiple selectors to find cricket content
      const pageContent = await this.page.evaluate(() => {
        const allText = document.body?.innerText?.toLowerCase() || '';
        const hasAgra = allText.includes('agra');
        const hasAkluj = allText.includes('akluj');
        const hasChandigarh = allText.includes('chandigarh');
        const hasCricket = allText.includes('cricket');

        return {
          hasAgra, hasAkluj, hasChandigarh, hasCricket,
          totalLength: allText.length,
          preview: allText.substring(0, 300)
        };
      });

      console.log(`[Scraper] Content check - cricket:${pageContent.hasCricket} agra:${pageContent.hasAgra} akluj:${pageContent.hasAkluj} chandigarh:${pageContent.hasChandigarh} length:${pageContent.totalLength}`);

      if (!pageContent.hasCricket && pageContent.totalLength < 1000) {
        console.log('[Scraper] Page too short - 1xbet likely blocked this IP. Using seed data.');
        this.emit('update', store.getAllEvents());
        return;
      }

      // Now scan for cricket cards
      const cards = await this.page.evaluate(() => {
        const results = [];
        const seen = new Set();
        const LEAGUES = [['agra', 'women'], ['akluj'], ['chandigarh']];

        function textOf(el) { return (el.innerText || el.textContent || '').trim(); }

        // Try finding by text content
        const allEls = Array.from(document.querySelectorAll('*'));
        for (const el of allEls) {
          const t = textOf(el).toLowerCase();
          if (t.length < 4 || t.length > 150) continue;
          const matched = LEAGUES.find(kws => kws.every(k => t.includes(k)));
          if (!matched) continue;

          let card = el;
          for (let i = 0; i < 12; i++) {
            if (!card.parentElement) break;
            card = card.parentElement;
            const ct = textOf(card);
            if (ct.length > 80 && /\d/.test(ct)) break;
          }

          const key = textOf(card).substring(0, 100);
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            leagueText: t,
            rawText: textOf(card).toLowerCase(),
            lines: textOf(card).split('\n').map(s => s.trim()).filter(s => s.length > 0),
          });
        }
        return results;
      });

      console.log(`[Scraper] Found ${cards.length} cricket card(s).`);
      if (cards.length > 0) {
        cards.forEach(c => console.log(`  Card lines: ${JSON.stringify(c.lines.slice(0, 8))}`));
      }

      let foundAny = false;
      for (const [eventId, keywords] of Object.entries(EVENT_KEYWORDS)) {
        const card = cards.find(c => keywords.every(k => c.rawText.includes(k)));
        if (!card) {
          console.log(`[Scraper] Not found: ${eventId}`);
          continue;
        }

        foundAny = true;

        // Parse teams
        const UI = ['t20','t10','odi','team wins','1x2','live','total','event in progress',
          'agra','akluj','chandigarh','league','championship','district','womens','rural','cricket'];
        const teams = card.lines.filter(line => {
          const l = line.toLowerCase();
          if (/^[\d\/\.\s\(\)ov]+$/i.test(line)) return false;
          if (line.length < 3 || /^\+\d+$/.test(line)) return false;
          if (UI.some(w => l === w || l.startsWith(w + ' '))) return false;
          if (!/^[A-Z]/.test(line)) return false;
          return true;
        });

        let homeScore = '', awayScore = '', over = '';
        for (const line of card.lines) {
          const m = line.match(/^(\d+(?:\/\d+)?)\s*(?:\((\d+\.\d+)(?:\s*ov)?\))?/i);
          if (m) {
            if (!homeScore) { homeScore = m[1]; if (m[2]) over = m[2]; }
            else if (!awayScore) { awayScore = m[1]; }
          }
        }

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
        console.log(`[Scraper] ✓ ${eventId} | ${teams[0]} vs ${teams[1]} | ${homeScore}/${awayScore}`);
      }

      if (!foundAny) {
        console.log('[Scraper] No cards found - keeping existing store data');
      }

    } catch (err) {
      console.warn('[Scraper] Scrape error:', err.message);
    }

    this.emit('update', store.getAllEvents());
  }
}

module.exports = new Scraper();
