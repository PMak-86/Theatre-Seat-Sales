const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function reportContext() {
  const element = { textContent: '', innerHTML: '', addEventListener() {} };
  const context = vm.createContext({
    document: { querySelector: () => element },
    window: { print() {} }, location: { search: '' }, URLSearchParams,
    Intl, Date, console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'report.js'), 'utf8'), context);
  return { context, element };
}

test('report date labels are evenly spaced despite clustered snapshots', () => {
  const { context } = reportContext();
  const dates = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-11-01'];
  const svg = context.chart(dates.map((date, index) => ({ captured_at: date + 'T00:00:00Z', actual_sold: index * 10 })));
  const labels = [...svg.matchAll(/class="x-label[^"]*" x="([^"]+)"/g)].map(match => Number(match[1]));
  assert.equal(labels.length, 5);
  assert.ok(labels.every((x, i) => !i || x - labels[i - 1] > 100));
});

test('a single snapshot has one valid date label', () => {
  const { context } = reportContext();
  const svg = context.chart([{ captured_at: '2026-07-01T00:00:00Z', actual_sold: 20 }]);
  assert.equal((svg.match(/class="x-label/g) || []).length, 1);
  assert.ok(!svg.includes('NaN'));
});

test('report ring follows the actual percentage and unknown revenue stays unknown', () => {
  const { context, element } = reportContext();
  context.render({ event: { event_name: 'Test event' }, summary: { effectiveSoldPercent: 42.7, ticketsSold: 40, performances: 1, totalSeats: 100 } });
  assert.ok(element.innerHTML.includes('--sell-through:42.7%'));
  assert.ok(element.innerHTML.includes('<b>—</b> Est. revenue'));
  assert.ok(element.innerHTML.includes('<span>sell-through</span>'));
});
