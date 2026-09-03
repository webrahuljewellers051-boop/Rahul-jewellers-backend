const mongoose = require('mongoose');

const SchemeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  schemeName: { type: String, required: true },
  installmentAmount: { type: Number, required: true },
  dueDate: { type: Date, required: true },
  status: { 
    type: String, 
    enum: ['Active', 'GracePeriod', 'PendingAdminReview', 'Completed', 'Cancelled'], 
    default: 'Active' 
  },
  gracePeriodStartDate: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Scheme', SchemeSchema);