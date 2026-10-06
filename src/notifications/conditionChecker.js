/**
 * conditionChecker.js
 * Evaluates predefined conditions against live event data and emits
 * notification payloads when conditions are first met.
 *
 * Conditions are pure data checks — this module does NOT send push
 * notifications directly; it emits events consumed by the WebSocket layer
 * which forwards them to connected mobile clients.
 */

const { EventEmitter } = require('events');
const store = require('../store/dataStore');

// ---- Condition definitions ----
// Each condition: { id, eventId, label, check(event) -> bool, message }
const CONDITIONS = [
  // Over 16.5 reached for each event
  {
    id: 'agra-over-16.5',
    eventId: 'agra-district-womens-league',
    label: 'Over 16.5 reached',
    check: (ev) => ev.over !== null && ev.over >= 16.5,
    title: '🏏 Perfect Time!',
    body: "It's that 16.5 magic moment! Things are heating up 🔥",
  },
  {
    id: 'akluj-over-16.5',
    eventId: 'akluj-rural-championship',
    label: 'Over 16.5 reached',
    check: (ev) => ev.over !== null && ev.over >= 16.5,
    title: '🌾 The Sweet Spot!',
    body: "Overs crossing 16.5 — this is where legends are made! 🌟",
  },
  {
    id: 'chandigarh-over-16.5',
    eventId: 'chandigarh-league',
    label: 'Over 16.5 reached',
    check: (ev) => ev.over !== null && ev.over >= 16.5,
    title: '🏙️ Now We\'re Cooking!',
    body: "16.5 overs in Chandigarh — grab your popcorn 🍿",
  },

  // Ratio drop alert: home ratio drops below 1.5 (sharp movement)
  {
    id: 'agra-ratio-drop',
    eventId: 'agra-district-womens-league',
    label: 'Odds shift detected',
    check: (ev) => ev.ratios.home !== null && ev.ratios.home < 1.5,
    title: '📉 Odds Going Wild!',
    body: "The numbers are moving fast in Agra. Brace yourself! 😲",
  },
  {
    id: 'akluj-ratio-drop',
    eventId: 'akluj-rural-championship',
    label: 'Odds shift detected',
    check: (ev) => ev.ratios.home !== null && ev.ratios.home < 1.5,
    title: '📉 Tight Margins!',
    body: "Akluj Rural is a nail-biter right now 💅",
  },
  {
    id: 'chandigarh-ratio-drop',
    eventId: 'chandigarh-league',
    label: 'Odds shift detected',
    check: (ev) => ev.ratios.home !== null && ev.ratios.home < 1.5,
    title: '📉 One Team Dominates!',
    body: "Chandigarh is looking one-sided. Drama incoming? 🎭",
  },

  // Match just went live
  {
    id: 'agra-went-live',
    eventId: 'agra-district-womens-league',
    label: 'Match started',
    check: (ev) => ev.status === 'live',
    title: '🚀 Game On — Agra!',
    body: "Agra District Womens League is LIVE! Don't miss it 👀",
  },
  {
    id: 'akluj-went-live',
    eventId: 'akluj-rural-championship',
    label: 'Match started',
    check: (ev) => ev.status === 'live',
    title: '🚀 They\'re Off — Akluj!',
    body: "Akluj Rural Championship kicked off! Get in! ⚡",
  },
  {
    id: 'chandigarh-went-live',
    eventId: 'chandigarh-league',
    label: 'Match started',
    check: (ev) => ev.status === 'live',
    title: '🚀 Chandigarh is Live!',
    body: "The Chandigarh League is underway! Your move 🎯",
  },
];

class ConditionChecker extends EventEmitter {
  /**
   * Evaluate all conditions against current store data.
   * Emits 'notification' for each newly-triggered condition.
   * Called after every successful scrape cycle.
   */
  check() {
    for (const condition of CONDITIONS) {
      const event = store.getEvent(condition.eventId);
      if (!event) continue;

      const alreadyFired = store.hasConditionFired(condition.eventId, condition.id);
      if (alreadyFired) continue;

      if (condition.check(event)) {
        store.markConditionFired(condition.eventId, condition.id);
        const payload = {
          conditionId: condition.id,
          eventId: condition.eventId,
          eventName: event.name,
          title: condition.title,
          body: condition.body,
          ts: Date.now(),
        };
        console.log(`[ConditionChecker] Condition met: ${condition.id}`);
        this.emit('notification', payload);
      }
    }
  }

  /**
   * Reset all conditions for a specific event (call when a new match begins).
   */
  resetEvent(eventId) {
    store.resetConditions(eventId);
  }
}

module.exports = new ConditionChecker();
