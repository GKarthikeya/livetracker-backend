/**
 * routes.js
 * Express REST API routes.
 *
 * GET  /api/events              – all tracked events (current state)
 * GET  /api/events/:id          – single event
 * GET  /api/events/:id/history  – ratio history time-series
 * POST /api/refresh             – force an immediate scrape cycle
 * GET  /api/health              – health check
 */

const express = require('express');
const store = require('../store/dataStore');
const scraper = require('../scraper/scraper');

const router = express.Router();

// Health check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// All events
router.get('/events', (_req, res) => {
  res.json(store.getAllEvents());
});

// Single event
router.get('/events/:id', (req, res) => {
  const event = store.getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

// Ratio history for an event
router.get('/events/:id/history', (req, res) => {
  const event = store.getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(store.getRatioHistory(req.params.id));
});

// Force refresh
router.post('/refresh', async (_req, res) => {
  try {
    // Don't await the full cycle — fire and return immediately
    scraper.forceRefresh().catch((err) =>
      console.error('[API] forceRefresh error:', err.message)
    );
    res.json({ status: 'refresh_triggered', ts: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
