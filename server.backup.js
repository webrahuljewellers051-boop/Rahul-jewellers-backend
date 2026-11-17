
// Rahul Jewellers SHEOGANJ — complete backend server.js
// RJ_BACKEND_UPDATE_V3
// Required .env: MONGO_URI, JWT_SECRET, ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM,
// CORS_ORIGINS (comma-separated customer/admin website origins).
// Optional: PORT, GEMINI_API_KEY, GEMINI_MODEL, SCHEME_DEADLINE_START_MONTH.
// For independent 5-minute Render Cron Job set SCHEME_CRON_SECRET.

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { Resend } from 'resend';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { randomInt, randomBytes, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import * as scheme from './schemeLogic.js';
import { mainCategoryName, isProtectedRoot, canMoveBetweenRoots } from './categoryPolicy.js';

dotenv.config();
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'web.rahuljewellers051@gmail.com').trim().toLowerCase();
const RESEND_FROM = process.env.RESEND_FROM || 'onboarding@resend.dev';
const SCHEME_DEADLINE_START_MONTH = process.env.SCHEME_DEADLINE_START_MONTH || '2026-12';

if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(SCHEME_DEADLINE_START_MONTH))
  throw new Error('SCHEME_DEADLINE_START_MONTH must be YYYY-MM.');
if (!MONGO_URI) throw new Error('MONGO_URI is required.');
if (!JWT_SECRET || JWT_SECRET.length < 32)
  throw new Error('Set a strong JWT_SECRET of at least 32 characters.');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const scrypt = promisify(scryptCallback);
const allowedOrigins = new Set(
  [process.env.CORS_ORIGINS, process.env.CLIENT_ORIGIN, process.env.ADMIN_ORIGIN]
    .filter(Boolean).flatMap(x => x.split(',')).map(x => x.trim().replace(/\/$/, '')).filter(Boolean)
);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.has(origin) ||
      (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost(?::\d+)?$/.test(origin)))
      return cb(null, true);
    return cb(new Error('Origin not allowed; configure CORS_ORIGINS.'));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' }
});

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (status, message) => { throw new ApiError(status, message); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = value => String(value ?? '').trim();
const safe = (value, limit = 300) => clean(value).slice(0, limit);
const validId = value => mongoose.isValidObjectId(value);
const validPhone = value => /^[6-9]\d{9}$/.test(value);
const normalizeEmail = value => clean(value).toLowerCase();
const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
const validAmount = value => Number.isInteger(value) && value >= 5000 && value <= 1000000;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


function istParts(date, fields) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', ...fields
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function istDate(date = new Date()) {
  const p = istParts(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}
function istMonth(date = new Date()) {
  const p = istParts(date, { year: 'numeric', month: '2-digit' });
  return Number(p.year) * 12 + Number(p.month);
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s <= istDate();
}
function monthIndex(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + m - 1;
}
function monthFromIndex(index) {
  const year = Math.floor(index / 12), month = index % 12 + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}
function shiftMonth(ym, offset) { return monthFromIndex(monthIndex(ym) + offset); }
function addDaysISO(isoDate, days) {
  const ms = Date.parse(`${isoDate}T00:00:00.000Z`);
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}
function daysBetweenISO(first, second) {
  return Math.round((Date.parse(`${second}T00:00:00.000Z`) -
    Date.parse(`${first}T00:00:00.000Z`)) / 86400000);
}
function schemeAnchorDay(c) {
  const stored = Number(c?.schemeAnchorDay || 0);
  if (Number.isInteger(stored) && stored >= 1 && stored <= 31) return stored;
  const day = Number(String(c?.startDate || '').slice(8, 10));
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1;
}
function dueDateInMonth(ym, anchorDay) {
  const [year, month] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${ym}-${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
}
function schemeCycle(c) { return Number(c?.schemeCycle || 1); }
function cycleFilter(cycle) {
  return Number(cycle) === 1 ? { $in: [1, null] } : Number(cycle);
}
function schemeDeadlineFor(c) { return scheme.deadline(c); }
function currentStates(c) { return scheme.states(c); }
function currentRows(c) { return scheme.installmentRows(c); }
function countPaid(c) { return scheme.paidCount(c); }
function requestMonths(request) {
  const nums = Array.isArray(request.monthNums) && request.monthNums.length
    ? request.monthNums : [request.monthNum];
  return [...new Set(nums.map(Number))].sort((a, b) => a - b);
}
function sameCycleHistory(c) { return scheme.currentHistory(c); }
function writeStates(c, states) {
  c.installmentState = states.map(x => ({
    monthNum: x.monthNum, paid: Boolean(x.paid),
    transactionId: x.transactionId || '', method: x.method || '',
    paidAt: x.paidAt || null,
    amount: Number(x.amount || c.customInstallment || 0)
  }));
  c.paidMonths = states.filter(x => x.paid).length;
  c.isLaborFree = false;
  c.paymentRevision = Number(c.paymentRevision || 0) + 1;
}
function pendingMonthsQuery(nums) {
  return { $or: [{ monthNums: { $in: nums } }, { monthNum: { $in: nums } }] };
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, salt, hex] = stored.split('$');
    if (!/^[a-f0-9]{32}$/i.test(salt || '') || !/^[a-f0-9]{128}$/i.test(hex || '')) return false;
    return timingSafeEqual(await scrypt(password, salt, 64), Buffer.from(hex, 'hex'));
  }
  const a = Buffer.from(password), b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

const StoreSettings = mongoose.models.StoreSettings ||
  mongoose.model('StoreSettings', new mongoose.Schema({
    _id: {
      type: String,
      default: 'store_config'
    },
    upiId: {
      type: String,
      default: ''
    },
    merchantName: {
      type: String,
      default: 'Rahul Jewellers'
    },
    qrCodeUrl: {
      type: String,
      default: ''
    },
    contactNumbers: {
      type: [String],
      default: [
        '9950091024',
        '9461452322'
      ]
    }
  }, {
    timestamps: true
  }));

const paymentHistorySchema = new mongoose.Schema({
  monthNum: { type: Number, required: true, min: 1, max: 12 },
  amount: { type: Number, required: true },
  transactionId: { type: String, required: true },
  paidAt: { type: Date, default: Date.now },
  verifiedAt: { type: Date },
  method: { type: String, default: 'Manual' },
  schemeCycle: { type: Number, default: 1 }
}, { _id: false });

const userSchema = new mongoose.Schema({
  customerId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  dob: { type: String, default: '' },
  phone: { type: String, required: true, unique: true },
  email: { type: String, default: '', trim: true, lowercase: true },
  password: { type: String, required: true, select: false },
  address: { type: String, default: '' },
  schemeJoined: { type: Boolean, default: false },
  schemeJoinedAt: { type: Date },
  schemeStatus: {
    type: String,
    enum: ['NotJoined', 'Active', 'Cancelled', 'Suspended', 'RefundPending', 'Refunded'],
    default: 'NotJoined'
  },
  schemeFirstDueMonth: { type: String, default: '' },
  schemeAnchorDay: { type: Number, default: 0 },
  schemeScheduleVersion: { type: Number, default: 1 },
  schemeTermsAcceptedAt: Date,
  schemeTermsVersion: { type: String, default: '' },
  schemeCycle: { type: Number, default: 1 },
  paymentRevision: { type: Number, default: 0 },
  installmentState: {
    type: [{
      monthNum: { type: Number, min: 1, max: 12 },
      paid: { type: Boolean, default: false },
      transactionId: { type: String, default: '' },
      method: { type: String, default: '' },
      paidAt: Date,
      amount: { type: Number, default: 0 }
    }],
    default: []
  },
  schemeCatchupUntil: { type: String, default: '' },
  schemeCatchupMonthNums: { type: [Number], default: [] },
  schemeManualOverdueMonths: { type: [Number], default: [] },
  reactivationRequest: {
    type: {
      status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
      reason: { type: String, default: '' },
      requestedAt: Date, reviewedAt: Date,
      adminReason: { type: String, default: '' }
    },
    default: null
  },
  tokenVersion: { type: Number, default: 0 },
  schemeSuspendedAt: Date,
  schemeSuspendedDueMonth: { type: String, default: '' },
  schemeSuspendedDueDate: { type: String, default: '' },
  schemeCustomerReason: { type: String, default: '' },
  schemeAdminDecision: { type: String, default: '' },
  schemeRefundAmount: { type: Number, default: 0 },
  schemeRefundReference: { type: String, default: '' },
  schemeRefundedAt: Date,
  customInstallment: { type: Number, default: 10000 },
  paidMonths: { type: Number, default: 0, min: 0, max: 12 },
  isLaborFree: { type: Boolean, default: false },
  startDate: { type: String, default: '' },
  finalDueDate: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  paymentHistory: { type: [paymentHistorySchema], default: [] },
  cart: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number, default: 1 }
  }],
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }]
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

const Category = mongoose.models.Category || mongoose.model('Category', new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  parentCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null }
}, { timestamps: true }));

const productSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  sku: {
    type: String,
    default: ''
  },
  category: {
    type: String,
    required: true
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    default: null
  },
  metal: {
    type: String,
    default: ''
  },
  purity: {
    type: String,
    default: ''
  },
  weight: {
    type: String,
    required: true
  },
  netWeight: {
    type: String,
    default: ''
  },
  grossWeight: {
    type: String,
    default: ''
  },
  stone: {
    type: String,
    default: ''
  },
  design: {
    type: String,
    default: ''
  },
  craftsmanship: {
    type: String,
    default: ''
  },
  description: {
    type: String,
    default: ''
  },
  price: {
    type: Number,
    default: 0,
    min: 0
  },
  imageUrl: {
    type: String,
    required: true
  },
  images: [{
    url: {
      type: String,
      required: true
    },
    alt: {
      type: String,
      default: ''
    }
  }]
}, {
  timestamps: true
});

const Product = mongoose.models.Product ||
  mongoose.model('Product', productSchema);

const paymentRequestSchema = new mongoose.Schema({
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', required: true, index: true
  },
  customerId: { type: String, required: true },
  schemeCycle: { type: Number, default: 1, index: true },
  monthNum: { type: Number, required: true, min: 1, max: 12 },
  monthNums: { type: [Number], default: [] },
  amount: { type: Number, required: true },
  appliedMonthNums: { type: [Number], default: [] },
  transactionId: { type: String, required: true, unique: true },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected'],
    default: 'Pending', index: true
  },
  reviewedAt: Date,
  reviewedBy: String,
  rejectionReason: { type: String, default: '' },
  passbookApplied: { type: Boolean, default: false },
  passbookAdjustments: {
    type: [{
      action: { type: String, enum: ['PAY', 'UNPAY'], required: true },
      at: { type: Date, default: Date.now },
      by: String,
      reason: String
    }],
    default: []
  }
}, { timestamps: true });

paymentRequestSchema.index(
  { customer: 1, monthNum: 1 },
  { unique: true, partialFilterExpression: { status: 'Pending' } }
);
const PaymentRequest = mongoose.models.PaymentRequest ||
  mongoose.model('PaymentRequest', paymentRequestSchema);

const AdminAudit = mongoose.models.AdminAudit || mongoose.model('AdminAudit', new mongoose.Schema({
  action: { type: String, required: true, index: true },
  customerRef: { type: mongoose.Schema.Types.ObjectId, index: true },
  customerId: { type: String, required: true, index: true },
  monthNum: Number,
  reason: { type: String, required: true },
  actor: { type: String, default: ADMIN_EMAIL },
  details: mongoose.Schema.Types.Mixed
}, { timestamps: true }));


const benefitClaimSchema = new mongoose.Schema({
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  customerId: {
    type: String,
    required: true
  },
  schemeCycle: {
    type: Number,
    required: true
  },
  claimId: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: [
      'Pending',
      'Verified',
      'Redeemed',
      'Revoked'
    ],
    default: 'Pending'
  },
  originalStartDate: String,
  benefitDate: String,
  totalPaid: Number,
  verifiedInstallments: Number,
  verifiedAt: Date,
  verifiedBy: String,
  redeemedAt: Date,
  redeemedBy: String,
  redeemedProduct: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  },
  makingCharges: {
    type: Number,
    default: 0
  },
  discountAmount: {
    type: Number,
    default: 0
  },
  adminReason: {
    type: String,
    default: ''
  },
  needsReview: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

benefitClaimSchema.index(
  {
    customer: 1,
    schemeCycle: 1
  },
  {
    unique: true
  }
);

const BenefitClaim = mongoose.models.BenefitClaim ||
  mongoose.model('BenefitClaim', benefitClaimSchema);

const GoldRate = mongoose.models.GoldRate || mongoose.model('GoldRate', new mongoose.Schema({
  _id: { type: String, default: 'published_gold_rate' },
  enabled: { type: Boolean, default: false },
  carat: { type: String, default: '22K' },
  priceInrPerGram: { type: Number, default: 0 },
  updatedBy: { type: String, default: 'admin' }
}, { timestamps: true }));

