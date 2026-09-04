import cron from 'node-cron';
import Scheme from '../models/Scheme.js';

// Mock notification function
const sendReminderNotification = async (scheme) => {
  console.log(`[NOTIFICATION] Reminder sent to User ${scheme.userId} for Scheme ${scheme._id}. Payment is overdue.`);
};

// Run daily at midnight: 0 0 * * *
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily installment check cron job...');
  const today = new Date();

  try {
    const activeSchemes = await Scheme.find({ status: { $in: ['Active', 'GracePeriod'] } });

    for (const scheme of activeSchemes) {
      if (!scheme.dueDate) continue;

      const diffTime = today - new Date(scheme.dueDate);
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays > 0 && diffDays <= 5) {
        // Within 5-day grace period
        if (scheme.status !== 'GracePeriod') {
          scheme.status = 'GracePeriod';
          scheme.gracePeriodStartDate = scheme.gracePeriodStartDate || today;
        }
        await scheme.save();
        await sendReminderNotification(scheme);
      } else if (diffDays > 5) {
        // Exceeded 5-day grace period -> Transition to Pending Admin Review
        scheme.status = 'PendingAdminReview';
        await scheme.save();
        console.log(`[STATUS UPDATE] Scheme ${scheme._id} moved to Pending Admin Review.`);
      }
    }
  } catch (error) {
    console.error('Error running installment cron job:', error);
  }
});