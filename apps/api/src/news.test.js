const test = require('node:test');
const assert = require('node:assert/strict');
const { providerDate, activeNewsWindow } = require('./news');

test('provider timestamps without an offset are interpreted as UTC', () => {
  assert.equal(providerDate('2026-10-24T12:30:00').toISOString(), '2026-10-24T12:30:00.000Z');
  assert.equal(providerDate('2026-10-24T14:30:00+02:00').toISOString(), '2026-10-24T12:30:00.000Z');
  assert.equal(providerDate('not-a-date'), null);
});

test('news filter activates only for precise high-impact USD events inside the configured window', () => {
  const event = { impact: 'high', currency: 'USD', dateSpan: 0, scheduledAt: '2026-10-24T12:00:00.000Z' };
  const settings = { newsFilterEnabled: true, newsMinutesBefore: 30, newsMinutesAfter: 15 };
  assert.equal(activeNewsWindow([event], settings, new Date('2026-10-24T11:30:00Z')), event);
  assert.equal(activeNewsWindow([event], settings, new Date('2026-10-24T12:15:00Z')), event);
  assert.equal(activeNewsWindow([event], settings, new Date('2026-10-24T11:29:59Z')), null);
  assert.equal(activeNewsWindow([{ ...event, dateSpan: null }], settings, new Date('2026-10-24T12:00:00Z')), null);
  assert.equal(activeNewsWindow([{ ...event, currency: 'EUR' }], settings, new Date('2026-10-24T12:00:00Z')), null);
  assert.equal(activeNewsWindow([event], { ...settings, newsFilterEnabled: false }, new Date('2026-10-24T12:00:00Z')), null);
});