function discountEligible(c) { return scheme.eligible(c); }
function publicCustomer(c) {
  if (!c) return null;
  const obj = typeof c.toObject === 'function' ? c.toObject() : { ...c };
  delete obj.password;
  delete obj.__v;
  obj.installments = scheme.installmentRows(obj);
  obj.paidMonths = obj.installments.filter(i => i.paid).length;
  obj.schemeDisplayStatus =
    obj.schemeStatus === 'Active' && obj.paidMonths === 12
      ? 'COMPLETED' : obj.schemeStatus;
  obj.totalInstallments = 12;
  obj.unpaidMonths = 12 - obj.paidMonths;
  obj.totalSchemeAmount = 12 * Number(obj.customInstallment || 0);
  obj.totalPaidAmount = obj.paidMonths * Number(obj.customInstallment || 0);
  obj.remainingAmount = obj.totalSchemeAmount - obj.totalPaidAmount;
  obj.schemeBenefitDate = scheme.schemeBenefitDate(obj);
  obj.schemeSchedule = obj.schemeJoined ? {
    option: Number(obj.schemeScheduleVersion || 1) >= scheme.OPTION_A_SCHEDULE_VERSION
      ? 'A' : 'Legacy',
    firstInstallmentDate: scheme.dueDateFor(obj, 1),
    twelfthInstallmentDate: scheme.dueDateFor(obj, 12),
    benefitDate: obj.schemeBenefitDate,
    paymentWindowDays: scheme.PAYMENT_WINDOW_DAYS
  } : null;
  obj.eligibleForMakingChargeDiscount = discountEligible(obj);
  obj.isLaborFree = obj.eligibleForMakingChargeDiscount;
  obj.benefitStatus = obj.eligibleForMakingChargeDiscount
    ? 'BENEFIT_UNLOCKED' : 'BENEFIT_LOCKED';
  obj.schemeDeadline = schemeDeadlineFor(obj);
  obj.schemeId = `${obj.customerId || ''}-C${schemeCycle(obj)}`;
  obj.archivedPaymentHistory = (obj.paymentHistory || [])
    .filter(p => scheme.paymentCycle(p) !== schemeCycle(obj));
  obj.paymentHistory = sameCycleHistory(obj);
  return obj;
}


async function reconcileBenefitClaims(
  customer,
  reason = 'Scheme eligibility changed'
) {
  if (!customer) return;

  if (scheme.eligible(customer)) {
    return;
  }

  const activeClaims = await BenefitClaim.find({
    customer: customer._id,
    schemeCycle: schemeCycle(customer),
    status: {
      $in: ['Pending', 'Verified']
    }
  });

  for (const claim of activeClaims) {
    claim.status = 'Revoked';
    claim.adminReason = reason;
    claim.needsReview = false;
    await claim.save();

    await AdminAudit.create({
      action: 'BENEFIT_CLAIM_REVOKED',
      customerRef: customer._id,
      customerId: customer.customerId,
      reason,
      details: {
        claimId: claim.claimId,
        cycle: schemeCycle(customer)
      }
    });
  }

  // A redeemed claim must retain its redemption
  // history, even if an installment is reversed.
  await BenefitClaim.updateMany({
    customer: customer._id,
    schemeCycle: schemeCycle(customer),
    status: 'Redeemed'
  }, {
    $set: {
      needsReview: true,
      adminReason: reason
    }
  });
}

// Pending UPI submitted on time protects selected installments.
async function ensureSchemeFresh(customer) {
  if (!customer || !customer.schemeJoined ||
      (customer.schemeStatus && customer.schemeStatus !== 'Active'))
    return customer;

  const today = istDate();
  const overdue = scheme.overdueRows(customer, today);
  if (!overdue.length) return customer;

  const pending = await PaymentRequest.find({
    customer: customer._id,
    schemeCycle: cycleFilter(schemeCycle(customer)),
    status: 'Pending',
    ...pendingMonthsQuery(overdue.map(x => x.monthNum))
  }).select('monthNum monthNums createdAt').lean();

  const missed = overdue.find(row =>
    !pending.some(req =>
      requestMonths(req).includes(row.monthNum) &&
      istDate(new Date(req.createdAt)) <= (
        customer.schemeCatchupMonthNums?.includes(row.monthNum) &&
        customer.schemeCatchupUntil
          ? customer.schemeCatchupUntil : row.lastDate
      )
    )
  );

  if (!missed) return customer;

  const updated = await User.findOneAndUpdate({
    _id: customer._id,
    schemeJoined: true,
    schemeStatus: 'Active',
    paymentRevision: Number(customer.paymentRevision || 0)
  }, {
    $set: {
      schemeStatus: 'Cancelled',
      schemeSuspendedAt: new Date(),
      schemeSuspendedDueMonth: missed.dueDate.slice(0, 7),
      schemeSuspendedDueDate: missed.dueDate,
      schemeAdminDecision:
        'Automatic cancellation: unpaid installment past 5-day deadline'
    }
  }, { new: true });

  if (updated) {
    await reconcileBenefitClaims(
      updated,
      'Scheme automatically cancelled after missed deadline'
    );

    await AdminAudit.create({
      action: 'SCHEME_AUTO_CANCEL',
      customerRef: updated._id,
      customerId: updated.customerId,
      monthNum: missed.monthNum,
      reason: 'Installment overdue without verified payment or timely pending UPI',
      details: {
        dueDate: missed.dueDate,
        lastDate: missed.lastDate,
        cycle: schemeCycle(updated)
      }
    });
    return updated;
  }
  return await User.findById(customer._id) || customer;
}

async function sweepOverdueSchemes() {
  const candidates = User.find({
    schemeJoined: true, schemeStatus: 'Active'
  }).cursor();
  for await (const c of candidates) {
    try { await ensureSchemeFresh(c); }
    catch (err) {
      console.error('Scheme sweep failed', c.customerId, err);
    }
  }
}

function refundQuoteFromLedger(customer, approved) {
  const approvedUtrs = new Set(approved.map(p => p.transactionId));
  const history = sameCycleHistory(customer);
  const upi = approved.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const legacyUpi = history
    .filter(p => p.method === 'UPI' && !approvedUtrs.has(p.transactionId))
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const manual = history
    .filter(p => p.method !== 'UPI')
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  return {
    upi, legacyUpi, manual, total: upi + legacyUpi + manual,
    note: 'Financial receipt total (not current passbook total). Verify bank/cash records before refund.'
  };
}
async function refundQuote(customer) {
  const approved = await PaymentRequest.find({
    customer: customer._id,
    schemeCycle: cycleFilter(schemeCycle(customer)),
    status: 'Approved'
  }).lean();
  return refundQuoteFromLedger(customer, approved);
}

function customerToken(c) {
  return jwt.sign({
    sub: String(c._id),
    role: 'customer',
    type: 'customer',
    v: Number(c.tokenVersion || 0)
  }, JWT_SECRET, { expiresIn: '7d' });
}
function readToken(req, cookieName) {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice(7).trim() : req.cookies?.[cookieName];
}
function adminAuth(req, res, next) {
  try {
    const token = readToken(req, 'admin_token');
    if (!token)
      return res.status(401).json({
        success: false, message: 'Admin login required.'
      });
    const p = jwt.verify(token, JWT_SECRET);
    if (clean(p.email).toLowerCase() !== ADMIN_EMAIL ||
        !(p.type === 'admin' || p.role === 'admin' ||
          (!p.type && !p.role))) {
      return res.status(403).json({
        success: false, message: 'Admin access only.'
      });
    }
    next();
  } catch {
    res.status(401).json({
      success: false, message: 'Admin session expired.'
    });
  }
}

const customerAuth = wrap(async (req, res, next) => {
  const token = readToken(req, 'customer_token');
  if (!token) bad(401, 'Customer login required.');
  let p;
  try { p = jwt.verify(token, JWT_SECRET); }
  catch { bad(401, 'Customer session expired.'); }
  if (p.type !== 'customer' && p.role !== 'customer')
    bad(403, 'Customer access only.');
  if (!validId(p.sub)) bad(401, 'Invalid customer token.');
  let customer = await User.findById(p.sub);
  if (!customer) bad(401, 'Customer account not found.');
  if (customer.isActive === false)
    bad(403, 'Account deactivated.');
  if (Number(p.v || 0) !== Number(customer.tokenVersion || 0))
    bad(401, 'Customer session expired after password reset. Please log in again.');
  customer = await ensureSchemeFresh(customer);
  req.customer = customer;
  next();
});

app.get('/', (_req, res) =>
  res.send('Rahul Jewellers SHEOGANJ Backend is Running'));
app.get('/health', (_req, res) =>
  res.json({
    success: true,
    database: mongoose.connection.readyState === 1
      ? 'connected' : 'disconnected'
  }));

// ADMIN EMAIL OTP
const otpStorage = new Map();

app.post('/api/client/send-email-otp', loginLimiter, wrap(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  if (email !== ADMIN_EMAIL) bad(403, 'Unauthorized admin email.');
  if (!resend) bad(503, 'RESEND_API_KEY is not configured.');
  const otp = String(randomInt(100000, 1000000));
  const result = await resend.emails.send({
    from: RESEND_FROM,
    to: [ADMIN_EMAIL],
    subject: 'Rahul Jewellers Admin Login OTP',
    html: `<p>Your admin verification code: <strong>${otp}</strong> (valid for 5 minutes).</p>`
  });
  if (result.error)
    bad(502, 'OTP email could not be sent. Check verified sender.');
  otpStorage.set(email, {
    hash: createHash('sha256').update(otp).digest('hex'),
    expires: Date.now() + 300000,
    attempts: 0
  });
  res.json({ success: true, message: 'Admin OTP sent.' });
}));

app.post('/api/client/verify-email-otp', loginLimiter, wrap(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const otp = clean(req.body.otp);
  const record = otpStorage.get(email);
  if (email !== ADMIN_EMAIL || !record ||
      record.expires < Date.now() || record.attempts >= 5)
    bad(401, 'OTP expired or invalid.');
  record.attempts++;
  if (!/^\d{6}$/.test(otp) ||
      !timingSafeEqual(
        createHash('sha256').update(otp).digest(),
        Buffer.from(record.hash, 'hex')
      ))
    bad(401, 'Incorrect OTP.');
  otpStorage.delete(email);
  const token = jwt.sign({
    sub: 'admin', type: 'admin', role: 'admin', email
  }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    success: true, token, message: 'Admin verified.'
  });
}));

app.get('/api/client/admin-session', adminAuth,
  (_req, res) => res.json({
    success: true, message: 'Session active.'
  }));
app.post('/api/client/admin-logout', (_req, res) => {
  res.clearCookie('admin_token', {
    httpOnly: true, secure: true, sameSite: 'none'
  });
  res.json({ success: true });
});

// SHOWROOM PRODUCTS AND NESTED CATEGORIES

function validJewelleryImage(value) {
  return /^(https:\/\/|data:image\/(?:png|jpeg|webp|gif);base64,)/i
    .test(String(value || ''));
}

function jewellerySlug(title) {
  const base = String(title || 'jewellery')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 65) || 'jewellery';

  return base + '-' + randomBytes(4).toString('hex');
}

function normalizeImages(body, existing = []) {
  if (
    body.images === undefined &&
    body.imageUrl === undefined
  ) {
    return existing;
  }

  let images = body.images;

  if (!Array.isArray(images)) {
    images = body.imageUrl
      ? [body.imageUrl]
      : existing;
  }

  if (images.length > 12) {
    bad(400, 'Maximum 12 product images are allowed.');
  }

  return images.map((image, index) => {
    const url = typeof image === 'string'
      ? image
      : image?.url;

    const alt = typeof image === 'string'
      ? ''
      : image?.alt;

    if (!validJewelleryImage(url)) {
      bad(
        400,
        'Invalid image URL at position ' + (index + 1)
      );
    }

    return {
      url: String(url),
      alt: safe(alt, 150)
    };
  });
}

async function getRootCategory(categoryId, session = null) {
  if (!categoryId) return null;

  let current = await Category.findById(
    categoryId
  ).session(session).lean();

  if (!current) {
    bad(404, 'Selected jewellery folder not found.');
  }

  const visited = new Set();

  while (current.parentCategory) {
    const id = String(current._id);

    if (visited.has(id)) {
      bad(409, 'Category hierarchy contains a cycle.');
    }

    visited.add(id);

    current = await Category.findById(
      current.parentCategory
    ).session(session).lean();

    if (!current) {
      bad(409, 'Category parent is missing.');
    }
  }

  return current;
}

async function categoryTreeIds(rootId, session = null) {
  const all = await Category.find()
    .select('_id parentCategory')
    .session(session)
    .lean();

  const result = new Set([String(rootId)]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const item of all) {
      const parent = String(
        item.parentCategory || ''
      );

      const id = String(item._id);

      if (result.has(parent) && !result.has(id)) {
        result.add(id);
        changed = true;
      }
    }
  }

  return [...result];
}

async function siblingCategoryExists(name, parentId, excludeId = null) {
  const query = {
    name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
    parentCategory: parentId || null
  };
  if (excludeId) query._id = { $ne: excludeId };
  return Boolean(await Category.exists(query));
}

function productFields(body, current = null) {
  const fields = {};

  const textFields = [
    'title',
    'sku',
    'metal',
    'purity',
    'weight',
    'netWeight',
    'grossWeight',
    'stone',
    'design',
    'craftsmanship',
    'description'
  ];

  for (const field of textFields) {
    if (body[field] === undefined) continue;

    fields[field] = safe(
      body[field],
      field === 'description' ? 4000 : 300
    );
  }

  if (body.category !== undefined) {
    fields.category = safe(body.category, 100);
  }

  if (body.price !== undefined) {
    const price = Number(body.price || 0);

    if (!Number.isFinite(price) || price < 0) {
      bad(400, 'Invalid product price.');
    }

    fields.price = price;
  }

  if (body.images !== undefined ||
      body.imageUrl !== undefined) {
    const images = normalizeImages(
      body,
      current?.images || []
    );

    fields.images = images;

    if (images.length) {
      fields.imageUrl = images[0].url;
    } else if (body.imageUrl) {
      fields.imageUrl = String(body.imageUrl);
    }
  }

  return fields;
}

