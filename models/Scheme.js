
import mongoose from 'mongoose';

// ==========================================
// RAHUL JEWELLERS
// GOLD SAVINGS SCHEME DATABASE MODEL
// ==========================================

const schemeSchema = new mongoose.Schema(
  {
    // Customer linked with this scheme
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    // Current scheme status
    status: {
      type: String,
      enum: [
        'Active',
        'GracePeriod',
        'PendingAdminReview',
        'Completed',
        'Cancelled'
      ],
      default: 'Active'
    },

    // Next installment due date
    dueDate: {
      type: Date,
      required: true
    },

    // Grace period tracking
    gracePeriodStartDate: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Faster customer scheme lookup
schemeSchema.index({
  userId: 1,
  status: 1
});

// Prevent duplicate model registration
const Scheme =
  mongoose.models.Scheme ||
  mongoose.model('Scheme', schemeSchema);

export default Scheme;
