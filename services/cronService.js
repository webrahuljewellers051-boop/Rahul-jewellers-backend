
import cron from 'node-cron';
import Scheme from '../models/Scheme.js';

// ==========================================
// RAHUL JEWELLERS — SCHEME CRON SERVICE
// ==========================================

const TIMEZONE = 'Asia/Kolkata';
const GRACE_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const istDateFormatter = new Intl.DateTimeFormat(
  'en-GB',
  {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }
);

// Convert date to a calendar-day number in IST.
function getISTDayNumber(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date.');
  }

  const parts = istDateFormatter.formatToParts(date);

  const values = {};

  for (const part of parts) {
    if (
      part.type === 'year' ||
      part.type === 'month' ||
      part.type === 'day'
    ) {
      values[part.type] = Number(part.value);
    }
  }

  return Math.floor(
    Date.UTC(
      values.year,
      values.month - 1,
      values.day
    ) / DAY_MS
  );
}

// ==========================================
// DAILY INSTALLMENT CHECK
// ==========================================

export async function checkSchemeInstallments() {
  const today = new Date();
  const todayDay = getISTDayNumber(today);

  console.log(
    '[SCHEME CRON] Checking installments:',
    today.toISOString()
  );

  try {
    const schemes = await Scheme.find({
      status: {
        $in: ['Active', 'GracePeriod']
      }
    });

    let graceCount = 0;
    let reviewCount = 0;
    let errorCount = 0;

    for (const scheme of schemes) {
      try {
        if (!scheme.dueDate) {
          continue;
        }

        const dueDay = getISTDayNumber(
          scheme.dueDate
        );

        const overdueDays = todayDay - dueDay;

        // ==================================
        // NOT OVERDUE
        // ==================================

        if (overdueDays <= 0) {
          if (scheme.status === 'GracePeriod') {
            scheme.status = 'Active';
            scheme.gracePeriodStartDate = null;
            await scheme.save();
          }

          continue;
        }

        // ==================================
        // WITHIN FIVE-DAY GRACE PERIOD
        // ==================================

        if (
          overdueDays >= 1 &&
          overdueDays <= GRACE_DAYS
        ) {
          if (scheme.status !== 'GracePeriod') {
            scheme.status = 'GracePeriod';

            scheme.gracePeriodStartDate =
              scheme.gracePeriodStartDate || today;

            await scheme.save();
          }

          graceCount++;

          // Reminder is only logged here.
          // Actual WhatsApp/SMS delivery requires
          // a configured messaging provider.
          console.log(
            `[REMINDER DUE] Scheme ${scheme._id}, ` +
            `Customer ${scheme.userId}, ` +
            `${overdueDays} day(s) overdue.`
          );

          continue;
        }

        // ==================================
        // GRACE PERIOD EXPIRED
        // ==================================

        if (overdueDays > GRACE_DAYS) {
          scheme.status = 'PendingAdminReview';

          scheme.gracePeriodStartDate =
            scheme.gracePeriodStartDate || today;

          await scheme.save();

          reviewCount++;

          console.log(
            `[ADMIN REVIEW] Scheme ${scheme._id} ` +
            `is ${overdueDays} days overdue.`
          );
        }
      } catch (schemeError) {
        errorCount++;

        console.error(
          `[SCHEME ERROR] ${scheme._id}:`,
          schemeError
        );
      }
    }

    console.log('[SCHEME CRON] Finished', {
      checked: schemes.length,
      graceCount,
      reviewCount,
      errorCount
    });
  } catch (error) {
    console.error(
      '[SCHEME CRON] Daily check failed:',
      error
    );
  }
}

// ==========================================
// RUN EVERY DAY AT 12:00 AM INDIA TIME
// ==========================================

cron.schedule(
  '0 0 * * *',
  checkSchemeInstallments,
  {
    timezone: TIMEZONE,
    noOverlap: true
  }
);

console.log(
  '[SCHEME CRON] Scheduled daily at 12:00 AM IST.'
);
