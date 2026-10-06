/**
 * index.js
 * Entry point for the LiveTracker backend.
 * Starts Express HTTP server + WebSocket server + Puppeteer scraper.
 */

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const apiRoutes = require('./api/routes');
const { initWebSocketServer } = require('./websocket/wsServer');
const scraper = require('./scraper/scraper');

const PORT = parseInt(process.env.PORT, 10) || 3001;

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// REST API
app.use('/api', apiRoutes);

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    service: 'LiveTracker Backend',
    version: '1.0.0',
    endpoints: [
      'GET  /api/health',
      'GET  /api/events',
      'GET  /api/events/:id',
      'GET  /api/events/:id/history',
      'POST /api/refresh',
    ],
    websocket: `ws://localhost:${PORT}`,
  });
});

// Create a single HTTP server shared by Express and WebSocket
const server = http.createServer(app);
initWebSocketServer(server);

server.listen(PORT, () => {
  console.log(`[Server] HTTP + WebSocket listening on port ${PORT}`);
  // Start the scraper
  scraper.start().catch((err) => {
    console.error('[Server] Scraper failed to start:', err.message);
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down…');
  await scraper.stop();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', async () => {
  await scraper.stop();
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
});