app.get('/api/products', wrap(async (req, res) => {
  const query = {};

  if (req.query.category) {
    query.category = safe(req.query.category, 100);
  }

  const products = await Product.find(query)
    .sort({ createdAt: -1 })
    .lean();

  res.json({
    success: true,
    products
  });
}));

app.get('/api/products/:slugOrId', wrap(async (req, res) => {
  const key = clean(req.params.slugOrId);

  const product = validId(key)
    ? await Product.findById(key).lean()
    : await Product.findOne({ slug: key }).lean();

  if (!product) {
    bad(404, 'Product not found.');
  }

  const similarProducts = await Product.find({
    _id: { $ne: product._id },
    category: product.category
  })
    .sort({ createdAt: -1 })
    .limit(6)
    .lean();

  res.json({
    success: true,
    product,
    similarProducts
  });
}));

app.post(
  '/api/admin/products',
  adminAuth,
  wrap(async (req, res) => {
    const fields = productFields(req.body);

    if (!fields.title || !fields.weight) {
      bad(
        400,
        'Product name and weight are required.'
      );
    }

    const categoryId = req.body.categoryId;
    if (!categoryId || !validId(categoryId)) {
      bad(400, 'Choose a folder under Gold, Polki, Kundan, Diamond or Silver.');
    }

    const root = await getRootCategory(categoryId);
    if (!mainCategoryName(root.name)) {
      bad(409, 'This folder is outside the five main jewellery categories.');
    }

    fields.category = mainCategoryName(root.name);
    fields.categoryId = categoryId;

    if (!fields.imageUrl) {
      bad(400, 'At least one image is required.');
    }

    fields.slug = jewellerySlug(fields.title);

    const product = await Product.create(fields);

    res.status(201).json({
      success: true,
      product
    });
  })
);

app.put(
  '/api/admin/products/:id',
  adminAuth,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) {
      bad(400, 'Invalid product ID.');
    }

    const existing = await Product.findById(
      req.params.id
    );

    if (!existing) {
      bad(404, 'Product not found.');
    }

    const fields = productFields(
      req.body,
      existing
    );

    if (req.body.categoryId !== undefined) {
      const categoryId = req.body.categoryId;

      if (!categoryId || !validId(categoryId)) {
        bad(400, 'Choose a valid jewellery folder.');
      }

      const root = await getRootCategory(categoryId);
      if (!mainCategoryName(root.name)) {
        bad(409, 'Selected folder is outside the five main jewellery categories.');
      }

      fields.categoryId = categoryId;
      fields.category = mainCategoryName(root.name);
    } else if (existing.categoryId) {
      // A caller cannot spoof a different metal by changing only category text.
      const root = await getRootCategory(existing.categoryId);
      fields.category = mainCategoryName(root.name) || root.name;
    }

    Object.assign(existing, fields);

    if (
      !existing.title ||
      !existing.category ||
      !existing.weight ||
      !existing.imageUrl
    ) {
      bad(
        400,
        'Name, category, weight and image are required.'
      );
    }

    await existing.save();

    res.json({
      success: true,
      product: existing
    });
  })
);

app.delete(
  '/api/admin/products/:id',
  adminAuth,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) {
      bad(400, 'Invalid product ID.');
    }

    const product = await Product.findByIdAndDelete(
      req.params.id
    );

    if (!product) {
      bad(404, 'Product not found.');
    }

    res.json({
      success: true,
      message: 'Product deleted.'
    });
  })
);

app.get('/api/categories', wrap(async (_req, res) => {
  const categories = await Category.find()
    .populate('parentCategory')
    .sort({ createdAt: -1 })
    .lean();

  res.json({
    success: true,
    categories
  });
}));

app.post(
  '/api/admin/categories',
  adminAuth,
  wrap(async (req, res) => {
    const name = safe(req.body.name, 100);

    if (!name) {
      bad(400, 'Category name is required.');
    }

    const parentId =
      req.body.parentCategory || null;

    if (parentId) {
      if (!validId(parentId)) bad(400, 'Invalid parent category.');
      const root = await getRootCategory(parentId);
      if (!mainCategoryName(root.name)) {
        bad(409, 'Subfolders must belong to one of the five main categories.');
      }
    } else if (!mainCategoryName(name)) {
      bad(400, 'Only Gold, Polki, Kundan, Diamond and Silver may be main categories.');
    }

    const normalizedName = parentId ? name : mainCategoryName(name);
    if (await siblingCategoryExists(normalizedName, parentId)) {
      bad(409, 'A folder with this name already exists under the selected parent.');
    }

    const category = await Category.create({
      name: normalizedName,
      description: safe(
        req.body.description,
        400
      ),
      parentCategory: parentId
    });

    res.status(201).json({
      success: true,
      category
    });
  })
);

app.put(
  '/api/admin/categories/:id',
  adminAuth,
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!validId(id)) bad(400, 'Invalid category ID.');

    const category = await Category.findById(id);
    if (!category) bad(404, 'Category not found.');
    if (isProtectedRoot(category)) {
      bad(403, 'The five permanent main categories cannot be edited or moved.');
    }

    const oldRoot = await getRootCategory(id);
    const name = req.body.name !== undefined
      ? safe(req.body.name, 100)
      : category.name;
    if (!name) bad(400, 'Category name cannot be empty.');

    const parentId = req.body.parentCategory !== undefined
      ? (req.body.parentCategory || null)
      : (category.parentCategory || null);

    if (parentId) {
      if (!validId(parentId)) bad(400, 'Invalid parent category.');
      const descendants = await categoryTreeIds(id);
      if (descendants.includes(String(parentId))) {
        bad(409, 'Cannot move a folder inside itself or its subfolder.');
      }
      const destinationRoot = await getRootCategory(parentId);
      const destinationType = mainCategoryName(destinationRoot.name);
      if (!destinationType) {
        bad(409, 'Destination must belong to a main jewellery category.');
      }
      if (!canMoveBetweenRoots(oldRoot.name, destinationRoot.name)) {
        bad(409, 'Cannot move folders between Gold, Polki, Kundan, Diamond and Silver.');
      }
    } else {
      // Existing legacy root folders can be migrated under a main root,
      // but cannot be converted into a sixth main category.
      bad(400, 'Choose a parent under one of the five main categories.');
    }

    if (await siblingCategoryExists(name, parentId, id)) {
      bad(409, 'A folder with this name already exists under the selected parent.');
    }

    category.name = name;
    category.parentCategory = parentId;
    if (req.body.description !== undefined) {
      category.description = safe(req.body.description, 400);
    }
    await category.save();

    const root = await getRootCategory(id);
    const affectedIds = await categoryTreeIds(id);
    await Product.updateMany(
      { categoryId: { $in: affectedIds } },
      { $set: { category: mainCategoryName(root.name) || root.name } }
    );

    res.json({ success: true, category, affectedFolders: affectedIds.length });
  })
);

// Atomic safe deletion: move direct products and subfolders, then delete.
// MongoDB Atlas transactions keep all changes together on success/failure.
app.post(
  '/api/admin/categories/:id/move-and-delete',
  adminAuth,
  wrap(async (req, res) => {
    const id = req.params.id;
    const destinationId = clean(req.body?.destinationId);
    if (!validId(id) || (destinationId && !validId(destinationId))) {
      bad(400, 'Invalid source or destination folder ID.');
    }

    const session = await mongoose.startSession();
    let movedProducts = 0;
    let movedFolders = 0;

    try {
      await session.withTransaction(async () => {
        const target = await Category.findById(id).session(session);
        if (!target) bad(404, 'Folder not found.');
        if (isProtectedRoot(target)) {
          bad(403, 'The five permanent main categories cannot be deleted.');
        }

        const directProducts = await Product.find({ categoryId: id })
          .select('_id').session(session).lean();
        const directChildren = await Category.find({ parentCategory: id })
          .select('_id name').session(session).lean();
        const hasContents = directProducts.length || directChildren.length;
        if (hasContents && !destinationId) {
          bad(409, 'Choose a destination to move products and subfolders before deletion.');
        }

        if (destinationId) {
          const descendants = await categoryTreeIds(id, session);
          if (descendants.includes(destinationId)) {
            bad(409, 'Destination cannot be the folder itself or its subfolder.');
          }
          const destination = await Category.findById(destinationId)
            .session(session).lean();
          if (!destination) bad(404, 'Destination folder not found.');

          const oldRoot = await getRootCategory(id, session);
          const destinationRoot = await getRootCategory(destinationId, session);
          const newType = mainCategoryName(destinationRoot.name);
          if (!newType) bad(409, 'Destination must be under a main jewellery category.');
          if (!canMoveBetweenRoots(oldRoot.name, destinationRoot.name)) {
            bad(409, 'Cannot move products between different main jewellery types.');
          }

          const existingChildren = await Category.find({ parentCategory: destinationId })
            .select('name').session(session).lean();
          const usedNames = new Set(existingChildren.map(item =>
            clean(item.name).toLowerCase()
          ));
          for (const child of directChildren) {
            const key = clean(child.name).toLowerCase();
            if (usedNames.has(key)) {
              bad(409, `Destination already has a subfolder named ${safe(child.name, 100)}.`);
            }
            usedNames.add(key);
          }

          if (directChildren.length) {
            await Category.updateMany(
              { parentCategory: id },
              { $set: { parentCategory: destination._id } },
              { session }
            );
          }
          if (directProducts.length) {
            await Product.updateMany(
              { categoryId: id },
              { $set: { categoryId: destination._id, category: newType } },
              { session }
            );
          }
          // When moving a legacy root, its descendant products need the new root.
          if (oldRoot.name !== destinationRoot.name && descendants.length > 1) {
            await Product.updateMany(
              { categoryId: { $in: descendants.filter(item => item !== id) } },
              { $set: { category: newType } },
              { session }
            );
          }
        }

        const result = await Category.deleteOne({ _id: id }, { session });
        if (result.deletedCount !== 1) bad(409, 'Folder changed. Refresh and retry.');
        movedProducts = directProducts.length;
        movedFolders = directChildren.length;
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success: true,
      message: 'Folder deleted. Products and subfolders were preserved.',
      movedProducts,
      movedFolders
    });
  })
);

// The simple DELETE endpoint only deletes an empty subfolder.
app.delete(
  '/api/admin/categories/:id',
  adminAuth,
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!validId(id)) bad(400, 'Invalid category ID.');
    const target = await Category.findById(id);
    if (!target) bad(404, 'Category not found.');
    if (isProtectedRoot(target)) {
      bad(403, 'The five permanent main categories cannot be deleted.');
    }
    if (await Product.exists({ categoryId: id })) {
      bad(409, 'Move products out of this folder first.');
    }
    if (await Category.exists({ parentCategory: id })) {
      bad(409, 'Move or delete subfolders first.');
    }
    await Category.deleteOne({ _id: id });
    res.json({ success: true, message: 'Empty folder deleted.' });
  })
);

// CUSTOMER REGISTRATION
async function createCustomer({
  name, dob = '', phone, email, address = '', password,
  schemeJoined = false, customInstallment = 10000,
  schemeConsentConfirmed = false
}) {
  const joinedDate = istDate();
  return User.create({
    customerId: `RJ${randomInt(100000000, 1000000000)}`,
    name, dob, phone, email, address,
    password: await hashPassword(password),
    schemeJoined,
    schemeJoinedAt: schemeJoined ? new Date() : undefined,
    customInstallment,
    startDate: schemeJoined ? joinedDate : '',
    schemeStatus: schemeJoined ? 'Active' : 'NotJoined',
    schemeFirstDueMonth: schemeJoined ? joinedDate.slice(0, 7) : '',
    schemeAnchorDay: schemeJoined
      ? Number(joinedDate.slice(8, 10)) : 0,
    schemeScheduleVersion: scheme.OPTION_A_SCHEDULE_VERSION,
    schemeTermsAcceptedAt:
      schemeJoined && schemeConsentConfirmed ? new Date() : undefined,
    schemeTermsVersion:
      schemeJoined && schemeConsentConfirmed
        ? 'join-day-first-installment-option-a-v3' : '',
    schemeCycle: 1,
    paidMonths: 0,
    installmentState: scheme.states({
      paidMonths: 0, customInstallment
    }),
    isLaborFree: false,
    isActive: true
  });
}

app.post('/api/customer/register', loginLimiter, wrap(async (req, res) => {
  const name = safe(req.body.name, 100);
  const dob = clean(req.body.dob);
  const phone = clean(req.body.phone);
  const email = normalizeEmail(req.body.email);
  const address = safe(req.body.address, 500);
  const password = String(req.body.password ?? '');
  if (!name || !validPhone(phone) || !validDate(dob) || !validEmail(email))
    bad(400, 'Valid name, email, date of birth (YYYY-MM-DD) and Indian mobile are required.');
  if (password.length < 8 || password.length > 128)
    bad(400, 'Password must have 8–128 characters.');
  if (req.body.confirmPassword !== undefined &&
      req.body.confirmPassword !== password)
    bad(400, 'Passwords do not match.');
  if (await User.exists({ phone }))
    bad(409, 'Mobile number already registered.');
  const customer = await createCustomer({
    name, dob, phone, email, address, password
  });
  res.status(201).json({
    success: true,
    customer: publicCustomer(customer),
    token: customerToken(customer)
  });
}));

