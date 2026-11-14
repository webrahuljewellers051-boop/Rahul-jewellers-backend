
import express from 'express';
import mongoose from 'mongoose';

import Scheme from '../models/Scheme.js';
import requireAdmin from '../middleware/adminAuth.js';

const router = express.Router();

// ==========================================
// RAHUL JEWELLERS — SCHEME ROUTES
// ==========================================

// Move a due date one calendar month forward.
// Preserve end-of-month dates correctly.
function addOneCalendarMonth(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid scheme due date.');
  }

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const sourceLastDay = new Date(
    Date.UTC(year, month + 1, 0)
  ).getUTCDate();

  const targetLastDay = new Date(
    Date.UTC(year, month + 2, 0)
  ).getUTCDate();

  const nextDay =
    day === sourceLastDay
      ? targetLastDay
      : Math.min(day, targetLastDay);

  const result = new Date(date);

  result.setUTCDate(1);
  result.setUTCMonth(month + 1);
  result.setUTCDate(nextDay);

  return result;
}

function apiError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function handleError(error, res) {
  const status = error.status || 500;

  if (status === 500) {
    console.error('Scheme API error:', error);
  }

  return res.status(status).json({
    success: false,
    message:
      status === 500
        ? 'Unable to complete the request.'
        : error.message
  });
}

// ==========================================
// ADMIN: CONFIRM VERIFIED INSTALLMENT
// POST /api/schemes/:id/pay
// ==========================================
//
// Request body:
// {
//   "verified": true,
//   "transactionId": "123456789012",
//   "amount": 10000
// }
//
// IMPORTANT:
// verified=true is an admin confirmation,
// NOT proof that a bank payment happened.
// Admin must verify the payment independently.
// ==========================================

router.post('/:id/pay', requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid scheme ID.'
      });
    }

    const {
      verified,
      transactionId,
      amount
    } = req.body || {};

    if (verified !== true) {
      return res.status(400).json({
        success: false,
        message: 'Payment must be verified by admin first.'
      });
    }

    const cleanTransactionId = String(
      transactionId || ''
    ).trim().toUpperCase();

    if (!/^[A-Z0-9]{10,35}$/.test(cleanTransactionId)) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid bank transaction reference.'
      });
    }

    const paymentAmount = Number(amount);

    if (
      !Number.isFinite(paymentAmount) ||
      paymentAmount <= 0 ||
      paymentAmount > 10000000
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid installment amount.'
      });
    }

    let result;

    // MongoDB Atlas supports transactions.
    // Both scheme and customer ledger update together.
    await mongoose.connection.transaction(async (session) => {
      const scheme = await Scheme.findById(
        req.params.id
      ).session(session);

      if (!scheme) {
        throw apiError(404, 'Scheme not found.');
      }

      if (
        ['Completed', 'Cancelled'].includes(scheme.status)
      ) {
        throw apiError(
          400,
          'This scheme cannot accept further payments.'
        );
      }

      // User model is registered by server.js
      // before mounting /api/schemes.
      const User = mongoose.model('User');

      const customer = await User.findById(
        scheme.userId
      ).session(session);

      if (!customer) {
        throw apiError(
          404,
          'Linked customer account not found.'
        );
      }

      if (customer.isActive === false) {
        throw apiError(
          403,
          'Customer account is inactive.'
        );
      }

      const expectedAmount = Number(
        customer.customInstallment || 10000
      );

      if (
        Math.abs(paymentAmount - expectedAmount) > 0.009
      ) {
        throw apiError(
          400,
          `Installment amount must be ₹${expectedAmount}.`
        );
      }

      const paidMonths = Number(
        customer.paidMonths || 0
      );

      if (paidMonths >= 12) {
        throw apiError(
          409,
          'All 12 installments are already paid.'
        );
      }

      const nextMonth = paidMonths + 1;

      const existingPayment =
        customer.paymentHistory.some(
          (payment) =>
            payment.monthNum === nextMonth ||
            String(payment.transactionId).toUpperCase() ===
              cleanTransactionId
        );

      if (existingPayment) {
        throw apiError(
          409,
          'Installment or transaction already recorded.'
        );
      }

      // Also check whether the same UTR is already
      // recorded against another customer.
      const duplicateUTR = await User.exists({
        'paymentHistory.transactionId':
          cleanTransactionId
      }).session(session);

      if (duplicateUTR) {
        throw apiError(
          409,
          'Transaction reference already used.'
        );
      }

      const paidAt = new Date();

      customer.paymentHistory.push({
        monthNum: nextMonth,
        amount: paymentAmount,
        transactionId: cleanTransactionId,
        paidAt
      });

      customer.paidMonths = nextMonth;

      if (nextMonth >= 12) {
        customer.isLaborFree = true;
      }

      await customer.save({ session });

      scheme.dueDate = addOneCalendarMonth(
        scheme.dueDate
      );

      scheme.status =
        nextMonth >= 12 ? 'Completed' : 'Active';

      scheme.gracePeriodStartDate = null;

      await scheme.save({ session });

      const safeCustomer = customer.toObject();

      delete safeCustomer.password;

      result = {
        scheme,
        customer: safeCustomer,
        installmentNumber: nextMonth
      };
    });

    return res.json({
      success: true,
      message: 'Verified installment recorded successfully.',
      ...result
    });
  } catch (error) {
    return handleError(error, res);
  }
});

// ==========================================
// ADMIN: CANCEL SCHEME AFTER GRACE PERIOD
// POST /api/schemes/admin/:id/cancel
// ==========================================

router.post(
  '/admin/:id/cancel',
  requireAdmin,
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid scheme ID.'
        });
      }

      const scheme = await Scheme.findOneAndUpdate(
        {
          _id: req.params.id,
          status: 'PendingAdminReview'
        },
        {
          $set: {
            status: 'Cancelled'
          }
        },
        {
          new: true,
          runValidators: true
        }
      );

      if (!scheme) {
        return res.status(409).json({
          success: false,
          message:
            'Scheme not found or not pending admin review.'
        });
      }

      return res.json({
        success: true,
        message: 'Scheme cancelled by admin.',
        scheme
      });
    } catch (error) {
      return handleError(error, res);
    }
  }
);

export default router;
