
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as scheme from '../schemeLogic.js';

const here = path.dirname(
  fileURLToPath(import.meta.url)
);

const source = readFileSync(
  path.join(here, '..', 'server.js'),
  'utf8'
);

function example(overrides = {}) {
  return {
    schemeJoined: true,
    schemeStatus: 'Active',
    isActive: true,
    schemeScheduleVersion: 3,
    startDate: '2026-11-15',
    schemeAnchorDay: 15,

    // Deliberately wrong:
    // Option A must ignore this for V3.
    schemeFirstDueMonth: '2026-12',

    customInstallment: 5000,

    installmentState: Array.from(
      { length: 12 },
      (_, index) => ({
        monthNum: index + 1,
        paid: false,
        amount: 5000
      })
    ),

    ...overrides
  };
}

function allPaid() {
  const customer = example();

  customer.installmentState.forEach(
    item => {
      item.paid = true;
    }
  );

  return customer;
}

test('Option A starts on joining date', () => {
  const c = example();

  assert.equal(
    scheme.dueDateFor(c, 1),
    '2026-11-15'
  );

  assert.equal(
    scheme.dueDateFor(c, 12),
    '2027-10-15'
  );

  assert.equal(
    scheme.schemeBenefitDate(c),
    '2027-11-15'
  );

  assert.equal(
    scheme.deadline(
      c,
      '2026-11-15'
    ).firstDueMonth,
    '2026-11'
  );
});

test('All 12 monthly dates are correct', () => {
  const c = example();

  const dates = Array.from(
    { length: 12 },
    (_, index) =>
      scheme.dueDateFor(c, index + 1)
  );

  assert.deepEqual(dates, [
    '2026-11-15',
    '2026-12-15',
    '2027-01-15',
    '2027-02-15',
    '2027-03-15',
    '2027-04-15',
    '2027-05-15',
    '2027-06-15',
    '2027-07-15',
    '2027-08-15',
    '2027-09-15',
    '2027-10-15'
  ]);
});

test('Payment window is 5 dates inclusive', () => {
  const c = example();

  for (
    const day of [
      '15', '16', '17', '18', '19'
    ]
  ) {
    const row = scheme.installmentRows(
      c,
      `2026-11-${day}`
    )[0];

    assert.equal(
      row.status,
      'PAYMENT_DUE'
    );

    assert.equal(
      row.payableNow,
      true
    );

    assert.equal(
      row.lastDate,
      '2026-11-19'
    );
  }

  const overdue = scheme.installmentRows(
    c,
    '2026-11-20'
  )[0];

  assert.equal(
    overdue.status,
    'OVERDUE'
  );

  assert.equal(
    overdue.payableNow,
    false
  );
});

test('Future installments can be prepaid', () => {
  const c = example();

  assert.equal(
    scheme.installmentRows(
      c,
      '2026-11-15'
    )[5].payableNow,
    true
  );
});

test('Overdue installment blocks further payment', () => {
  const c = example();

  assert.equal(
    scheme.installmentRows(
      c,
      '2026-11-20'
    )[5].payableNow,
    false
  );
});

test('Early payment cannot unlock benefit', () => {
  const c = allPaid();

  assert.equal(
    scheme.eligible(
      c,
      '2027-11-14'
    ),
    false
  );

  assert.equal(
    scheme.eligible(
      c,
      '2027-11-15'
    ),
    true
  );
});

test('One unpaid installment blocks claim', () => {
  const c = allPaid();

  c.installmentState[6].paid = false;

  assert.equal(
    scheme.eligible(
      c,
      '2027-11-15'
    ),
    false
  );
});

test('Inactive schemes cannot claim', () => {
  const c = allPaid();

  for (
    const status of [
      'Cancelled',
      'Suspended',
      'RefundPending'
    ]
  ) {
    assert.equal(
      scheme.eligible(
        {
          ...c,
          schemeStatus: status
        },
        '2027-11-15'
      ),
      false
    );
  }

  assert.equal(
    scheme.eligible(
      {
        ...c,
        isActive: false
      },
      '2027-11-15'
    ),
    false
  );
});

test('31st joining date handles February', () => {
  const c = example({
    startDate: '2027-01-31',
    schemeAnchorDay: 31
  });

  assert.equal(
    scheme.dueDateFor(c, 2),
    '2027-02-28'
  );

  assert.equal(
    scheme.dueDateFor(c, 3),
    '2027-03-31'
  );

  assert.equal(
    scheme.schemeBenefitDate(c),
    '2028-01-31'
  );
});

test('Leap-year joining date is handled', () => {
  const c = example({
    startDate: '2028-02-29',
    schemeAnchorDay: 29
  });

  assert.equal(
    scheme.dueDateFor(c, 1),
    '2028-02-29'
  );

  assert.equal(
    scheme.schemeBenefitDate(c),
    '2029-02-28'
  );
});

test('Approved catch-up window expires', () => {
  const c = example({
    schemeCatchupMonthNums: [1],
    schemeCatchupUntil: '2026-11-24'
  });

  assert.equal(
    scheme.installmentRows(
      c,
      '2026-11-23'
    )[0].payableNow,
    true
  );

  assert.equal(
    scheme.installmentRows(
      c,
      '2026-11-25'
    )[0].payableNow,
    false
  );
});

test('Claim endpoints require authentication', () => {
  assert.match(
    source,
    /app\.get\(\s*['"]\/api\/customer\/benefit-claim['"]\s*,\s*customerAuth\b/
  );

  assert.match(
    source,
    /app\.post\(\s*['"]\/api\/customer\/benefit-claim['"]\s*,\s*customerAuth\b/
  );

  for (
    const action of [
      'verify',
      'redeem'
    ]
  ) {
    const pattern = new RegExp(
      `app\\.post\\(\\s*['"]\\/api\\/admin\\/benefit-claims\\/:id\\/${action}['"]\\s*,\\s*adminAuth\\b`
    );

    assert.match(
      source,
      pattern
    );
  }

  assert.match(
    source,
    /if\s*\(!isGold\)/
  );
});

test('Deleted customer and reset token checks exist', () => {
  assert.match(
    source,
    /User\.findById\(p\.sub\)/
  );

  assert.match(
    source,
    /if\s*\(!customer\)\s*bad\(401/
  );

  assert.match(
    source,
    /Number\(p\.v\s*\|\|\s*0\)\s*!==\s*Number\(customer\.tokenVersion\s*\|\|\s*0\)/
  );

  assert.match(
    source,
    /\$inc:\s*\{\s*tokenVersion:\s*1\s*\}/
  );
});