app.post('/api/customer/login', loginLimiter, wrap(async (req, res) => {
  const identifier = clean(req.body.identifier);
  const password = String(req.body.password ?? '');
  if (!identifier || !password)
    bad(400, 'Customer ID/mobile and password required.');
  const customer = await User.findOne({
    $or: [
      {
        customerId: {
          $regex: `^${escapeRegex(identifier)}$`,
          $options: 'i'
        }
      },
      { phone: identifier }
    ]
  }).select('+password');
  if (!customer || !await verifyPassword(password, customer.password))
    bad(401, 'Incorrect login details.');
  if (customer.isActive === false)
    bad(403, 'Account deactivated. Contact Rahul Jewellers SHEOGANJ.');
  if (!customer.password.startsWith('scrypt$')) {
    customer.password = await hashPassword(password);
    await customer.save();
  }
  const current = await ensureSchemeFresh(customer);
  res.json({
    success: true,
    customer: publicCustomer(current),
    token: customerToken(current)
  });
}));

app.get('/api/customer/profile/:id', customerAuth, wrap(async (req, res) => {
  if (String(req.customer._id) !== req.params.id)
    bad(403, 'Access denied to this profile.');
  res.json({
    success: true,
    customer: publicCustomer(req.customer)
  });
}));

async function updateCustomerProfile(req, res) {
  const c = req.customer;
  const id = req.params.id || req.body.userId;
  if (id && String(id) !== String(c._id))
    bad(403, 'You can only edit your account.');

  if (req.body.name !== undefined) {
    const name = safe(req.body.name, 100);
    if (!name) bad(400, 'Name cannot be empty.');
    c.name = name;
  }
  if (req.body.address !== undefined)
    c.address = safe(req.body.address, 500);
  if (req.body.email !== undefined) {
    const email = normalizeEmail(req.body.email);
    if (!validEmail(email))
      bad(400, 'Enter a valid email address.');
    c.email = email;
  }
  if (req.body.dob !== undefined) {
    const dob = clean(req.body.dob);
    if (dob && !validDate(dob))
      bad(400, 'Invalid date of birth.');
    c.dob = dob;
  }
  if (req.body.phone !== undefined &&
      clean(req.body.phone) !== c.phone) {
    const phone = clean(req.body.phone);
    if (!validPhone(phone))
      bad(400, 'Invalid Indian mobile.');
    if (await User.exists({
      phone, _id: { $ne: c._id }
    })) bad(409, 'Mobile already registered.');
    c.phone = phone;
  }
  if (req.body.password) {
    const newPassword = String(req.body.password);
    const currentPassword = String(req.body.currentPassword || '');
    if (newPassword.length < 8 || newPassword.length > 128)
      bad(400, 'New password must have 8–128 characters.');
    if (!currentPassword)
      bad(400, 'Current password required to change password.');
    const existing = await User.findById(c._id).select('+password');
    if (!existing ||
        !await verifyPassword(currentPassword, existing.password))
      bad(401, 'Current password incorrect.');
    c.password = await hashPassword(newPassword);
    c.tokenVersion = Number(c.tokenVersion || 0) + 1;
  }
  await c.save();
  const customer = publicCustomer(c);
  res.json({
    success: true, customer, user: customer,
    token: customerToken(c)
  });
}
app.put('/api/customer/update-profile/:id', customerAuth,
  wrap(updateCustomerProfile));
app.put('/api/customer/settings/update', customerAuth,
  wrap(updateCustomerProfile));

app.post('/api/customer/wishlist/toggle', customerAuth, wrap(async (req, res) => {
  if (req.body.userId &&
      String(req.body.userId) !== String(req.customer._id))
    bad(403, 'Access denied.');
  const productId = req.body.productId;
  if (!validId(productId) ||
      !await Product.exists({ _id: productId }))
    bad(404, 'Product not found.');
  if (req.customer.wishlist.some(id =>
    String(id) === String(productId)))
    req.customer.wishlist.pull(productId);
  else req.customer.wishlist.addToSet(productId);
  await req.customer.save();
  const customer = publicCustomer(req.customer);
  res.json({
    success: true, customer, user: customer
  });
}));

// GOLD-ONLY 12+1 SCHEME
app.post('/api/customer/join-scheme', customerAuth, wrap(async (req, res) => {
  const amount = Number(
    req.body.amount ?? req.body.customInstallment
  );
  if (!validAmount(amount))
    bad(400, 'Monthly amount must be ₹5,000 to ₹10,00,000.');
  if (!validEmail(normalizeEmail(req.customer.email)))
    bad(400, 'Add a valid email to your profile before joining.');
  if (req.body.termsAccepted !== true)
    bad(400, 'Please accept the 5-day deadline, cancellation and refund review terms.');
  if (
    req.customer.schemeJoined ||
    req.customer.schemeStatus === 'RefundPending' ||
    ['Cancelled', 'Suspended'].includes(req.customer.schemeStatus)
  ) bad(409, 'Existing scheme must be reviewed and refunded before starting a new one.');

  const nextCycle = schemeCycle(req.customer) +
    (req.customer.schemeStatus === 'Refunded' ? 1 : 0);
  const joinedDate = istDate();

  const updated = await User.findOneAndUpdate(
    {
      _id: req.customer._id,
      schemeJoined: { $ne: true },
      paidMonths: 0,
      schemeStatus: req.customer.schemeStatus || 'NotJoined'
    },
    {
      $set: {
        schemeJoined: true,
        schemeJoinedAt: new Date(),
        schemeStatus: 'Active',
        schemeCycle: nextCycle,
        schemeFirstDueMonth: joinedDate.slice(0, 7),
        schemeAnchorDay: Number(joinedDate.slice(8, 10)),
        schemeScheduleVersion: scheme.OPTION_A_SCHEDULE_VERSION,
        schemeTermsAcceptedAt: new Date(),
        schemeTermsVersion: 'join-day-first-installment-option-a-v3',
        schemeSuspendedAt: null,
        schemeSuspendedDueMonth: '',
        schemeSuspendedDueDate: '',
        schemeCustomerReason: '',
        schemeAdminDecision: '',
        schemeRefundAmount: 0,
        schemeRefundReference: '',
        schemeRefundedAt: null,
        installmentState: scheme.states({
          paidMonths: 0, customInstallment: amount
        }),
        paidMonths: 0,
        schemeCatchupUntil: '',
        schemeCatchupMonthNums: [],
        schemeManualOverdueMonths: [],
        reactivationRequest: null,
        customInstallment: amount,
        startDate: joinedDate,
        isLaborFree: false
      }
    },
    { new: true }
  );

  if (!updated)
    bad(409, 'Scheme state changed. Refresh and try again.');
  res.json({
    success: true,
    customer: publicCustomer(updated),
    message: 'Gold Scheme joined.'
  });
}));

// ONE PAYMENT FOR ANY 1–12 UNPAID INSTALLMENTS
app.post('/api/customer/pay-installment', customerAuth, wrap(async (req, res) => {
  if (req.body.userId &&
      String(req.body.userId) !== String(req.customer._id))
    bad(403, 'Not your scheme.');

  const nums = Array.isArray(req.body.monthNums)
    ? req.body.monthNums.map(Number)
    : [Number(req.body.monthNum)];

  if (
    !nums.length || nums.length > 12 ||
    nums.some(n => !Number.isInteger(n) || n < 1 || n > 12) ||
    new Set(nums).size !== nums.length
  ) bad(400, 'Select 1–12 different unpaid installments.');

  nums.sort((a, b) => a - b);
  const utr = clean(
    req.body.transactionId ?? req.body.utr
  ).toUpperCase();

  if (!/^[A-Z0-9]{10,20}$/.test(utr))
    bad(400, 'Enter a valid UTR (10–20 letters/digits).');

  const session = await mongoose.startSession();
  let request, updated;
  try {
    await session.withTransaction(async () => {
      const c = await User.findById(req.customer._id).session(session);
      if (!c || !c.schemeJoined ||
          c.schemeStatus !== 'Active' ||
          c.isActive === false)
        bad(409, 'Scheme cancelled/inactive. Request reactivation from the store.');

      const rows = scheme.installmentRows(c);
      for (const num of nums) {
        const row = rows[num - 1];
        if (row.paid)
          bad(409, `Installment ${num} is already PAID.`);
        if (!row.payableNow)
          bad(409, `Installment ${num} is overdue. Request reactivation.`);
      }

      if (Number(req.body.amount) !==
          Number(c.customInstallment) * nums.length)
        bad(400, 'Combined amount must equal monthly installment × selected months.');

      if (
        await PaymentRequest.exists({
          transactionId: utr
        }).session(session) ||
        await User.exists({
          'paymentHistory.transactionId': utr
        }).session(session) ||
        await AdminAudit.exists({
          action: 'CUSTOMER_DELETE',
          'details.paymentRequests.transactionId': utr
        }).session(session)
      ) bad(409, 'UTR already used. Do not pay again.');

      if (await PaymentRequest.exists({
        customer: c._id,
        schemeCycle: cycleFilter(schemeCycle(c)),
        status: { $in: ['Pending', 'Approved'] },
        ...pendingMonthsQuery(nums)
      }).session(session))
        bad(409, 'One of the selected months already has a pending/approved UPI receipt.');

      c.paymentRevision = Number(c.paymentRevision || 0) + 1;
      await c.save({ session });

      [request] = await PaymentRequest.create([{
        customer: c._id,
        customerId: c.customerId,
        schemeCycle: schemeCycle(c),
        monthNum: nums[0],
        monthNums: nums,
        amount: Number(c.customInstallment) * nums.length,
        transactionId: utr,
        status: 'Pending'
      }], { session });
      updated = c;
    });
  } finally {
    await session.endSession();
  }

  res.status(201).json({
    success: true,
    verified: false,
    status: 'Pending',
    message: `Combined UPI request for ${nums.length} installments submitted. Await admin verification.`,
    paymentRequest: request,
    request,
    customer: publicCustomer(updated)
  });
}));

app.get('/api/customer/payment-requests', customerAuth, wrap(async (req, res) => {
  const requests = await PaymentRequest.find({
    customer: req.customer._id,
    schemeCycle: cycleFilter(schemeCycle(req.customer))
  }).sort({ createdAt: -1 }).lean();
  res.json({
    success: true, requests, paymentRequests: requests
  });
}));

// ADMIN CUSTOMER DIRECTORY
app.get('/api/admin/customers', adminAuth, wrap(async (_req, res) => {
  await sweepOverdueSchemes();
  const customers = (
    await User.find().select('-password')
      .sort({ createdAt: -1 }).lean()
  ).map(publicCustomer);
  res.json({
    success: true, customers, users: customers
  });
}));

app.post('/api/admin/create-customer', adminAuth, wrap(async (req, res) => {
  const name = safe(req.body.name, 100);
  const phone = clean(req.body.phone);
  const email = normalizeEmail(req.body.email);
  const dob = clean(req.body.dob);
  const address = safe(req.body.address, 500);
  const password = String(req.body.password ?? '');

  if (!name || !validPhone(phone) || !validEmail(email))
    bad(400, 'Valid name, email and Indian mobile required.');
  if (dob && !validDate(dob))
    bad(400, 'Invalid date of birth.');
  if (password.length < 8 || password.length > 128)
    bad(400, 'Password must have 8–128 characters.');
  if (await User.exists({ phone }))
    bad(409, 'Mobile already registered.');

  const join = req.body.schemeJoined === true ||
    (req.body.schemeJoined !== false &&
      req.body.customInstallment != null &&
      Boolean(req.body.startDate));

  const amount = Number(
    req.body.customInstallment ?? 10000
  );
  if (join && !validAmount(amount))
    bad(400, 'Invalid monthly installment.');
  if (join && req.body.schemeConsentConfirmed !== true)
    bad(400, 'Record the customer acceptance of the 5-day cancellation/refund terms.');

  const customer = await createCustomer({
    name, phone, email, dob, address, password,
    schemeJoined: join,
    customInstallment: join ? amount : 10000,
    schemeConsentConfirmed:
      join && req.body.schemeConsentConfirmed === true
  });

  res.status(201).json({
    success: true, customer: publicCustomer(customer)
  });
}));

app.put('/api/admin/customers/:id/email', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id))
    bad(400, 'Invalid customer ID.');
  const email = normalizeEmail(req.body.email);
  if (!validEmail(email))
    bad(400, 'Enter a valid customer email address.');
  const customer = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { email } },
    { new: true }
  );
  if (!customer) bad(404, 'Customer not found.');
  await AdminAudit.create({
    action: 'CUSTOMER_EMAIL_UPDATED',
    customerRef: customer._id,
    customerId: customer.customerId,
    reason: 'Admin updated customer contact email'
  });
  res.json({
    success: true, customer: publicCustomer(customer)
  });
}));

app.post('/api/admin/customers/:id/reset-password', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id))
    bad(400, 'Invalid customer ID.');
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  const temporaryPassword = Array.from(
    randomBytes(18),
    n => alphabet[n % alphabet.length]
  ).join('');

  const customer = await User.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        password: await hashPassword(temporaryPassword)
      },
      $inc: { tokenVersion: 1 }
    },
    { new: true }
  );
  if (!customer) bad(404, 'Customer not found.');
  await AdminAudit.create({
    action: 'CUSTOMER_PASSWORD_RESET',
    customerRef: customer._id,
    customerId: customer.customerId,
    reason: 'Admin reset customer login password'
  });
  res.json({
    success: true,
    temporaryPassword,
    customerId: customer.customerId,
    message: 'Password reset. Old customer sessions are invalid.'
  });
}));

app.put('/api/admin/customer-status/:id', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id) ||
      typeof req.body.isActive !== 'boolean')
    bad(400, 'Valid ID and isActive boolean required.');
  const customer = await User.findByIdAndUpdate(
    req.params.id,
    { isActive: req.body.isActive },
    { new: true }
  );
  if (!customer) bad(404, 'Customer not found.');
  res.json({
    success: true, customer: publicCustomer(customer)
  });
}));

