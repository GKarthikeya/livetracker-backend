/**
 * scraper.js
 * Puppeteer scraper for 1xbet live sports.
 *
 * Page structure (confirmed from live screenshot):
 *
 *   [Card]
 *     League name:  "Akluj Rural Championship"
 *     T20
 *     Team 1:  "Red Raiders"          Score: "182"
 *     Team 2:  "Lonar Leons"          Score: "130/4 (14.1 ov)"
 *     "Team Wins" or "1X2"
 *     W1  2.216   [X  25]   W2  1.605
 *
 * Strategy:
 *   1. Load the live Cricket page.
 *   2. Find every event card by looking for elements that contain
 *      our league name keywords.
 *   3. From each matched card, extract teams, scores, overs, odds.
 */

const puppeteer = require('puppeteer');
const { EventEmitter } = require('events');
const store = require('../store/dataStore');

const SCRAPE_INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS, 10) || 15000;
const BASE_URL = 'https://1-x-bet-india.com/en/live/Cricket';

// Keywords to identify each event's card (lowercase)
const EVENT_KEYWORDS = {
  'agra-district-womens-league':  ['agra', 'district', 'women'],
  'akluj-rural-championship':     ['akluj', 'rural'],
  'chandigarh-league':            ['chandigarh'],
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

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('[Scraper] Starting…');
    await this._launchBrowser();
    await this._runCycle();
  }

  async stop() {
    this.running = false;
    clearTimeout(this._timer);
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page    = null;
    }
    console.log('[Scraper] Stopped.');
  }

  async forceRefresh() {
    clearTimeout(this._timer);
    await this._runCycle();
  }

  // ── browser ──────────────────────────────────────────────────────────────────

  async _launchBrowser() {
    try {
      this.browser = await puppeteer.launch({
        headless: 'new',
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
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );
      // Block heavy resources to speed things up
      await this.page.setRequestInterception(true);
      this.page.on('request', (req) => {
        if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
      });
      console.log('[Scraper] Browser launched.');
    } catch (err) {
      console.error('[Scraper] Launch failed:', err.message);
    }
  }

  async _ensureBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      console.warn('[Scraper] Browser gone — relaunching…');
      await this._launchBrowser();
      this.loggedIn = false;
    }
  }

  // ── cycle ────────────────────────────────────────────────────────────────────

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

    if (!username || !password ||
        username === 'your_demo_username' || password === 'your_demo_password') {
      console.log('[Scraper] No credentials set — using public data.');
      this.loggedIn = true;
      return;
    }

    try {
      console.log('[Scraper] Logging in…');
      await this.page.goto('https://1-x-bet-india.com/en', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await this.page.waitForTimeout(2000);

      // Click login button
      await this.page.evaluate(() => {
        const btn = document.querySelector(
          '.btn-login, .login-button, [class*="login"], a[href*="login"]'
        );
        if (btn) btn.click();
      });
      await this.page.waitForTimeout(1500);

      // Fill fields
      await this.page.type('input[name="login"], input[type="text"]', username, { delay: 50 }).catch(() => {});
      await this.page.type('input[name="password"], input[type="password"]', password, { delay: 50 }).catch(() => {});
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(3000);

      this.loggedIn = true;
      console.log('[Scraper] Login done.');
    } catch (err) {
      console.warn('[Scraper] Login skipped:', err.message);
      this.loggedIn = true;
    }
  }

  // ── main scrape ──────────────────────────────────────────────────────────────

  async _scrapeLivePage() {
    try {
      await this.page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await this.page.waitForTimeout(4000);
    } catch (err) {
      console.warn('[Scraper] Navigation error:', err.message);
      return;
    }

    // ── Extract all event cards from the page ──────────────────────────────────
    //
    // We walk every DOM element looking for one whose text is a short league
    // name (like "Akluj Rural Championship").  Once found we climb up to the
    // containing card and pull out every text line + every number.
    //
    const cards = await this.page.evaluate(() => {
      const results = [];
      const seen    = new Set();           // avoid duplicate cards

      // Sports keywords that appear in league headings on this page
      const CRICKET_LEAGUES = [
        ['agra', 'district', 'women'],
        ['agra', 'womens'],
        ['akluj', 'rural'],
        ['chandigarh'],
      ];

      function textOf(el) {
        return (el.innerText || el.textContent || '').trim();
      }

      function lc(el) { return textOf(el).toLowerCase(); }

      // Find the card container from a league-label element by climbing up
      function findCard(labelEl) {
        let el = labelEl;
        for (let i = 0; i < 10; i++) {
          if (!el.parentElement) break;
          el = el.parentElement;
          const t = lc(el);
          // Stop when the block contains at least one number-like token
          if (t.length > 60 && /\d+[.,]\d+/.test(t)) return el;
        }
        return labelEl.parentElement || labelEl;
      }

      document.querySelectorAll('*').forEach((el) => {
        const t = lc(el);
        // Ignore elements that are too long (whole page/section) or too short
        if (t.length < 4 || t.length > 120) return;

        const matched = CRICKET_LEAGUES.find(kws => kws.every(k => t.includes(k)));
        if (!matched) return;

        const card = findCard(el);
        const cardText = lc(card);

        // De-duplicate by card text
        const key = cardText.substring(0, 80);
        if (seen.has(key)) return;
        seen.add(key);

        // ── Split card into lines and numbers ─────────────────────────────────
        const rawLines = textOf(card)
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 0);

        // Every raw number on the card (scores, overs, odds)
        const allNumbers = [];
        rawLines.forEach(line => {
          // Match patterns like: 182  130/4  2.216  14.1  39/0
          const matches = line.matchAll(/\d+(?:[\/,.]\d+)*/g);
          for (const m of matches) {
            allNumbers.push(m[0]);
          }
        });

        results.push({
          leagueName: textOf(el),           // e.g. "Akluj Rural Championship"
          rawText:    cardText,
          lines:      rawLines,
          allNumbers,
        });
      });

      return results;
    });

    console.log(`[Scraper] Found ${cards.length} cricket card(s).`);
    cards.forEach(c => console.log(`  Card: "${c.leagueName}" | lines: ${JSON.stringify(c.lines)}`));

    // ── Match each card to our events and parse data ───────────────────────────

    for (const [eventId, keywords] of Object.entries(EVENT_KEYWORDS)) {
      const card = cards.find(c =>
        keywords.every(kw => c.rawText.includes(kw))
      );

      if (!card) {
        store.updateEvent(eventId, { status: 'upcoming' });
        console.log(`[Scraper] Not found: ${eventId}`);
        continue;
      }

      // ── Parse teams ────────────────────────────────────────────────────────
      // Skip lines that are: pure UI labels, numbers, score strings, or league words
      const UI_LABELS = [
        't20', 't10', 'odi', 'team wins', '1x2', 'live', 'total',
        'event in progress', 'cricket', 'agra', 'akluj', 'chandigarh',
        'league', 'championship', 'district', 'womens', 'women', 'rural',
        'u', '+7', 'w1', 'w2',
      ];

      const teamLines = card.lines.filter(line => {
        const l = line.toLowerCase().trim();
        // Skip pure numbers / score strings like "55/1 (6.4 ov)" / "182"
        if (/^[\d\/\.\s\(\)ovOV]+$/.test(line)) return false;
        // Skip single characters or very short tokens
        if (line.length < 3) return false;
        // Skip "+N" more-markets labels
        if (/^\+\d+$/.test(line)) return false;
        // Skip W1 / W2 / X / 1 / 2 / 0 labels
        if (/^[WwXx]?[12x]?$/.test(line.trim())) return false;
        // Skip known UI words
        if (UI_LABELS.some(w => l === w || l.startsWith(w + ' '))) return false;
        // Must start with a capital letter (team names do)
        if (!/^[A-Z]/.test(line)) return false;
        return true;
      });

      const homeTeam = teamLines[0] || '—';
      const awayTeam = teamLines[1] || '—';

      // ── Parse scores and overs ─────────────────────────────────────────────
      // We look for two patterns in the lines array:
      //   A) "runs/wkts (overs ov)"  → batting team score  e.g. "179/5 (19.5)"
      //   B) bare integer            → completed/target    e.g. "185"
      let homeScore = null, awayScore = null;
      let over = null, periodText = '—';

      for (const line of card.lines) {
        // Pattern A: "55/1 (6.4)" or "179/5 (19.5 ov)"
        const batting = line.match(/^(\d+)\/(\d+)\s*\((\d+\.\d+)(?:\s*ov)?\)/i);
        if (batting) {
          const runs = parseInt(batting[1], 10);
          const ovVal = parseFloat(batting[3]);
          if (homeScore === null) { homeScore = runs; }
          else if (awayScore === null) { awayScore = runs; }
          over = ovVal;
          periodText = `Over ${ovVal}`;
          continue;
        }
        // Pattern B: bare integer score — only if it looks like a cricket score
        // Must be on its own line, between 0 and 500, NOT 1 or 2 digit UI numbers
        const bare = line.match(/^(\d{1,3})$/);
        if (bare) {
          const val = parseInt(bare[1], 10);
          // Skip values that are clearly UI noise (single digits likely W1/W2 labels)
          if (val >= 0 && val <= 500 && val !== 1 && val !== 2) {
            if (homeScore === null) homeScore = val;
            else if (awayScore === null) awayScore = val;
          }
        }
      }

      // ── Parse odds ─────────────────────────────────────────────────────────
      // Real Team Wins odds are ALWAYS decimals between 1.01 and 9.99
      // Scores like 31, 177 are integers — never decimals
      // X (draw) is always > 10 (like 25)
      // So: filter lines that are decimals strictly between 1.01 and 9.99
      // AND the decimal part must be present (e.g. "2.065", "1.69" — not "31")

      // First collect all score numbers to exclude them
      const scoreNumbers = new Set();
      if (homeScore !== null) scoreNumbers.add(homeScore);
      if (awayScore !== null) scoreNumbers.add(awayScore);

      const oddsLines = card.lines.filter(line => {
        const trimmed = line.trim();
        // Must be a decimal number with dot (e.g. "2.065", "1.69")
        if (!/^\d{1,2}\.\d{2,4}$/.test(trimmed)) return false;
        const f = parseFloat(trimmed);
        // Strictly Team Wins range: 1.01 to 9.99
        if (f < 1.01 || f >= 10.0) return false;
        // Exclude if it matches a score number
        if (scoreNumbers.has(Math.round(f))) return false;
        return true;
      }).map(l => parseFloat(l.trim()));

      // Remove duplicates, keep order
      const seenOdds = new Set();
      const uniqueOdds = oddsLines.filter(v => {
        const key = v.toFixed(3);
        if (seenOdds.has(key)) return false;
        seenOdds.add(key);
        return true;
      });

      console.log(`[Scraper] ${eventId} clean odds:`, uniqueOdds);

      // First = W1, Second = W2 (Team Wins market, no draw)
      const homeRatio = uniqueOdds[0] ?? null;
      const awayRatio = uniqueOdds[1] ?? null;
      const drawRatio = null; // Team Wins never has a draw

      store.updateEvent(eventId, {
        status: 'live',
        teams: { home: homeTeam, away: awayTeam },
        score: { home: homeScore, away: awayScore },
        over,
        period: periodText,
        ratios: { home: homeRatio, away: awayRatio, draw: drawRatio },
      });

      console.log(
        `[Scraper] ✓ ${eventId} | ` +
        `${homeTeam} vs ${awayTeam} | ` +
        `score=${homeScore}/${awayScore} over=${over} | ` +
        `odds=[${homeRatio}, ${awayRatio}, ${drawRatio}]`
      );
    }

    this.emit('update', store.getAllEvents());
  }
}

module.exports = new Scraper();
