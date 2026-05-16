// shared/constants.js

module.exports = {
  DEFAULT_DAILY_LIMIT_SECONDS: 7200,  // 2 hours
  ALERT_THRESHOLDS: [0.5, 1.0],       // 50% and 100%
  TABLE_NAMES: {
    USERS:        'fg_users',
    SESSIONS:     'fg_sessions',
    DAILY_TOTALS: 'fg_daily_totals',
    CONNECTIONS:  'fg_connections',
  },
};