app.delete('/api/admin/delete-customer/:id', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id))
    bad(400, 'Invalid customer ID.');

  const confirmation = clean(req.body?.confirmCustomerId);
  const reason = safe(req.body?.reason, 300);

  if (
    req.body?.confirmDelete !== true ||
    !confirmation || reason.length < 5
  ) bad(400, 'Confirm the exact Customer ID and enter a deletion reason (at least 5 characters).');

  const session = await mongoose.startSession();
  let deletedCustomerId = '';
  let removedRequests = 0;

  try {
    await session.withTransaction(async () => {
      const customer = await User.findById(
        req.params.id
      ).session(session);
      if (!customer)
        bad(404, 'Customer not found. Refresh the directory.');
      if (confirmation !== customer.customerId)
        bad(400, 'Customer ID confirmation does not match. Nothing was deleted.');

      const requests = await PaymentRequest.find({
        customer: customer._id
      }).session(session).lean();

      deletedCustomerId = customer.customerId;

      const financialSnapshot = {
        schemeJoined: customer.schemeJoined,
        customInstallment: customer.customInstallment,
        paidMonths: customer.paidMonths,
        paymentHistory: customer.paymentHistory.map(p => ({
          monthNum: p.monthNum,
          amount: p.amount,
          transactionId: p.transactionId,
          paidAt: p.paidAt,
          verifiedAt: p.verifiedAt,
          method: p.method
        })),
        paymentRequests: requests.map(p => ({
          monthNum: p.monthNum,
          monthNums: requestMonths(p),
          appliedMonthNums: p.appliedMonthNums || [],
          amount: p.amount,
          transactionId: p.transactionId,
          status: p.status,
          passbookApplied: p.passbookApplied,
          reviewedAt: p.reviewedAt,
          passbookAdjustments: p.passbookAdjustments
        }))
      };

      await AdminAudit.create([{
        action: 'CUSTOMER_DELETE',
        customerRef: customer._id,
        customerId: customer.customerId,
        reason,
        details: financialSnapshot
      }], { session });

      const requestsResult = await PaymentRequest.deleteMany({
        customer: customer._id
      }).session(session);
      removedRequests = requestsResult.deletedCount || 0;

      const customerResult = await User.deleteOne({
        _id: customer._id
      }).session(session);
      if (customerResult.deletedCount !== 1)
        bad(409, 'Customer changed during deletion. Retry.');
    });
  } finally {
    await session.endSession();
  }

  res.json({
    success: true,
    deletedCustomerId,
    removedRequests,
    message: 'Customer and linked payment requests deleted. Financial audit retained; no bank refund was made.'
  });
}));

// SINGLE INSTALLMENT PAID / UNPAID
app.post('/api/admin/manual-passbook-update', adminAuth, wrap(async (req, res) => {
  const userId = req.body.userId;
  const num = Number(req.body.monthNum);
  const action = clean(req.body.action).toUpperCase();
  const reason = safe(req.body.reason, 300);

  if (!validId(userId) ||
      !Number.isInteger(num) || num < 1 || num > 12 ||
      !['PAY', 'UNPAY'].includes(action))
    bad(400, 'Invalid installment or action.');
  if (reason.length < 5)
    bad(400, 'Enter a reason of at least 5 characters.');

  const session = await mongoose.startSession();
  let updated, source = 'ADMIN_MANUAL';

  try {
    await session.withTransaction(async () => {
      const c = await User.findById(userId).session(session);
      if (!c || !c.schemeJoined ||
          ['RefundPending', 'Refunded'].includes(c.schemeStatus))
        bad(409, 'Cannot edit an unjoined or refund-in-progress scheme.');

      const states = currentStates(c);
      const row = states[num - 1];

      if (row.paid === (action === 'PAY'))
        bad(409, `Month ${num} is already ${row.paid ? 'PAID' : 'UNPAID'}.`);

      if (await PaymentRequest.exists({
        customer: c._id,
        schemeCycle: cycleFilter(schemeCycle(c)),
        status: 'Pending',
        ...pendingMonthsQuery([num])
      }).session(session))
        bad(409, 'Resolve pending UPI request covering this month before correction.');

      const approved = await PaymentRequest.findOne({
        customer: c._id,
        schemeCycle: cycleFilter(schemeCycle(c)),
        status: 'Approved',
        ...pendingMonthsQuery([num])
      }).session(session);

      const now = new Date();

      if (action === 'UNPAY') {
        row.paid = false;
        if (approved) {
          const applied = (
            approved.appliedMonthNums?.length
              ? approved.appliedMonthNums
              : approved.passbookApplied === false
                ? []
                : requestMonths(approved)
          ).filter(x => x !== num);

          approved.appliedMonthNums = applied;
          approved.passbookApplied = applied.length > 0;
          approved.passbookAdjustments.push({
            action: 'UNPAY',
            at: now,
            by: ADMIN_EMAIL,
            reason
          });
          await approved.save({ session });
          source = 'UPI_ADJUSTED';
        }
      } else {
        const old = sameCycleHistory(c)
          .find(p => Number(p.monthNum) === num);

        if (approved) {
          if (Number(approved.amount) !==
              Number(c.customInstallment) * requestMonths(approved).length)
            bad(409, 'UPI amount does not match the scheme. Check records.');

          const applied = new Set(
            approved.appliedMonthNums?.length
              ? approved.appliedMonthNums
              : approved.passbookApplied === false
                ? []
                : requestMonths(approved)
          );
          applied.add(num);
          approved.appliedMonthNums = [...applied].sort((a, b) => a - b);
          approved.passbookApplied = true;
          approved.passbookAdjustments.push({
            action: 'PAY', at: now, by: ADMIN_EMAIL, reason
          });
          await approved.save({ session });

          row.transactionId = approved.transactionId;
          row.method = 'UPI';
          row.paidAt = approved.reviewedAt || now;
          source = 'UPI_REAPPLIED';
        } else if (old) {
          row.transactionId = old.transactionId;
          row.method = old.method;
          row.paidAt = old.verifiedAt || old.paidAt;
          source = 'HISTORY_REAPPLIED';
        } else {
          row.transactionId =
            `ADMIN_MANUAL_${Date.now()}_${randomInt(100000, 999999)}`;
          row.method = 'AdminManual';
          row.paidAt = now;
          c.paymentHistory.push({
            monthNum: num,
            amount: c.customInstallment,
            transactionId: row.transactionId,
            paidAt: now,
            verifiedAt: now,
            method: 'AdminManual',
            schemeCycle: schemeCycle(c)
          });
          source = 'ADMIN_MANUAL';
        }
        row.paid = true;
        row.amount = c.customInstallment;
      }

      writeStates(c, states);
      await c.save({ session });
      updated = c;

      await AdminAudit.create([{
        action: `PASSBOOK_${action}`,
        customerRef: c._id,
        customerId: c.customerId,
        monthNum: num,
        reason,
        details: {
          source,
          transactionId: row.transactionId,
          cycle: schemeCycle(c),
          paidMonths: c.paidMonths,
          schemeStatus: c.schemeStatus
        }
      }], { session });
    });
  } finally {
    await session.endSession();
  }

  updated = await ensureSchemeFresh(updated);

  await reconcileBenefitClaims(
    updated,
    'Passbook changed; benefit eligibility rechecked'
  );
  res.json({
    success: true,
    customer: publicCustomer(updated),
    source,
    message: `Month ${num} marked ${action === 'PAY' ? 'PAID' : 'UNPAID'}; original receipts and audit retained.`
  });
}));

// NEW: ALL 12 INSTALLMENTS PAID / UNPAID AT ONCE
app.post('/api/admin/manual-passbook-bulk', adminAuth, wrap(async (req, res) => {
  const userId = req.body.userId;
  const action = clean(req.body.action).toUpperCase();
  const reason = safe(req.body.reason, 300);
  const confirmation = clean(req.body.confirmation);
  const expected = action === 'PAY'
    ? 'MARK_ALL_PAID' : 'MARK_ALL_UNPAID';

  if (!validId(userId))
    bad(400, 'Invalid customer ID.');
  if (!['PAY', 'UNPAY'].includes(action))
    bad(400, 'Invalid bulk action.');
  if (reason.length < 5)
    bad(400, 'Enter a reason of at least 5 characters.');
  if (confirmation !== expected)
    bad(400, 'Bulk confirmation is incorrect.');

  const session = await mongoose.startSession();
  let updated;
  let changedMonths = [];
  let previousPaidCount = 0;

  try {
    await session.withTransaction(async () => {
      const c = await User.findById(userId).session(session);

      if (!c || !c.schemeJoined)
        bad(409, 'Customer has not joined the scheme.');
      if (c.isActive === false)
        bad(409, 'Customer account is inactive.');
      if (['RefundPending', 'Refunded'].includes(c.schemeStatus))
        bad(409, 'Cannot edit a scheme during or after refund.');

      const states = currentStates(c);
      const makePaid = action === 'PAY';
      previousPaidCount = states.filter(x => x.paid).length;

      changedMonths = states
        .filter(x => x.paid !== makePaid)
        .map(x => Number(x.monthNum));

      if (!changedMonths.length)
        bad(409, makePaid
          ? 'All 12 installments are already PAID.'
          : 'All 12 installments are already UNPAID.');

      const pending = await PaymentRequest.exists({
        customer: c._id,
        schemeCycle: cycleFilter(schemeCycle(c)),
        status: 'Pending',
        ...pendingMonthsQuery(changedMonths)
      }).session(session);

      if (pending)
        bad(409, 'Resolve pending UPI requests before bulk correction.');

      const approvedRequests = await PaymentRequest.find({
        customer: c._id,
        schemeCycle: cycleFilter(schemeCycle(c)),
        status: 'Approved',
        ...pendingMonthsQuery(changedMonths)
      }).session(session);

      const history = sameCycleHistory(c);
      const changedRequests = new Map();
      const now = new Date();

      function appliedMonths(request) {
        if (request.appliedMonthNums?.length)
          return new Set(request.appliedMonthNums.map(Number));
        if (request.passbookApplied === false)
          return new Set();
        return new Set(requestMonths(request));
      }

      for (const monthNum of changedMonths) {
        const row = states[monthNum - 1];
        const approved = approvedRequests.find(
          request => requestMonths(request).includes(monthNum)
        );

        if (!makePaid) {
          row.paid = false;
          if (approved) {
            const applied = appliedMonths(approved);
            applied.delete(monthNum);
            approved.appliedMonthNums =
              [...applied].sort((a, b) => a - b);
            approved.passbookApplied =
              approved.appliedMonthNums.length > 0;
            approved.passbookAdjustments.push({
              action: 'UNPAY',
              at: now, by: ADMIN_EMAIL, reason
            });
            changedRequests.set(String(approved._id), approved);
          }
          continue;
        }

        if (approved) {
          if (Number(approved.amount) !==
              Number(c.customInstallment) * requestMonths(approved).length)
            bad(409, `UPI amount mismatch for installment ${monthNum}.`);

          const applied = appliedMonths(approved);
          applied.add(monthNum);
          approved.appliedMonthNums =
            [...applied].sort((a, b) => a - b);
          approved.passbookApplied = true;
          approved.passbookAdjustments.push({
            action: 'PAY',
            at: now, by: ADMIN_EMAIL, reason
          });
          changedRequests.set(String(approved._id), approved);

          row.transactionId = approved.transactionId;
          row.method = 'UPI';
          row.paidAt = approved.reviewedAt || now;
        } else {
          const old = history.find(
            payment => Number(payment.monthNum) === monthNum
          );

          if (old) {
            row.transactionId = old.transactionId;
            row.method = old.method || 'AdminManual';
            row.paidAt = old.verifiedAt || old.paidAt || now;
          } else {
            const transactionId =
              `ADMIN_BULK_${Date.now()}_${monthNum}_${randomBytes(4).toString('hex')}`;
            row.transactionId = transactionId;
            row.method = 'AdminManual';
            row.paidAt = now;

            c.paymentHistory.push({
              monthNum,
              amount: Number(c.customInstallment),
              transactionId,
              paidAt: now,
              verifiedAt: now,
              method: 'AdminManual',
              schemeCycle: schemeCycle(c)
            });
          }
        }

        row.paid = true;
        row.amount = Number(c.customInstallment);
      }

      for (const request of changedRequests.values())
        await request.save({ session });

      writeStates(c, states);
      await c.save({ session });
      updated = c;

      await AdminAudit.create([{
        action: `PASSBOOK_BULK_${action}`,
        customerRef: c._id,
        customerId: c.customerId,
        reason,
        details: {
          cycle: schemeCycle(c),
          changedMonths,
          previousPaidCount,
          newPaidCount: c.paidMonths,
          originalStartDate: c.startDate,
          originalBenefitDate: scheme.schemeBenefitDate(c),
          actor: ADMIN_EMAIL,
          originalTransactionsPreserved: true
        }
      }], { session });
    });
  } finally {
    await session.endSession();
  }

  updated = await ensureSchemeFresh(updated);

  await reconcileBenefitClaims(
    updated,
    'Passbook changed; benefit eligibility rechecked'
  );

  res.json({
    success: true,
    customer: publicCustomer(updated),
    changedMonths,
    previousPaidCount,
    paidMonths: countPaid(updated),
    benefitDate: scheme.schemeBenefitDate(updated),
    benefitUnlocked: scheme.eligible(updated),
    message: `${changedMonths.length} installments marked ${action === 'PAY' ? 'PAID' : 'UNPAID'}.`
  });
}));

