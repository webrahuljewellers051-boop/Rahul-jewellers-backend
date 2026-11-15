
/**
 * Rahul Jewellers Shivganj
 * Gold Scheme — 12 monthly installments + making-charge benefit
 *
 * Complete replacement: jewel-backend/schemeLogic.js
 *
 * Rules:
 * - 12 monthly installments.
 * - The joining date anchors every monthly due date.
 * - Each installment has five calendar dates, inclusive.
 * - Future unpaid installments may be prepaid.
 * - An overdue installment requires admin intervention.
 * - Early payment of all 12 installments does NOT
 *   unlock the benefit before the original month 13.
 * - Eligible benefit: 100% discount on making/labour
 *   charges for eligible Gold Jewellery.
 * - No free gold or free 13th installment.
 *
 * All date calculations use calendar dates in IST.
 */

export const SCHEME_MONTHS = 12;
export const IST_ZONE = 'Asia/Kolkata';
export const PAYMENT_WINDOW_DAYS = 5;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function validIsoDate(value) {
  if (!ISO_DATE.test(String(value || ''))) {
    return false;
  }

  const parsed = new Date(
    `${value}T00:00:00.000Z`
  );

  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function normalizedMonth(value) {
  const month = String(value || '');

  return YEAR_MONTH.test(month)
    ? month
    : null;
}

function clampMonthNumber(value) {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    return 0;
  }

  return Math.min(
    SCHEME_MONTHS,
    Math.max(0, number)
  );
}

function dateNumber(value) {
  if (!validIsoDate(value)) {
    return null;
  }

  return Date.parse(
    `${value}T00:00:00.000Z`
  );
}

export function istToday(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: IST_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
      .formatToParts(now)
      .filter(part => part.type !== 'literal')
      .map(part => [
        part.type,
        part.value
      ])
  );

  return (
    `${parts.year}-${parts.month}-${parts.day}`
  );
}

export function shiftMonth(yearMonth, offset) {
  const ym = normalizedMonth(yearMonth);

  if (!ym) {
    throw new Error(
      'Invalid YYYY-MM month.'
    );
  }

  if (!Number.isInteger(offset)) {
    throw new Error(
      'Month offset must be an integer.'
    );
  }

  const [year, month] = ym
    .split('-')
    .map(Number);

  const index =
    year * 12 + month - 1 + offset;

  const resultYear = Math.floor(index / 12);

  const resultMonth =
    ((index % 12) + 12) % 12 + 1;

  return (
    `${resultYear}-` +
    String(resultMonth).padStart(2, '0')
  );
}

export function addDays(isoDate, count) {
  const epoch = dateNumber(isoDate);

  if (epoch === null) {
    throw new Error(
      'Invalid ISO calendar date.'
    );
  }

  if (!Number.isInteger(count)) {
    throw new Error(
      'Day offset must be an integer.'
    );
  }

  return new Date(
    epoch + count * 86400000
  ).toISOString().slice(0, 10);
}

export function dueDateInMonth(
  yearMonth,
  anchor
) {
  const ym = normalizedMonth(yearMonth);

  if (!ym) {
    throw new Error(
      'Invalid YYYY-MM month.'
    );
  }

  const [year, month] = ym
    .split('-')
    .map(Number);

  const lastDay = new Date(
    Date.UTC(year, month, 0)
  ).getUTCDate();

  const requestedDay = Number(anchor);

  const day = Number.isInteger(requestedDay)
    ? Math.min(
        lastDay,
        Math.max(1, requestedDay)
      )
    : 1;

  return (
    `${ym}-` +
    String(day).padStart(2, '0')
  );
}

export function anchorDay(customer) {
  const stored = Number(
    customer?.schemeAnchorDay || 0
  );

  if (
    Number.isInteger(stored) &&
    stored >= 1 &&
    stored <= 31
  ) {
    return stored;
  }

  const startDate = String(
    customer?.startDate || ''
  );

  if (validIsoDate(startDate)) {
    return Number(startDate.slice(8, 10));
  }

  return 1;
}

export function cycle(customer) {
  const value = Number(
    customer?.schemeCycle || 1
  );

  return (
    Number.isInteger(value) &&
    value >= 1
  )
    ? value
    : 1;
}

export function paymentCycle(payment) {
  const value = Number(
    payment?.schemeCycle || 1
  );

  return (
    Number.isInteger(value) &&
    value >= 1
  )
    ? value
    : 1;
}

export function currentHistory(customer) {
  const history = Array.isArray(
    customer?.paymentHistory
  )
    ? customer.paymentHistory
    : [];

  const currentCycle = cycle(customer);

  return history.filter(
    payment =>
      paymentCycle(payment) === currentCycle
  );
}

