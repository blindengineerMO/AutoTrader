const { generateWalkForwardSplits } = require('../src/services/spec/walkForwardService');

function buildDates(count) {
  const dates = [];
  const start = new Date('2024-01-01T00:00:00Z');
  for (let i = 0; i < count; i += 1) {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

describe('walkForwardService.generateWalkForwardSplits', () => {
  it('produces splits with no date shared between any train window and any test window', () => {
    const dates = buildDates(60);
    const splits = generateWalkForwardSplits(dates, { trainWindowDays: 10, testWindowDays: 5, purgeDays: 2, embargoDays: 2 });

    expect(splits.length).toBeGreaterThan(1);

    const dateInRange = (date, range) => date >= range.start && date <= range.end;
    const allTestDates = new Set();
    for (const split of splits) {
      for (const date of dates) {
        if (dateInRange(date, split.test)) allTestDates.add(date);
      }
    }

    for (const split of splits) {
      for (const date of dates) {
        if (dateInRange(date, split.train)) {
          expect(allTestDates.has(date)).toBe(false);
        }
      }
    }
  });

  it('leaves a purge gap between train end and test start, and an embargo gap after test end', () => {
    const dates = buildDates(30);
    const [split] = generateWalkForwardSplits(dates, { trainWindowDays: 10, testWindowDays: 5, purgeDays: 3, embargoDays: 2 });

    const trainEndIdx = dates.indexOf(split.train.end);
    const testStartIdx = dates.indexOf(split.test.start);
    const testEndIdx = dates.indexOf(split.test.end);

    expect(testStartIdx - trainEndIdx - 1).toBe(3);
    expect(split.purge.start).toBe(dates[trainEndIdx + 1]);
    expect(split.purge.end).toBe(dates[testStartIdx - 1]);
    expect(split.embargo.start).toBe(dates[testEndIdx + 1]);
    expect(dates.indexOf(split.embargo.end) - testEndIdx).toBe(2);
  });

  it('returns no splits when there is not enough history for even one train+test window', () => {
    const dates = buildDates(5);
    const splits = generateWalkForwardSplits(dates, { trainWindowDays: 10, testWindowDays: 5, purgeDays: 1, embargoDays: 1 });
    expect(splits).toEqual([]);
  });

  it('omits purge/embargo objects when their day counts are zero', () => {
    const dates = buildDates(20);
    const [split] = generateWalkForwardSplits(dates, { trainWindowDays: 10, testWindowDays: 5, purgeDays: 0, embargoDays: 0 });
    expect(split.purge).toBeNull();
    expect(split.embargo).toBeNull();
  });
});