// ADMIN AUDIT LOG
app.get('/api/admin/audit-log', adminAuth, wrap(async (req, res) => {
  const events = await AdminAudit.find()
    .select('-details')
    .sort({ createdAt: -1 })
    .limit(100).lean();
  res.json({ success: true, events });
}));

// UPI PAYMENT REVIEW
app.get('/api/admin/payment-requests', adminAuth, wrap(async (req, res) => {
  const status = clean(req.query.status);
  if (status && !['Pending', 'Approved', 'Rejected'].includes(status))
    bad(400, 'Invalid status.');
  const requests = await PaymentRequest.find(status ? { status } : {})
    .populate('customer', 'customerId name phone paidMonths customInstallment isActive schemeJoined')
    .sort({ createdAt: -1 }).lean();
  res.json({
    success: true, requests, paymentRequests: requests
  });
}));

app.get('/api/admin/pending-payments', adminAuth, wrap(async (_req, res) => {
  const requests = await PaymentRequest.find({
    status: 'Pending'
  }).populate(
    'customer',
    'customerId name phone paidMonths customInstallment'
  ).sort({ createdAt: -1 }).lean();
  res.json({
    success: true, requests, paymentRequests: requests
  });
}));

async function reviewPayment(req, res, action) {
  const id = req.params.id ||
    req.body.paymentRequestId ||
    req.body.requestId ||
    req.body.id;

  if (!validId(id))
    bad(400, 'Valid payment request ID required.');

  if (action === 'Rejected') {
    const paymentRequest = await PaymentRequest.findOneAndUpdate(
      { _id: id, status: 'Pending' },
      {
        $set: {
          status: 'Rejected',
          rejectionReason: safe(
            req.body.reason || req.body.rejectionReason, 300
          ),
          reviewedAt: new Date(),
          reviewedBy: ADMIN_EMAIL
        }
      },
      { new: true }
    );
    if (!paymentRequest)
      bad(409, 'Request already reviewed.');
    const c = await User.findById(paymentRequest.customer);
    if (c) await ensureSchemeFresh(c);
    return res.json({
      success: true,
      status: 'Rejected',
      paymentRequest
    });
  }

  const session = await mongoose.startSession();
  let paymentRequest, customer;

  try {
    await session.withTransaction(async () => {
      const r = await PaymentRequest.findOne({
        _id: id, status: 'Pending'
      }).session(session);
      if (!r) bad(409, 'Request already reviewed.');

      const c = await User.findById(r.customer).session(session);
      if (!c || !c.schemeJoined ||
          c.schemeStatus !== 'Active' ||
          c.isActive === false ||
          Number(r.schemeCycle || 1) !== schemeCycle(c))
        bad(409, 'Scheme inactive or old cycle.');

      const nums = requestMonths(r);
      const states = currentStates(c);

      if (
        !nums.length ||
        nums.some(n =>
          !Number.isInteger(n) || n < 1 || n > 12 ||
          states[n - 1].paid
        )
      ) bad(409, 'At least one installment is already PAID or invalid.');

      if (Number(r.amount) !==
          Number(c.customInstallment) * nums.length)
        bad(409, 'Combined UPI amount mismatch.');

      const other = await PaymentRequest.exists({
        _id: { $ne: r._id },
        customer: c._id,
        schemeCycle: cycleFilter(schemeCycle(c)),
        status: 'Approved',
        ...pendingMonthsQuery(nums)
      }).session(session);
      if (other)
        bad(409, 'One selected installment already has approved UPI.');

      if (await AdminAudit.exists({
        action: 'CUSTOMER_DELETE',
        'details.paymentRequests.transactionId': r.transactionId
      }).session(session))
        bad(409, 'UTR belongs to an archived deleted customer.');

      const now = new Date();
      for (const n of nums) {
        const row = states[n - 1];
        row.paid = true;
        row.transactionId = r.transactionId;
        row.method = 'UPI';
        row.paidAt = now;
        row.amount = c.customInstallment;
        c.paymentHistory.push({
          monthNum: n,
          amount: c.customInstallment,
          transactionId: r.transactionId,
          paidAt: r.createdAt,
          verifiedAt: now,
          method: 'UPI',
          schemeCycle: schemeCycle(c)
        });
      }

      writeStates(c, states);
      await c.save({ session });
      customer = c;

      r.status = 'Approved';
      r.appliedMonthNums = nums;
      r.passbookApplied = true;
      r.reviewedAt = now;
      r.reviewedBy = ADMIN_EMAIL;
      await r.save({ session });
      paymentRequest = r;

      await AdminAudit.create([{
        action: 'UPI_BATCH_APPROVED',
        customerRef: c._id,
        customerId: c.customerId,
        reason: 'Admin verified bank UTR',
        details: {
          transactionId: r.transactionId,
          monthNums: nums,
          amount: r.amount,
          cycle: schemeCycle(c)
        }
      }], { session });
    });
  } finally {
    await session.endSession();
  }

  res.json({
    success: true,
    verified: true,
    status: 'Approved',
    paymentRequest,
    customer: publicCustomer(customer)
  });
}

for (const method of ['post', 'put']) {
  app[method]('/api/admin/payment-requests/:id/approve',
    adminAuth,
    wrap((req, res) => reviewPayment(req, res, 'Approved')));
  app[method]('/api/admin/payment-requests/:id/reject',
    adminAuth,
    wrap((req, res) => reviewPayment(req, res, 'Rejected')));
}
app.post('/api/admin/approve-payment', adminAuth,
  wrap((req, res) => reviewPayment(req, res, 'Approved')));
app.post('/api/admin/reject-payment', adminAuth,
  wrap((req, res) => reviewPayment(req, res, 'Rejected')));
app.post('/api/admin/verify-payment', adminAuth,
  wrap((req, res) =>
    reviewPayment(
      req, res,
      clean(req.body.action).toLowerCase() === 'reject'
        ? 'Rejected' : 'Approved'
    )));

app.post('/api/customer/redeem-scheme', customerAuth, wrap(async (req, res) => {
  if (req.body.userId &&
      String(req.body.userId) !== String(req.customer._id))
    bad(403, 'Not your scheme.');

  const standardMakingCharges =
    Number(req.body.standardMakingCharges || 0);
  if (!Number.isFinite(standardMakingCharges) ||
      standardMakingCharges < 0)
    bad(400, 'Invalid making charges.');

  const eligible = discountEligible(req.customer);
  const totalAccumulatedSavings =
    countPaid(req.customer) *
    Number(req.customer.customInstallment || 0);

  res.json({
    success: true,
    message: eligible
      ? 'Eligible subject to store verification and scheme terms.'
      : 'Not yet eligible.',
    redemptionDetails: {
      customerId: req.customer.customerId,
      customerName: req.customer.name,
      totalAccumulatedSavings,
      standardMakingCharges,
      makingChargesDiscountPercentage: eligible ? 100 : 0,
      finalMakingChargesToPay: eligible
        ? 0 : standardMakingCharges,
      eligible,
      goldOnly: true,
      previewOnly: true
    }
  });
}));


// GOLD SCHEME BENEFIT CLAIMS

app.get(
  '/api/customer/benefit-claim',
  customerAuth,
  wrap(async (req, res) => {
    const claim = await BenefitClaim.findOne({
      customer: req.customer._id,
      schemeCycle: schemeCycle(req.customer)
    }).lean();

    res.json({
      success: true,
      claim: claim || null,
      canDownloadBenefitCard: scheme.eligible(req.customer) &&
        ['Pending', 'Verified'].includes(claim?.status)
    });
  })
);

app.post(
  '/api/customer/benefit-claim',
  customerAuth,
  wrap(async (req, res) => {
    const customer = req.customer;

    if (!scheme.eligible(customer)) {
      bad(
        409,
        'Benefit is available only after 12 verified installments and the original 13th-month date.'
      );
    }

    let claim = await BenefitClaim.findOne({
      customer: customer._id,
      schemeCycle: schemeCycle(customer)
    });

    if (claim?.status === 'Redeemed') {
      bad(
        409,
        'This scheme benefit has already been redeemed.'
      );
    }

    if (claim?.status === 'Revoked') {
      claim.status = 'Pending';
      claim.adminReason = '';
      claim.needsReview = false;
      claim.verifiedAt = null;
      claim.verifiedBy = '';
      claim.originalStartDate = customer.startDate;
      claim.benefitDate =
        scheme.schemeBenefitDate(customer);
      claim.totalPaid =
        scheme.paidCount(customer) *
        Number(customer.customInstallment || 0);
      claim.verifiedInstallments = 12;

      await claim.save();

      await AdminAudit.create({
        action: 'BENEFIT_CLAIM_REOPENED',
        customerRef: customer._id,
        customerId: customer.customerId,
        reason: 'Customer became eligible again',
        details: {
          claimId: claim.claimId
        }
      });
    }

    if (!claim) {
      const claimId =
        'RJBC-' +
        Date.now().toString(36).toUpperCase() +
        '-' +
        randomBytes(5).toString('hex').toUpperCase();

      try {
        claim = await BenefitClaim.create({
          customer: customer._id,
          customerId: customer.customerId,
          schemeCycle: schemeCycle(customer),
          claimId,
          status: 'Pending',
          originalStartDate: customer.startDate,
          benefitDate:
            scheme.schemeBenefitDate(customer),
          verifiedInstallments: 12,
          totalPaid:
            scheme.paidCount(customer) *
            Number(customer.customInstallment || 0)
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;

        claim = await BenefitClaim.findOne({
          customer: customer._id,
          schemeCycle: schemeCycle(customer)
        });

        if (!claim) throw error;
      }

      await AdminAudit.create({
        action: 'BENEFIT_CLAIM_CREATED',
        customerRef: customer._id,
        customerId: customer.customerId,
        reason: 'Eligible customer requested scheme benefit',
        details: {
          claimId: claim.claimId,
          benefitDate: claim.benefitDate
        }
      });
    }

    res.json({
      success: true,
      claim,
      canDownloadBenefitCard: scheme.eligible(customer) &&
        ['Pending', 'Verified'].includes(claim?.status),
      message:
        'Benefit claim recorded. Present the digital card at the showroom for verification.'
    });
  })
);

app.get(
  '/api/admin/benefit-claims',
  adminAuth,
  wrap(async (req, res) => {
    const status = clean(req.query.status);
    const filter = {};

    if (status) {
      if (![
        'Pending',
        'Verified',
        'Redeemed',
        'Revoked'
      ].includes(status)) {
        bad(400, 'Invalid claim status.');
      }

      filter.status = status;
    }

    const claims = await BenefitClaim.find(filter)
      .populate(
        'customer',
        'name phone customerId schemeStatus paidMonths startDate'
      )
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    res.json({
      success: true,
      claims
    });
  })
);

app.post(
  '/api/admin/benefit-claims/:id/verify',
  adminAuth,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) {
      bad(400, 'Invalid claim ID.');
    }

    const claim = await BenefitClaim.findById(
      req.params.id
    );

    if (!claim) {
      bad(404, 'Benefit claim not found.');
    }

    if (claim.status !== 'Pending') {
      bad(409, 'Only pending claims can be verified.');
    }

    const customer = await User.findById(
      claim.customer
    );

    if (
      !customer ||
      schemeCycle(customer) !== claim.schemeCycle ||
      !scheme.eligible(customer)
    ) {
      if (customer) {
        await reconcileBenefitClaims(
          customer,
          'Eligibility failed during admin verification'
        );
      }

      bad(409, 'Customer is no longer eligible.');
    }

    const updated = await BenefitClaim.findOneAndUpdate(
      {
        _id: claim._id,
        status: 'Pending'
      },
      {
        $set: {
          status: 'Verified',
          verifiedAt: new Date(),
          verifiedBy: ADMIN_EMAIL,
          needsReview: false
        }
      },
      { new: true }
    );

    if (!updated) {
      bad(409, 'Claim status changed. Refresh.');
    }

    await AdminAudit.create({
      action: 'BENEFIT_CLAIM_VERIFIED',
      customerRef: customer._id,
      customerId: customer.customerId,
      reason: 'Admin verified customer benefit eligibility',
      details: {
        claimId: updated.claimId
      }
    });

    res.json({
      success: true,
      claim: updated
    });
  })
);

