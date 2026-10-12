/**
 * dataStore.js
 * In-memory store for live event data and ratio history time-series.
 * Acts as the single source of truth for the entire backend.
 */

const MAX_HISTORY_POINTS = parseInt(process.env.MAX_HISTORY_POINTS, 10) || 200;

/**
 * Structure of each event entry:
 * {
 *   id: string,               // slug derived from event name
 *   name: string,             // exact event name from spec
 *   status: string,           // 'live' | 'upcoming' | 'finished' | 'unknown'
 *   teams: { home: string, away: string },
 *   score: { home: number|null, away: number|null },
 *   over: number|null,        // current over (cricket-specific)
 *   period: string,           // human-readable period/inning label
 *   ratios: { home: number|null, away: number|null, draw: number|null },
 *   lastUpdated: number,       // unix ms timestamp
 * }
 *
 * ratioHistory[eventId] = Array<{ ts: number, home: number, away: number, draw: number }>
 *
 * firedConditions[eventId] = Set<string>   // tracks already-fired notification keys
 */

const events = new Map();       // eventId -> event object
const ratioHistory = new Map(); // eventId -> [{ ts, home, away, draw }, ...]
const firedConditions = new Map(); // eventId -> Set<conditionKey>

// ----- Seed the three required events so they always exist in the store -----
const REQUIRED_EVENTS = [
  {
    id: 'agra-district-womens-league',
    name: 'Cricket. Agra District Womens League',
    emoji: 'ðŸ',
  },
  {
    id: 'akluj-rural-championship',
    name: 'Cricket. Akluj Rural Championship',
    emoji: 'ðŸŒ¾',
  },
  {
    id: 'chandigarh-league',
    name: 'Cricket. Chandigarh League',
    emoji: 'ðŸ™ï¸',
  },
];

REQUIRED_EVENTS.forEach(({ id, name, emoji }) => {
  events.set(id, {
    id,
    name,
    emoji,
    status: 'unknown',
    teams: { home: 'â€”', away: 'â€”' },
    score: { home: null, away: null },
    over: null,
    period: 'â€”',
    ratios: { home: null, away: null, draw: null },
    lastUpdated: Date.now(),
  });
  ratioHistory.set(id, []);
  firedConditions.set(id, new Set());
});

// ---- Public API ----

/**
 * Update an event's live data. Automatically appends a history point
 * if the ratios have changed since the last snapshot.
 */
function updateEvent(eventId, patch) {
  const existing = events.get(eventId);
  if (!existing) return;

  const updated = { ...existing, ...patch, lastUpdated: Date.now() };
  events.set(eventId, updated);

  // Append ratio history point only when at least one ratio value is present
  const { home, away, draw } = updated.ratios;
  if (home !== null || away !== null) {
    const history = ratioHistory.get(eventId);
    const last = history[history.length - 1];
    // Only append when values actually changed to avoid flat-line noise
    if (!last || last.home !== home || last.away !== away || last.draw !== draw) {
      history.push({ ts: Date.now(), home, away, draw });
      // Trim to rolling window
      if (history.length > MAX_HISTORY_POINTS) {
        history.splice(0, history.length - MAX_HISTORY_POINTS);
      }
    }
  }
}

/** Return a plain array of all events */
function getAllEvents() {
  return Array.from(events.values());
}

/** Return a single event or undefined */
function getEvent(eventId) {
  return events.get(eventId);
}

/** Return ratio history for an event (copy, safe to send over wire) */
function getRatioHistory(eventId) {
  return (ratioHistory.get(eventId) || []).slice();
}

/**
 * Check if a notification condition has already been fired.
 * conditionKey example: 'over_16.5'
 */
function hasConditionFired(eventId, conditionKey) {
  const set = firedConditions.get(eventId);
  return set ? set.has(conditionKey) : false;
}

/** Mark a condition as fired so it won't trigger twice */
function markConditionFired(eventId, conditionKey) {
  const set = firedConditions.get(eventId);
  if (set) set.add(conditionKey);
}

/** Reset fired conditions (e.g. when a new match starts) */
function resetConditions(eventId) {
  firedConditions.set(eventId, new Set());
}

module.exports = {
  REQUIRED_EVENTS,
  updateEvent,
  getAllEvents,
  getEvent,
  getRatioHistory,
  hasConditionFired,
  markConditionFired,
  resetConditions,
};

