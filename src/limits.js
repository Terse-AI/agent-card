'use strict';
/**
 * limits.js — every one of these is a bill or an abuse ceiling, not a style
 * preference. Opening a channel and sending a message are the two actions a
 * stranger can aim at you, so they are the two with hourly caps. Card sizes are
 * capped because images are stored inline and the cap is the whole cost model.
 */
module.exports = {
  MAX_AVATAR_BYTES: 96 * 1024,
  MAX_CARD_BYTES: 1.4 * 1024 * 1024,
  MAX_SKILLS: 12,
  MAX_STACK: 10,
  MAX_LINKS: 6,
  MAX_BIO: 1200,
  MAX_MESSAGE: 4000,
  // Far above any honest use, far below what a scraper walking the code space needs.
  CONNECT_PER_HOUR: 30,
  MESSAGES_PER_HOUR: 120,
};