function normalizeState(
  state,
  monthNum,
  monthlyAmount
) {
  const paid = Boolean(state?.paid);

  return {
    monthNum,
    paid,
    transactionId: paid
      ? String(state?.transactionId || '')
      : '',
    method: paid
      ? String(state?.method || '')
      : '',
    paidAt: paid
      ? state?.paidAt || null
      : null,
    amount: Number(
      state?.amount ||
      monthlyAmount ||
      0
    )
  };
}

export function states(customer) {
  const monthlyAmount = Number(
    customer?.customInstallment || 0
  );

  const explicit = customer?.installmentState;

  if (
    Array.isArray(explicit) &&
    explicit.length === SCHEME_MONTHS
  ) {
    const byMonth = new Map();

    for (const item of explicit) {
      const monthNum = Number(
        item?.monthNum
      );

      if (
        Number.isInteger(monthNum) &&
        monthNum >= 1 &&
        monthNum <= SCHEME_MONTHS
      ) {
        byMonth.set(monthNum, item);
      }
    }

    if (byMonth.size === SCHEME_MONTHS) {
      return Array.from(
        { length: SCHEME_MONTHS },
        (_, index) => {
          const monthNum = index + 1;

          return normalizeState(
            byMonth.get(monthNum),
            monthNum,
            monthlyAmount
          );
        }
      );
    }
  }

  /*
   * Legacy compatibility:
   * Older passbooks used a contiguous paidMonths count.
   * Do not silently change their verified-payment count.
   */

  const history = currentHistory(customer);

  const byMonth = new Map(
    history.map(payment => [
      Number(payment.monthNum),
      payment
    ])
  );

  const legacyPaidCount = clampMonthNumber(
    customer?.paidMonths || 0
  );

  return Array.from(
    { length: SCHEME_MONTHS },
    (_, index) => {
      const monthNum = index + 1;
      const payment = byMonth.get(monthNum);
      const paid = monthNum <= legacyPaidCount;

      return {
        monthNum,
        paid,
        transactionId: paid
          ? String(
              payment?.transactionId || ''
            )
          : '',
        method: paid
          ? String(
              payment?.method || 'Legacy'
            )
          : '',
        paidAt: paid
          ? (
              payment?.verifiedAt ||
              payment?.paidAt ||
              null
            )
          : null,
        amount: Number(
          payment?.amount ||
          monthlyAmount ||
          0
        )
      };
    }
  );
}

export function paidCount(customer) {
  return states(customer).filter(
    installment => installment.paid
  ).length;
}

export function schemeBenefitDate(customer) {
  const startDate = String(
    customer?.startDate || ''
  );

  if (!validIsoDate(startDate)) {
    return null;
  }

  /*
   * Original enrollment month + 12 months.
   *
   * Example:
   * Joining: 2026-11-15
   * Benefit: 2027-11-15
   *
   * Prepayment does not change this date.
   */

  const firstMonth = startDate.slice(0, 7);

  const benefitMonth = shiftMonth(
    firstMonth,
    SCHEME_MONTHS
  );

  return dueDateInMonth(
    benefitMonth,
    anchorDay(customer)
  );
}

export function eligible(
  customer,
  today = istToday()
) {
  if (!customer?.schemeJoined) {
    return false;
  }

  if (
    (customer.schemeStatus || 'Active') !==
    'Active'
  ) {
    return false;
  }

  if (customer.isActive === false) {
    return false;
  }

  if (paidCount(customer) !== SCHEME_MONTHS) {
    return false;
  }

  const benefitDate =
    schemeBenefitDate(customer);

  if (!benefitDate || !validIsoDate(today)) {
    return false;
  }

  return today >= benefitDate;
}

export function dueDateFor(
  customer,
  monthNum
) {
  if (
    !Number.isInteger(monthNum) ||
    monthNum < 1 ||
    monthNum > SCHEME_MONTHS
  ) {
    throw new Error(
      'Installment number must be 1–12.'
    );
  }

  const firstDueMonth =
    normalizedMonth(
      customer?.schemeFirstDueMonth
    ) ||
    normalizedMonth(
      String(customer?.startDate || '')
        .slice(0, 7)
    );

  if (!firstDueMonth) {
    return null;
  }

  const dueMonth = shiftMonth(
    firstDueMonth,
    monthNum - 1
  );

  return dueDateInMonth(
    dueMonth,
    anchorDay(customer)
  );
}

export function inCatchup(
  customer,
  monthNum,
  today = istToday()
) {
  const catchupMonths = Array.isArray(
    customer?.schemeCatchupMonthNums
  )
    ? customer.schemeCatchupMonthNums
        .map(Number)
    : [];

  const catchupUntil = String(
    customer?.schemeCatchupUntil || ''
  );

  if (
    !catchupMonths.includes(monthNum) ||
    !validIsoDate(catchupUntil) ||
    !validIsoDate(today)
  ) {
    return false;
  }

  return today <= catchupUntil;
}

