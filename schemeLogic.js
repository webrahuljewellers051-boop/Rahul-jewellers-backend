
 // Pure, timezone-stable Gold 12+1 scheme rules. No database or UI dependency.
export const SCHEME_MONTHS = 12;
export const IST_ZONE = 'Asia/Kolkata';
export function istToday(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function shiftMonth(ym, offset) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym))) throw Error('Invalid YYYY-MM');
  const [year, month] = ym.split('-').map(Number);
  const index = year * 12 + month - 1 + offset;
  return `${Math.floor(index / 12)}-${String((index % 12 + 12) % 12 + 1).padStart(2, '0')}`;
}
export function addDays(date, count) {
  const epoch = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) throw Error('Invalid ISO date');
  return new Date(epoch + count * 86400000).toISOString().slice(0, 10);
}
export function dueDateInMonth(ym, anchor) {
  const [year, month] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${ym}-${String(Math.min(Math.max(Number(anchor) || 1, 1), last)).padStart(2, '0')}`;
}
export function anchorDay(c) {
  const stored = Number(c?.schemeAnchorDay || 0);
  if (Number.isInteger(stored) && stored >= 1 && stored <= 31) return stored;
  const parsed = Number(String(c?.startDate || '').slice(8, 10));
  return parsed >= 1 && parsed <= 31 ? parsed : 1;
}
export function cycle(c) { return Number(c?.schemeCycle || 1); }
export function paymentCycle(p) { return Number(p?.schemeCycle || 1); }
export function currentHistory(c) {
  return (c?.paymentHistory || []).filter(p => paymentCycle(p) === cycle(c));
}
export function states(c) {
  if (Array.isArray(c?.installmentState) && c.installmentState.length === SCHEME_MONTHS) {
    const byMonth = new Map(c.installmentState.map(x => [Number(x.monthNum), x]));
    if (byMonth.size === SCHEME_MONTHS) return Array.from({length:SCHEME_MONTHS}, (_, i) => {
      const s = byMonth.get(i + 1) || {};
      return {monthNum:i+1, paid:Boolean(s.paid), transactionId:s.transactionId || '',
        method:s.method || '', paidAt:s.paidAt || null, amount:Number(s.amount || c.customInstallment || 0)};
    });
  }
  // Backwards-compatible, non-destructive migration of legacy contiguous passbooks.
  const history = currentHistory(c);
  const byMonth = new Map(history.map(p => [Number(p.monthNum), p]));
  const legacyCount = Math.min(12, Math.max(0, Number(c?.paidMonths || 0)));
  return Array.from({length:SCHEME_MONTHS}, (_, i) => {
    const monthNum = i+1, p = byMonth.get(monthNum);
    const paid = monthNum <= legacyCount;
    return {monthNum, paid, transactionId:paid ? (p?.transactionId || '') : '',
      method:paid ? (p?.method || 'Legacy') : '', paidAt:p?.verifiedAt || p?.paidAt || null,
      amount:Number(p?.amount || c?.customInstallment || 0)};
  });
}
export function paidCount(c) { return states(c).filter(s => s.paid).length; }
export function schemeBenefitDate(c) {
  const start = String(c?.startDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  return dueDateInMonth(shiftMonth(start.slice(0, 7), 12), anchorDay(c));
}
export function eligible(c, today = istToday()) {
  return Boolean(c?.schemeJoined && (c.schemeStatus || 'Active') === 'Active' &&
    paidCount(c) === 12 && schemeBenefitDate(c) && today >= schemeBenefitDate(c));
}
export function dueDateFor(c, monthNum) {
  if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) throw Error('Invalid installment');
  const base = c?.schemeFirstDueMonth || String(c?.startDate || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(base)) return null;
  return dueDateInMonth(shiftMonth(base, monthNum-1), anchorDay(c));
}
export function inCatchup(c, monthNum, today) {
  return Array.isArray(c?.schemeCatchupMonthNums) && c.schemeCatchupMonthNums.includes(monthNum) &&
    Boolean(c?.schemeCatchupUntil) && today <= c.schemeCatchupUntil;
}
export function installmentRows(c, today = istToday()) {
  return states(c).map(s => {
    const dueDate = dueDateFor(c, s.monthNum);
    const lastDate = dueDate ? addDays(dueDate, 4) : null;
    const catchup = !s.paid && inCatchup(c, s.monthNum, today);
    const manualOverdue=Array.isArray(c?.schemeManualOverdueMonths) && c.schemeManualOverdueMonths.includes(s.monthNum);
    const status = s.paid ? 'PAID' : catchup ? 'PAYMENT_DUE' : manualOverdue ? 'OVERDUE' :
      !dueDate || today < dueDate ? 'UPCOMING' : today <= lastDate ? 'PAYMENT_DUE' : 'OVERDUE';
    return {...s, dueDate, lastDate, status, catchup, payableNow:!s.paid && Boolean(c?.schemeJoined) &&
      (c?.schemeStatus || 'Active') === 'Active' && (status !== 'OVERDUE')};
  });
}
export function deadline(c, today = istToday()) {
  const status = c?.schemeStatus || (c?.schemeJoined ? 'Active' : 'NotJoined');
  const rows = c?.schemeJoined ? installmentRows(c, today) : [];
  const next = rows.find(s => !s.paid);
  const day = next?.dueDate && today >= next.dueDate && today <= next.lastDate ?
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${next.dueDate}T00:00:00Z`))/86400000)+1 : null;
  const stage = status === 'Cancelled' || status === 'Suspended' ? 'CANCELLED' :
    status === 'RefundPending' ? 'REFUND_PENDING' : status === 'Refunded' ? 'REFUNDED' :
    !c?.schemeJoined ? 'NOT_JOINED' : !next ? 'COMPLETED' :
    next.status === 'OVERDUE' ? 'OVERDUE' : next.catchup && today > next.lastDate ? 'CATCHUP' :
    next.status === 'UPCOMING' ? 'UPCOMING' : 'DUE';
  return {status, stage, todayIST:today, schemeStartDate:c?.startDate || null,
    firstDueMonth:c?.schemeFirstDueMonth || null, anchorDay:anchorDay(c),
    monthNum:next?.monthNum || null, dueDate:next?.dueDate || null,
    graceEndDate:next?.lastDate || null, cancellationDate:next?.lastDate ? addDays(next.lastDate,1) : null,
    graceDays:5, dueDay:day, daysRemaining:day === null ? null : 5-day,
    catchupUntil:c?.schemeCatchupUntil || null, catchupMonthNums:c?.schemeCatchupMonthNums || []};
}
export function overdueRows(c, today = istToday()) {
  return installmentRows(c, today).filter(s => !s.paid && s.status === 'OVERDUE');
}
