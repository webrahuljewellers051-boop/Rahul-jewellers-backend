import express from 'express';
import mongoose from 'mongoose';

const router = express.Router();

// Get the Scheme model safely whether it's registered or not
const Scheme = mongoose.models.Scheme || mongoose.model('Scheme', new mongoose.Schema({}));

// ** Successful Payment Endpoint (Shifts Due Date)**
router.post('/:id/pay', async (req, res) => {
  try {
    const scheme = await Scheme.findById(req.params.id);
    if (!scheme) return res.status(404).json({ error: 'Scheme not found' });

    if (['Completed', 'Cancelled'].includes(scheme.status)) {
      return res.status(400).json({ error: `Cannot pay for a ${scheme.status.toLowerCase()} scheme.` });
    }

    // Shift due date forward by 1 month
    const currentDueDate = new Date(scheme.dueDate);
    currentDueDate.setMonth(currentDueDate.getMonth() + 1);
    scheme.dueDate = currentDueDate;

    // Reset status back to Active and clear grace tracking
    scheme.status = 'Active';
    scheme.gracePeriodStartDate = null;

    await scheme.save();
    res.json({ message: 'Payment successful. Due date shifted by 1 month.', scheme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ** Admin Endpoint: Manual Cancellation after Grace Period**
router.post('/admin/:id/cancel', async (req, res) => {
  try {
    const scheme = await Scheme.findById(req.params.id);
    if (!scheme) return res.status(404).json({ error: 'Scheme not found' });

    if (scheme.status !== 'PendingAdminReview') {
      return res.status(400).json({ error: 'Scheme must be in Pending Admin Review state to be cancelled.' });
    }

    scheme.status = 'Cancelled';
    await scheme.save();

    res.json({ message: 'Scheme successfully cancelled by admin.', scheme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;