app.post(
  '/api/admin/benefit-claims/:id/redeem',
  adminAuth,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) {
      bad(400, 'Invalid claim ID.');
    }

    const claim = await BenefitClaim.findById(
      req.params.id
    );

    if (!claim || claim.status !== 'Verified') {
      bad(
        409,
        'Claim must be verified and not previously redeemed.'
      );
    }

    const customer = await User.findById(
      claim.customer
    );

    if (
      !customer ||
      schemeCycle(customer) !== claim.schemeCycle ||
      !scheme.eligible(customer)
    ) {
      if (customer) {
        await reconcileBenefitClaims(
          customer,
          'Eligibility failed during redemption'
        );
      }

      bad(409, 'Customer is no longer eligible.');
    }

    const productId = req.body.productId;

    if (!validId(productId)) {
      bad(
        400,
        'Select the eligible Gold Jewellery product.'
      );
    }

    const product = await Product.findById(
      productId
    );

    if (!product) {
      bad(404, 'Selected product not found.');
    }

    const rootCategory =
      product.categoryId
        ? await getRootCategory(product.categoryId)
        : null;

    const isGold =
      String(rootCategory?.name || product.category)
        .trim()
        .toLowerCase() === 'gold';

    if (!isGold) {
      bad(
        409,
        'Benefit is valid only for eligible Gold Jewellery.'
      );
    }

    const makingCharges = Number(
      req.body.standardMakingCharges
    );

    if (
      !Number.isFinite(makingCharges) ||
      makingCharges < 0
    ) {
      bad(
        400,
        'Enter the actual making/labour charges.'
      );
    }

    const reason = safe(
      req.body.reason,
      400
    );

    if (reason.length < 5) {
      bad(
        400,
        'Enter a redemption note of at least 5 characters.'
      );
    }

    const updated = await BenefitClaim.findOneAndUpdate(
      {
        _id: claim._id,
        status: 'Verified',
        needsReview: false
      },
      {
        $set: {
          status: 'Redeemed',
          redeemedAt: new Date(),
          redeemedBy: ADMIN_EMAIL,
          redeemedProduct: product._id,
          makingCharges,
          discountAmount: makingCharges,
          adminReason: reason
        }
      },
      { new: true }
    );

    if (!updated) {
      bad(
        409,
        'Claim already redeemed or changed. Refresh.'
      );
    }

    await AdminAudit.create({
      action: 'BENEFIT_CLAIM_REDEEMED',
      customerRef: customer._id,
      customerId: customer.customerId,
      reason,
      details: {
        claimId: updated.claimId,
        productId: String(product._id),
        productTitle: product.title,
        makingCharges,
        discountAmount: makingCharges,
        goldOnly: true,
        freeGold: false
      }
    });

    res.json({
      success: true,
      claim: updated,
      makingChargesDiscountPercentage: 100,
      makingChargesToPay: 0,
      discountAmount: makingCharges,
      message:
        'Making/labour charge benefit redeemed for eligible Gold Jewellery.'
    });
  })
);

app.post(
  '/api/admin/benefit-claims/:id/revoke',
  adminAuth,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) {
      bad(400, 'Invalid claim ID.');
    }

    const reason = safe(
      req.body.reason,
      400
    );

    if (reason.length < 5) {
      bad(400, 'Enter a revocation reason.');
    }

    const claim = await BenefitClaim.findOneAndUpdate(
      {
        _id: req.params.id,
        status: {
          $in: ['Pending', 'Verified']
        }
      },
      {
        $set: {
          status: 'Revoked',
          adminReason: reason
        }
      },
      { new: true }
    );

    if (!claim) {
      bad(
        409,
        'Only unredeemed claims can be revoked.'
      );
    }

    await AdminAudit.create({
      action: 'BENEFIT_CLAIM_REVOKED_BY_ADMIN',
      customerRef: claim.customer,
      customerId: claim.customerId,
      reason,
      details: {
        claimId: claim.claimId
      }
    });

    res.json({
      success: true,
      claim
    });
  })
);

// SCHEME ALERTS AND REACTIVATION
app.get('/api/admin/scheme-alerts', adminAuth, wrap(async (_req, res) => {
  await sweepOverdueSchemes();
  const customers = await User.find({
    schemeStatus: {
      $in: ['Cancelled', 'Suspended', 'RefundPending']
    }
  }).select('-password').sort({
    schemeSuspendedAt: -1
  }).lean();

  const alerts = await Promise.all(customers.map(async c => ({
    ...publicCustomer(c),
    refundQuote: await refundQuote(c)
  })));
  res.json({
    success: true, alerts, count: alerts.length
  });
}));

app.post('/api/customer/scheme/reactivation-request',
  customerAuth, wrap(async (req, res) => {
    const c = req.customer;
    const reason = safe(req.body.reason, 1000);
    if (!c.schemeJoined ||
        !['Cancelled', 'Suspended'].includes(c.schemeStatus))
      bad(409, 'Only cancelled schemes can request reactivation.');
    if (reason.length < 10)
      bad(400, 'Explain the missed installment in at least 10 characters.');

    const customer = await User.findOneAndUpdate({
      _id: c._id,
      schemeStatus: { $in: ['Cancelled', 'Suspended'] }
    }, {
      $set: {
        reactivationRequest: {
          status: 'Pending',
          reason,
          requestedAt: new Date()
        },
        schemeCustomerReason: reason
      }
    }, { new: true });

    await AdminAudit.create({
      action: 'SCHEME_REACTIVATION_REQUEST',
      customerRef: c._id,
      customerId: c.customerId,
      reason,
      details: { cycle: schemeCycle(c) }
    });

    res.json({
      success: true,
      customer: publicCustomer(customer),
      message: 'Request sent to admin for review.'
    });
  })
);

app.post('/api/admin/scheme/:id/reject-reactivation',
  adminAuth, wrap(async (req, res) => {
    if (!validId(req.params.id))
      bad(400, 'Invalid ID.');
    const reason = safe(req.body.reason, 400);
    if (reason.length < 10)
      bad(400, 'Enter decision reason (10+ characters).');

    const c = await User.findOneAndUpdate({
      _id: req.params.id,
      schemeStatus: { $in: ['Cancelled', 'Suspended'] },
      'reactivationRequest.status': 'Pending'
    }, {
      $set: {
        'reactivationRequest.status': 'Rejected',
        'reactivationRequest.reviewedAt': new Date(),
        'reactivationRequest.adminReason': reason,
        schemeAdminDecision: `Reactivation rejected: ${reason}`
      }
    }, { new: true });

    if (!c) bad(409, 'Scheme not cancelled.');
    await AdminAudit.create({
      action: 'SCHEME_REACTIVATION_REJECTED',
      customerRef: c._id,
      customerId: c.customerId,
      reason,
      details: { cycle: schemeCycle(c) }
    });
    res.json({
      success: true, customer: publicCustomer(c)
    });
  })
);

