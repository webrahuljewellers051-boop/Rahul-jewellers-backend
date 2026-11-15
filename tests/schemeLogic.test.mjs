
import test from 'node:test';
import assert from 'node:assert/strict';

import * as scheme from '../schemeLogic.js';

function customer(overrides = {}) {
  return {
    customerId: 'RJTEST001',
    schemeJoined: true,
    schemeStatus: 'Active',
    schemeCycle: 1,
    schemeFirstDueMonth: '2026-11',
    startDate: '2026-11-15',
    schemeAnchorDay: 15,
    customInstallment: 5000,
    paidMonths: 0,
    paymentHistory: [],
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

test(
  'Joining on 15th gives 15–19 payment window',
  () => {
    const rows = scheme.installmentRows(
      customer(),
      '2026-11-15'
    );

    assert.equal(
      rows[0].dueDate,
      '2026-11-15'
    );

    assert.equal(
      rows[0].lastDate,
      '2026-11-19'
    );
  }
);

test(
  'The sixth calendar date is overdue',
  () => {
    const rows = scheme.installmentRows(
      customer(),
      '2026-11-20'
    );

    assert.equal(
      rows[0].status,
      'OVERDUE'
    );
  }
);

test(
  'Benefit date is original month 13',
  () => {
    assert.equal(
      scheme.schemeBenefitDate(
        customer()
      ),
      '2027-11-15'
    );
  }
);

test(
  'All 12 early payments do not unlock benefit',
  () => {
    const c = customer();

    c.installmentState.forEach(row => {
      row.paid = true;
    });

    assert.equal(
      scheme.eligible(
        c,
        '2026-12-01'
      ),
      false
    );
  }
);

test(
  'Benefit unlocks on original month 13',
  () => {
    const c = customer();

    c.installmentState.forEach(row => {
      row.paid = true;
    });

    assert.equal(
      scheme.eligible(
        c,
        '2027-11-15'
      ),
      true
    );
  }
);

test(
  'One unpaid installment locks benefit',
  () => {
    const c = customer();

    c.installmentState.forEach(row => {
      row.paid = true;
    });

    c.installmentState[5].paid = false;

    assert.equal(
      scheme.eligible(
        c,
        '2027-11-15'
      ),
      false
    );
  }
);

test(
  'Cancelled scheme cannot unlock benefit',
  () => {
    const c = customer({
      schemeStatus: 'Cancelled'
    });

    c.installmentState.forEach(row => {
      row.paid = true;
    });

    assert.equal(
      scheme.eligible(
        c,
        '2027-11-15'
      ),
      false
    );
  }
);

test(
  'Joining on 31st clamps February without drift',
  () => {
    const c = customer({
      startDate: '2026-01-31',
      schemeFirstDueMonth: '2026-01',
      schemeAnchorDay: 31
    });

    assert.equal(
      scheme.dueDateFor(c, 2),
      '2026-02-28'
    );

    assert.equal(
      scheme.dueDateFor(c, 3),
      '2026-03-31'
    );
  }
);

test(
  'Future prepayment does not erase earlier overdue',
  () => {
    const c = customer();

    c.installmentState[2].paid = true;

    const overdue = scheme.overdueRows(
      c,
      '2026-11-20'
    );

    assert.equal(
      overdue[0].monthNum,
      1
    );
  }
);


test('Option A: join 15 Nov 2026, 12 installments through Oct 2027', () => {
  const c = customer({
    schemeScheduleVersion: 3,
    schemeFirstDueMonth: '2026-11'
  });

  assert.equal(scheme.dueDateFor(c, 1), '2026-11-15');
  assert.equal(scheme.dueDateFor(c, 2), '2026-12-15');
  assert.equal(scheme.dueDateFor(c, 12), '2027-10-15');
  assert.equal(scheme.schemeBenefitDate(c), '2027-11-15');
  assert.equal(scheme.installmentRows(c, '2026-11-19')[0].status, 'PAYMENT_DUE');
  assert.equal(scheme.installmentRows(c, '2026-11-20')[0].status, 'OVERDUE');
});

test('Option A ignores incorrect next-month firstDueMonth on V3', () => {
  const c = customer({
    schemeScheduleVersion: 3,
    schemeFirstDueMonth: '2026-12'
  });

  assert.equal(scheme.dueDateFor(c, 1), '2026-11-15');
  assert.equal(scheme.dueDateFor(c, 12), '2027-10-15');
  assert.equal(scheme.deadline(c, '2026-11-15').firstDueMonth, '2026-11');
});

test('Legacy V1/V2 explicit due-month records remain unchanged', () => {
  const c = customer({
    schemeScheduleVersion: 2,
    schemeFirstDueMonth: '2026-12'
  });

  assert.equal(scheme.dueDateFor(c, 1), '2026-12-15');
  assert.equal(scheme.dueDateFor(c, 12), '2027-11-15');
});

test('Option A: early verified payments do not accelerate month 13', () => {
  const c = customer({ schemeScheduleVersion: 3 });

  c.installmentState.forEach(row => { row.paid = true; });

  assert.equal(scheme.eligible(c, '2027-11-14'), false);
  assert.equal(scheme.eligible(c, '2027-11-15'), true);
});

test('Option A: month-end clamp and restore anchor day', () => {
  const c = customer({
    schemeScheduleVersion: 3,
    startDate: '2027-01-31',
    schemeFirstDueMonth: '2027-01',
    schemeAnchorDay: 31
  });

  assert.equal(scheme.dueDateFor(c, 1), '2027-01-31');
  assert.equal(scheme.dueDateFor(c, 2), '2027-02-28');
  assert.equal(scheme.dueDateFor(c, 3), '2027-03-31');
  assert.equal(scheme.schemeBenefitDate(c), '2028-01-31');
});
