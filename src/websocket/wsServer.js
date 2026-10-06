/**
 * wsServer.js
 * WebSocket server that pushes live data updates to all connected mobile clients.
 *
 * Message types sent to clients:
 *   { type: 'snapshot',      data: Event[] }          – full state on connect
 *   { type: 'events_update', data: Event[] }          – after each scrape cycle
 *   { type: 'notification',  data: NotificationPayload } – condition triggered
 *
 * Message types received from clients:
 *   { type: 'ping' }                                   – keepalive
 *   { type: 'refresh' }                                – trigger a scrape cycle
 */

const { WebSocketServer, WebSocket } = require('ws');
const store = require('../store/dataStore');
const scraper = require('../scraper/scraper');
const conditionChecker = require('../notifications/conditionChecker');

let wss = null;

function broadcast(payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function initWebSocketServer(server) {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('[WS] Client connected. Total:', wss.clients.size);

    // Send full snapshot immediately on connect
    ws.send(
      JSON.stringify({ type: 'snapshot', data: store.getAllEvents() })
    );

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
        if (msg.type === 'refresh') {
          scraper.forceRefresh().catch((err) =>
            console.error('[WS] forceRefresh error:', err.message)
          );
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected. Total:', wss.clients.size);
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
    });
  });

  // When scraper emits new data, broadcast to all clients
  scraper.on('update', (events) => {
    broadcast({ type: 'events_update', data: events });
    // Check conditions after every update
    conditionChecker.check();
  });

  // When a condition is met, broadcast a notification message
  conditionChecker.on('notification', (payload) => {
    broadcast({ type: 'notification', data: payload });
  });

  console.log('[WS] WebSocket server ready.');
  return wss;
}

module.exports = { initWebSocketServer, broadcast };