app.post('/api/admin/scheme/:id/mark-overdue',
  adminAuth, wrap(async (req, res) => {
    if (!validId(req.params.id))
      bad(400, 'Invalid ID.');

    const monthNum = Number(req.body.monthNum);
    const reason = safe(req.body.reason, 400);

    if (!Number.isInteger(monthNum) ||
        monthNum < 1 || monthNum > 12 ||
        reason.length < 10)
      bad(400, 'Select month 1–12 and enter reason (10+ characters).');

    const session = await mongoose.startSession();
    let updated;
    try {
      await session.withTransaction(async () => {
        const c = await User.findById(req.params.id).session(session);
        if (!c || !c.schemeJoined ||
            c.schemeStatus !== 'Active')
          bad(409, 'Only active schemes can mark overdue.');
        if (currentStates(c)[monthNum - 1].paid)
          bad(409, 'Cannot mark a paid month overdue.');

        c.schemeManualOverdueMonths = [
          ...new Set([
            ...(c.schemeManualOverdueMonths || []),
            monthNum
          ])
        ];
        c.schemeStatus = 'Cancelled';
        c.schemeSuspendedAt = new Date();
        c.schemeSuspendedDueDate =
          scheme.dueDateFor(c, monthNum) || '';
        c.schemeSuspendedDueMonth =
          c.schemeSuspendedDueDate.slice(0, 7);
        c.schemeAdminDecision =
          `Admin marked month ${monthNum} overdue: ${reason}`;
        c.paymentRevision = Number(c.paymentRevision || 0) + 1;
        await c.save({ session });
        updated = c;

        await AdminAudit.create([{
          action: 'SCHEME_MARK_OVERDUE',
          customerRef: c._id,
          customerId: c.customerId,
          monthNum,
          reason,
          details: { cycle: schemeCycle(c) }
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success: true, customer: publicCustomer(updated)
    });
  })
);

app.post('/api/admin/scheme/:id/cancel',
  adminAuth, wrap(async (req, res) => {
    if (!validId(req.params.id))
      bad(400, 'Invalid ID.');
    const reason = safe(req.body.reason, 400);
    if (reason.length < 10)
      bad(400, 'Enter a reason (10+ characters).');

    const c = await User.findOneAndUpdate({
      _id: req.params.id,
      schemeJoined: true,
      schemeStatus: 'Active'
    }, {
      $set: {
        schemeStatus: 'Cancelled',
        schemeSuspendedAt: new Date(),
        schemeAdminDecision: `Manually cancelled: ${reason}`
      }
    }, { new: true });

    if (!c)
      bad(409, 'Only active schemes can be cancelled.');

    await reconcileBenefitClaims(
      c,
      'Scheme manually cancelled by admin'
    );

    await AdminAudit.create({
      action: 'SCHEME_MANUAL_CANCEL',
      customerRef: c._id,
      customerId: c.customerId,
      reason,
      details: { cycle: schemeCycle(c) }
    });
    res.json({
      success: true, customer: publicCustomer(c)
    });
  })
);

app.post('/api/admin/scheme/:id/resume',
  adminAuth, wrap(async (req, res) => {
    if (!validId(req.params.id))
      bad(400, 'Invalid customer ID.');

    const reason = safe(req.body.reason, 400);
    const customerExplanation =
      safe(req.body.customerExplanation, 1000);

    if (reason.length < 10 || customerExplanation.length < 5)
      bad(400, 'Customer explanation (5+) and admin reason (10+) required.');

    const session = await mongoose.startSession();
    let updated, catchup = [];

    try {
      await session.withTransaction(async () => {
        const c = await User.findById(req.params.id).session(session);
        if (!c ||
            !['Cancelled', 'Suspended'].includes(c.schemeStatus))
          bad(409, 'Only cancelled schemes can be resumed.');

        catchup = scheme.overdueRows(c)
          .map(x => x.monthNum);

        c.schemeStatus = 'Active';
        c.schemeCatchupMonthNums = catchup;
        c.schemeCatchupUntil = catchup.length
          ? scheme.addDays(istDate(), 4) : '';
        c.schemeCustomerReason = customerExplanation;
        c.schemeAdminDecision = `Reactivated: ${reason}`;
        c.schemeSuspendedAt = null;
        c.schemeSuspendedDueDate = '';
        c.schemeSuspendedDueMonth = '';
        c.reactivationRequest = {
          status: 'Approved',
          reason: customerExplanation,
          requestedAt:
            c.reactivationRequest?.requestedAt || new Date(),
          reviewedAt: new Date(),
          adminReason: reason
        };
        c.paymentRevision =
          Number(c.paymentRevision || 0) + 1;

        await c.save({ session });
        updated = c;

        await AdminAudit.create([{
          action: 'SCHEME_RESUME',
          customerRef: c._id,
          customerId: c.customerId,
          reason,
          details: {
            customerExplanation,
            catchupMonthNums: catchup,
            catchupUntil: c.schemeCatchupUntil,
            originalStartDate: c.startDate,
            originalBenefitDate:
              scheme.schemeBenefitDate(c),
            cycle: schemeCycle(c)
          }
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success: true,
      customer: publicCustomer(updated),
      catchupMonthNums: catchup,
      message: catchup.length
        ? `Reactivated. Missed installments payable NOW through ${updated.schemeCatchupUntil} IST.`
        : 'Reactivated. Original monthly schedule retained.'
    });
  })
);

app.post('/api/admin/scheme/:id/start-refund',
  adminAuth, wrap(async (req, res) => {
    if (!validId(req.params.id))
      bad(400, 'Invalid customer ID.');

    const reason = safe(req.body.reason, 400);
    const customerExplanation =
      safe(req.body.customerExplanation, 400);
    if (reason.length < 10)
      bad(400, 'Enter admin decision reason (at least 10 characters).');

    const session = await mongoose.startSession();
    let updated, quote;

    try {
      await session.withTransaction(async () => {
        const c = await User.findById(req.params.id).session(session);
        if (!c ||
            !['Cancelled', 'Suspended'].includes(c.schemeStatus))
          bad(409, 'Only suspended schemes can enter refund review.');

        const pending = await PaymentRequest.exists({
          customer: c._id,
          schemeCycle: cycleFilter(schemeCycle(c)),
          status: 'Pending'
        }).session(session);
        if (pending)
          bad(409, 'Review pending UPI payments first. Cannot start refund with unresolved UPI.');

        const approved = await PaymentRequest.find({
          customer: c._id,
          schemeCycle: cycleFilter(schemeCycle(c)),
          status: 'Approved'
        }).session(session);

        quote = refundQuoteFromLedger(c, approved);
        if (Number(req.body.confirmedAmount) !== quote.total)
          bad(409, `Refund amount mismatch. Confirm ₹${quote.total} after checking receipts.`);

        updated = await User.findOneAndUpdate({
          _id: c._id,
          schemeStatus: { $in: ['Cancelled', 'Suspended'] }
        }, {
          $set: {
            schemeStatus: 'RefundPending',
            schemeRefundAmount: quote.total,
            schemeAdminDecision: `Refund initiated: ${reason}`,
            schemeCustomerReason: customerExplanation
          }
        }, { new: true, session });

        if (!updated)
          bad(409, 'Scheme changed. Refresh and retry.');

        await AdminAudit.create([{
          action: 'SCHEME_REFUND_INITIATED',
          customerRef: c._id,
          customerId: c.customerId,
          reason,
          details: {
            quote, customerExplanation,
            cycle: schemeCycle(c)
          }
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success: true,
      customer: publicCustomer(updated),
      refundQuote: quote,
      message: 'Refund review started. NO money was transferred automatically.'
    });
  })
);

app.post('/api/admin/scheme/:id/complete-refund',
  adminAuth, wrap(async (req, res) => {
    if (!validId(req.params.id))
      bad(400, 'Invalid customer ID.');

    const reference = safe(req.body.refundReference, 100);
    const reason = safe(req.body.reason, 300);
    if (req.body.confirmTransfer !== true ||
        reference.length < 6 || reason.length < 5)
      bad(400, 'Confirm actual refund transfer, enter reference (6+ characters) and reason.');

    const session = await mongoose.startSession();
    let updated;

    try {
      await session.withTransaction(async () => {
        const c = await User.findById(req.params.id).session(session);
        if (!c || c.schemeStatus !== 'RefundPending')
          bad(409, 'Scheme is not awaiting refund completion.');
        if (Number(req.body.confirmedAmount) !==
            Number(c.schemeRefundAmount))
          bad(400, 'Confirmed refund amount must match approved refund amount.');

        const pending = await PaymentRequest.exists({
          customer: c._id,
          schemeCycle: cycleFilter(schemeCycle(c)),
          status: 'Pending'
        }).session(session);
        if (pending)
          bad(409, 'Resolve pending UPI before completing refund.');

        const snapshot = {
          cycle: schemeCycle(c),
          refundAmount: c.schemeRefundAmount,
          refundReference: reference,
          paidMonths: c.paidMonths,
          installmentState: currentStates(c),
          paymentHistory: sameCycleHistory(c)
            .map(p => p.toObject?.() || p)
        };

        updated = await User.findOneAndUpdate({
          _id: c._id,
          schemeStatus: 'RefundPending'
        }, {
          $set: {
            schemeStatus: 'Refunded',
            schemeJoined: false,
            paidMonths: 0,
            installmentState: scheme.states({
              paidMonths: 0,
              customInstallment: c.customInstallment
            }),
            schemeFirstDueMonth: '',
            isLaborFree: false,
            schemeRefundReference: reference,
            schemeRefundedAt: new Date(),
            schemeAdminDecision: `Refund completed: ${reason}`
          }
        }, { new: true, session });

        if (!updated)
          bad(409, 'Scheme changed. Refresh and retry.');

        await AdminAudit.create([{
          action: 'SCHEME_REFUND_COMPLETED',
          customerRef: c._id,
          customerId: c.customerId,
          reason,
          details: snapshot
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success: true,
      customer: publicCustomer(updated),
      message: 'Refund recorded. Customer can join a NEW scheme; old UPI records remain archived.'
    });
  })
);

// AUTOMATIC DEADLINE SWEEP
app.post('/api/internal/sweep-overdue', wrap(async (req, res) => {
  const secret = process.env.SCHEME_CRON_SECRET || '';
  const given = clean(req.headers['x-scheme-cron-secret']);
  if (
    !secret || !given ||
    Buffer.byteLength(secret) !== Buffer.byteLength(given) ||
    !timingSafeEqual(
      Buffer.from(secret),
      Buffer.from(given)
    )
  ) bad(403, 'Cron authorization required.');

  await sweepOverdueSchemes();
  res.json({
    success: true,
    checkedAtIST: istDate()
  });
}));

// STORE UPI SETTINGS
app.get('/api/store/settings', wrap(async (_req, res) => {
  const settings = await StoreSettings.findByIdAndUpdate(
    'store_config',
    { $setOnInsert: { merchantName: 'Rahul Jewellers' } },
    { upsert: true, new: true }
  );
  res.json({
    success: true, settings
  });
}));

app.put('/api/store/settings', adminAuth, wrap(async (req, res) => {
  const upiId = clean(req.body.upiId);
  const merchantName = safe(req.body.merchantName, 100);
  if (!upiId || !merchantName ||
      !/^[\w.\-]+@[\w.\-]+$/.test(upiId))
    bad(400, 'Valid UPI ID and merchant name required.');

  const qrCodeUrl = req.body.qrCodeUrl;

  const contactNumbers = req.body.contactNumbers;

  if (contactNumbers !== undefined) {
    if (
      !Array.isArray(contactNumbers) ||
      contactNumbers.length !== 2 ||
      contactNumbers.some(
        number => !validPhone(String(number))
      ) ||
      new Set(contactNumbers.map(String)).size !== 2
    ) {
      bad(
        400,
        'Enter two different valid Indian mobile numbers.'
      );
    }
  }
  if (qrCodeUrl !== undefined && qrCodeUrl &&
      !/^(data:image\/(?:png|jpeg|webp);base64,|https:\/\/)/i.test(qrCodeUrl))
    bad(400, 'Invalid QR image.');

  const settings = await StoreSettings.findByIdAndUpdate(
    'store_config',
    {
      $set: {
        upiId,
        merchantName,
        ...(qrCodeUrl !== undefined
          ? { qrCodeUrl } : {}),
        ...(contactNumbers !== undefined
          ? {
              contactNumbers: contactNumbers.map(String)
            }
          : {})
      }
    },
    { upsert: true, new: true }
  );
  res.json({
    success: true, settings
  });
}));

app.post('/api/admin/send-whatsapp-reminder',
  adminAuth, wrap(async (req, res) => {
    const c = await User.findOne({
      customerId: clean(req.body.customerId)
    });
    if (!c || !c.schemeJoined ||
        c.schemeStatus !== 'Active')
      bad(404, 'Active Gold Scheme subscriber not found.');
    if (Number(c.paidMonths || 0) >= 12)
      bad(409, 'All installments completed.');

    const month = schemeDeadlineFor(c).monthNum;
    const deadline = schemeDeadlineFor(c);

    const message =
      `नमस्ते ${c.name} जी,\n\n` +
      `Rahul Jewellers SHEOGANJ Gold Savings Scheme रिमाइंडर।\n` +
      `Customer ID: ${c.customerId}\n` +
      `किस्त: ${month}/12\n` +
      `राशि: ₹${Number(c.customInstallment).toLocaleString('en-IN')}\n` +
      `किस्त शुरू: ${deadline.dueDate}\n` +
      `अंतिम तारीख: ${deadline.graceEndDate}\n\n` +
      `5 दिन में किस्त न भरने पर स्कीम सस्पेंड होगी। ` +
      `एडमिन से बात करके ही Resume हो सकेगी।\nधन्यवाद!`;

    res.json({
      success: true,
      url: `https://wa.me/91${c.phone}?text=${encodeURIComponent(message)}`
    });
  })
);

// GOLD RATE
const goldClients = new Set();

function goldPayload(rate) {
  return {
    success: true,
    type: 'gold',
    enabled: Boolean(rate?.enabled),
    carat: '22K',
    priceInrPerGram: Number(rate?.priceInrPerGram || 0),
    source: 'manual',
    connected: Boolean(rate?.enabled),
    timestamp: rate?.updatedAt
      ? new Date(rate.updatedAt).getTime() : Date.now(),
    goldLastUpdated: rate?.updatedAt
      ? new Date(rate.updatedAt).getTime() : null
  };
}
function broadcastGoldRate(rate) {
  const message = `data: ${JSON.stringify(goldPayload(rate))}\n\n`;
  for (const client of goldClients) {
    try { client.write(message); }
    catch { goldClients.delete(client); }
  }
}

app.get('/api/gold-rate', wrap(async (_req, res) => {
  res.json(goldPayload(
    await GoldRate.findById('published_gold_rate').lean()
  ));
}));

app.put('/api/admin/gold-rate', adminAuth, wrap(async (req, res) => {
  if (typeof req.body.enabled !== 'boolean')
    bad(400, 'enabled must be true or false.');
  const price = Number(req.body.priceInrPerGram);
  if (!Number.isFinite(price) || price < 0 ||
      (req.body.enabled && price <= 0))
    bad(400, 'Enter a valid rate in INR per gram.');

  const goldRate = await GoldRate.findByIdAndUpdate(
    'published_gold_rate',
    {
      $set: {
        enabled: req.body.enabled,
        priceInrPerGram: price,
        carat: '22K',
        updatedBy: ADMIN_EMAIL
      }
    },
    { new: true, upsert: true, runValidators: true }
  );
  broadcastGoldRate(goldRate);
  res.json({
    success: true, goldRate, rate: goldRate
  });
}));

app.get('/api/gold-rate/stream', wrap(async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function')
    res.flushHeaders();

  goldClients.add(res);
  const rate = await GoldRate.findById(
    'published_gold_rate'
  ).lean();
  res.write(`data: ${JSON.stringify(goldPayload(rate))}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    goldClients.delete(res);
  });
}));

// AI SUPPORT CHAT

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message:
      'Too many support messages. Please try again later.'
  }
});
app.post('/api/support/chat', chatLimiter, wrap(async (req, res) => {
  const message = safe(req.body.message, 1500);
  if (!message) bad(400, 'Message required.');
  if (!ai)
    bad(503, 'Support chat is temporarily unavailable.');

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    contents: message,
    config: {
      systemInstruction:
        `You are the Hindi-first assistant for Rahul Jewellers SHEOGANJ, Rajasthan. Contact numbers: 9950091024 and 9461452322. ` +
        `The showroom sells Gold and Silver jewellery. ` +
        `The 12+1 savings scheme is GOLD ONLY. ` +
        `Customers pay 12 monthly installments, and in the following month eligible ` +
        `customers get 100% off labour/making charges on gold jewellery, subject to terms. ` +
        `There is NO free 13th installment, free extra gold, or silver savings scheme. ` +
        `UPI installment submissions remain Pending until admin verifies. ` +
        `Never claim a manually entered gold rate is a live market rate.`
    }
  });
  res.json({
    success: true,
    reply: response.text ||
      'Please contact Rahul Jewellers SHEOGANJ.'
  });
}));

app.use('/api/schemes', (_req, res) =>
  res.status(410).json({
    success: false,
    message: 'Legacy scheme routes disabled. Use verified customer/admin payment APIs.'
  }));

app.use((err, _req, res, _next) => {
  if (err instanceof mongoose.Error.ValidationError)
    return res.status(400).json({
      success: false, message: err.message
    });
  if (err?.code === 11000)
    return res.status(409).json({
      success: false,
      message: 'Duplicate mobile, Customer ID, UTR or pending installment.'
    });
  if (err?.status)
    return res.status(err.status).json({
      success: false, message: err.message
    });
  console.error('Backend error:', err);
  res.status(500).json({
    success: false,
    message: 'Server error. Please try again.'
  });
});

// MONGODB STARTUP AND LEGACY MIGRATION
mongoose.connect(MONGO_URI).then(async () => {
  await User.updateMany(
    {
      schemeJoined: { $exists: false },
      $or: [
        { paidMonths: { $gt: 0 } },
        { startDate: { $type: 'string', $ne: '' } }
      ]
    },
    { $set: { schemeJoined: true } }
  );

  await User.updateMany({
    schemeJoined: true,
    schemeStatus: { $exists: false }
  }, {
    $set: { schemeStatus: 'Active' }
  });

  await User.updateMany({
    schemeJoined: false,
    schemeStatus: { $exists: false }
  }, {
    $set: { schemeStatus: 'NotJoined' }
  });

  const legacy = await User.find({
    schemeJoined: true,
    $or: [
      { schemeFirstDueMonth: { $exists: false } },
      { schemeFirstDueMonth: '' }
    ]
  }).select('_id paidMonths');

  for (const c of legacy) {
    await User.updateOne({
      _id: c._id,
      $or: [
        { schemeFirstDueMonth: { $exists: false } },
        { schemeFirstDueMonth: '' }
      ]
    }, {
      $set: {
        schemeFirstDueMonth: shiftMonth(
          SCHEME_DEADLINE_START_MONTH,
          -Number(c.paidMonths || 0)
        )
      }
    });
  }

  const needsState = await User.find({
    schemeJoined: true,
    $or: [
      { installmentState: { $exists: false } },
      { installmentState: { $size: 0 } }
    ]
  });

  for (const c of needsState) {
    await User.updateOne({
      _id: c._id,
      $or: [
        { installmentState: { $size: 0 } },
        { installmentState: { $exists: false } }
      ]
    }, {
      $set: {
        installmentState: currentStates(c),
        paidMonths: countPaid(c)
      }
    });
  }

  await User.updateMany({
    schemeStatus: 'Suspended'
  }, {
    $set: { schemeStatus: 'Cancelled' }
  });

  await User.updateMany({
    paymentRevision: { $exists: false }
  }, {
    $set: { paymentRevision: 0 }
  });

  console.log(
    'Legacy scheme deadline protection month:',
    SCHEME_DEADLINE_START_MONTH
  );
  console.log(
    'New scheme: anchor day is joining day; five calendar dates including start date.'
  );

  await Promise.all([
    User.init(),
    PaymentRequest.init(),
    Product.init(),
    BenefitClaim.init()
  ]);

  // Give legacy products a stable URL and gallery.
  // No existing product is deleted or replaced.
  const legacyProducts = Product.find({
    $or: [
      { slug: { $exists: false } },
      { slug: '' },
      { images: { $exists: false } },
      { images: { $size: 0 } }
    ]
  }).cursor();

  for await (const product of legacyProducts) {
    let changed = false;

    if (!product.slug) {
      product.slug = jewellerySlug(product.title);
      changed = true;
    }

    if (
      (!Array.isArray(product.images) ||
        product.images.length === 0) &&
      product.imageUrl
    ) {
      product.images = [{
        url: product.imageUrl,
        alt: product.title
      }];

      changed = true;
    }

    if (changed) {
      await product.save();
    }
  }
  await sweepOverdueSchemes();

  const schemeSweepTimer = setInterval(() => {
    sweepOverdueSchemes().catch(err =>
      console.error('Scheme sweep failed:', err));
  }, 5 * 60 * 1000);

  schemeSweepTimer.unref?.();

  app.listen(PORT, '0.0.0.0', () =>
    console.log(`Rahul Jewellers backend listening on ${PORT}`));
}).catch(err => {
  console.error('MongoDB startup error:', err);
  process.exitCode = 1;
});