export function installmentRows(
  customer,
  today = istToday()
) {
  const schemeStatus =
    customer?.schemeStatus ||
    (customer?.schemeJoined
      ? 'Active'
      : 'NotJoined');

  const active =
    Boolean(customer?.schemeJoined) &&
    schemeStatus === 'Active' &&
    customer?.isActive !== false;

  const manualOverdue = new Set(
    Array.isArray(
      customer?.schemeManualOverdueMonths
    )
      ? customer.schemeManualOverdueMonths
          .map(Number)
      : []
  );

  const rows = states(customer).map(
    installment => {
      const monthNum = installment.monthNum;

      const dueDate = dueDateFor(
        customer,
        monthNum
      );

      const lastDate = dueDate
        ? addDays(
            dueDate,
            PAYMENT_WINDOW_DAYS - 1
          )
        : null;

      const catchup =
        !installment.paid &&
        inCatchup(
          customer,
          monthNum,
          today
        );

      let status = 'UPCOMING';

      if (installment.paid) {
        status = 'PAID';
      } else if (catchup) {
        status = 'PAYMENT_DUE';
      } else if (manualOverdue.has(monthNum)) {
        status = 'OVERDUE';
      } else if (!dueDate || today < dueDate) {
        status = 'UPCOMING';
      } else if (today <= lastDate) {
        status = 'PAYMENT_DUE';
      } else {
        status = 'OVERDUE';
      }

      return {
        ...installment,
        dueDate,
        lastDate,
        status,
        catchup,
        payableNow: false
      };
    }
  );

  /*
   * If an installment has already passed its
   * deadline, do not allow a different future
   * installment to bypass the missed payment.
   *
   * Admin reactivation places approved missed
   * installments into the catch-up window.
   */

  const hasOverdue = rows.some(
    row =>
      !row.paid &&
      row.status === 'OVERDUE'
  );

  return rows.map(row => ({
    ...row,
    payableNow:
      active &&
      !row.paid &&
      Boolean(row.dueDate) &&
      !hasOverdue &&
      row.status !== 'OVERDUE'
  }));
}

export function overdueRows(
  customer,
  today = istToday()
) {
  return installmentRows(
    customer,
    today
  ).filter(
    row =>
      !row.paid &&
      row.status === 'OVERDUE'
  );
}

export function deadline(
  customer,
  today = istToday()
) {
  const status =
    customer?.schemeStatus ||
    (customer?.schemeJoined
      ? 'Active'
      : 'NotJoined');

  const rows = customer?.schemeJoined
    ? installmentRows(customer, today)
    : [];

  const next = rows.find(
    row => !row.paid
  );

  let dueDay = null;

  if (
    next?.dueDate &&
    next?.lastDate &&
    today >= next.dueDate &&
    today <= next.lastDate
  ) {
    dueDay =
      Math.round(
        (
          dateNumber(today) -
          dateNumber(next.dueDate)
        ) / 86400000
      ) + 1;
  }

  let stage;

  if (
    status === 'Cancelled' ||
    status === 'Suspended'
  ) {
    stage = 'CANCELLED';
  } else if (status === 'RefundPending') {
    stage = 'REFUND_PENDING';
  } else if (status === 'Refunded') {
    stage = 'REFUNDED';
  } else if (!customer?.schemeJoined) {
    stage = 'NOT_JOINED';
  } else if (!next) {
    stage = 'COMPLETED';
  } else if (next.status === 'OVERDUE') {
    stage = 'OVERDUE';
  } else if (
    next.catchup &&
    next.lastDate &&
    today > next.lastDate
  ) {
    stage = 'CATCHUP';
  } else if (next.status === 'UPCOMING') {
    stage = 'UPCOMING';
  } else {
    stage = 'DUE';
  }

  return {
    status,
    stage,
    todayIST: today,

    schemeStartDate:
      customer?.startDate || null,

    firstDueMonth:
      customer?.schemeFirstDueMonth || null,

    anchorDay: anchorDay(customer),

    monthNum:
      next?.monthNum || null,

    dueDate:
      next?.dueDate || null,

    graceEndDate:
      next?.lastDate || null,

    cancellationDate:
      next?.lastDate
        ? addDays(next.lastDate, 1)
        : null,

    graceDays: PAYMENT_WINDOW_DAYS,

    dueDay,

    daysRemaining:
      dueDay === null
        ? null
        : PAYMENT_WINDOW_DAYS - dueDay,

    catchupUntil:
      customer?.schemeCatchupUntil || null,

    catchupMonthNums:
      customer?.schemeCatchupMonthNums || [],

    benefitDate:
      schemeBenefitDate(customer),

    benefitEligible:
      eligible(customer, today),

    paidMonths:
      paidCount(customer),

    totalInstallments:
      SCHEME_MONTHS
  };
}
