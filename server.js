// Rahul Jewellers Sheoganj — replace jewel-backend/server.js with this file.
// Required .env: MONGO_URI, JWT_SECRET, ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM,
// CORS_ORIGINS (comma-separated customer/admin website origins).
// Optional: PORT, GEMINI_API_KEY, GEMINI_MODEL.
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
// Legacy Scheme model/routes were inconsistent and unauthenticated in the uploaded project.
// Do not import or mount them until they are rewritten to use verified payments.

dotenv.config();
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'web.rahuljewellers051@gmail.com').trim().toLowerCase();
const RESEND_FROM = process.env.RESEND_FROM || 'onboarding@resend.dev';
// One-time go-live baseline. Set this to the first YYYY-MM you want the 5-day rule
// enforced for EXISTING scheme accounts. Do not change after going live.
const SCHEME_DEADLINE_START_MONTH = process.env.SCHEME_DEADLINE_START_MONTH || '2026-12';
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(SCHEME_DEADLINE_START_MONTH))
  throw new Error('SCHEME_DEADLINE_START_MONTH must be YYYY-MM, e.g. 2026-12.');
if (!MONGO_URI) throw new Error('MONGO_URI is required.');
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('Set a strong JWT_SECRET of at least 32 characters.');
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
      (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost(?::\d+)?$/.test(origin))) return cb(null, true);
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
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
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
const validAmount = value => Number.isFinite(value) && value >= 1000 && value <= 1000000;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function istParts(date, fields) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', ...fields })
    .formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
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
// Each customer's due date is the day they joined (e.g. 2nd every month).
// Five calendar dates are inclusive: 2–6, suspension from 7th 00:00 IST.
// For joining on 29–31, months with fewer days use the last calendar day.
// Every later month uses the ORIGINAL anchor day; there is no date drift.
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
function dueMonthFor(c) {
  if (!c?.schemeJoined || Number(c.paidMonths || 0) >= 12) return null;
  const paid = Number(c.paidMonths || 0);
  const base = c.schemeFirstDueMonth || shiftMonth(SCHEME_DEADLINE_START_MONTH, -paid);
  const raw = shiftMonth(base, paid);
  // Legacy customers are protected from retrospective cancellations at rollout.
  // Newly joined schemes (v2) begin on the actual joining day, even before rollout.
  return Number(c.schemeScheduleVersion || 1) >= 2 || raw >= SCHEME_DEADLINE_START_MONTH
    ? raw : SCHEME_DEADLINE_START_MONTH;
}
function schemeDeadlineFor(c) {
  const today = istDate(), status = c?.schemeStatus || (c?.schemeJoined ? 'Active' : 'NotJoined');
  const dueMonth = dueMonthFor(c);
  const anchorDay = schemeAnchorDay(c);
  const dueDate = dueMonth ? dueDateInMonth(dueMonth, anchorDay) : null;
  const graceEndDate = dueDate ? addDaysISO(dueDate, 4) : null;
  const info = {
    status, todayIST: today, schemeStartDate: c?.startDate || null,
    firstDueMonth: c?.schemeFirstDueMonth || null, anchorDay,
    dueMonth, dueDate, graceEndDate,
    cancellationDate: graceEndDate ? addDaysISO(graceEndDate, 1) : null,
    graceDays: 5, dueDay: null, daysRemaining: null, stage: 'NOT_JOINED'
  };
  if (status === 'Suspended') info.stage = 'SUSPENDED';
  else if (status === 'RefundPending') info.stage = 'REFUND_PENDING';
  else if (status === 'Refunded') info.stage = 'REFUNDED';
  else if (!c?.schemeJoined) info.stage = 'NOT_JOINED';
  else if (Number(c.paidMonths || 0) >= 12) info.stage = 'COMPLETED';
  else if (today < dueDate) info.stage = 'UPCOMING';
  else if (today <= graceEndDate) {
    info.stage = 'DUE';
    info.dueDay = daysBetweenISO(dueDate, today) + 1;
    info.daysRemaining = 5 - info.dueDay;
  } else info.stage = 'OVERDUE';
  return info;
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
  // Legacy plaintext users are upgraded to scrypt on their first successful login.
  const a = Buffer.from(password), b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}
const StoreSettings = mongoose.models.StoreSettings || mongoose.model('StoreSettings', new mongoose.Schema({
  _id: { type: String, default: 'store_config' },
  upiId: { type: String, default: '' },
  merchantName: { type: String, default: 'Rahul Jewellers' },
  qrCodeUrl: { type: String, default: '' }
}, { timestamps: true }));
const paymentHistorySchema = new mongoose.Schema({
  monthNum: { type: Number, required: true, min: 1, max: 12 },
  amount: { type: Number, required: true },
  transactionId: { type: String, required: true },
  paidAt: { type: Date, default: Date.now },
  verifiedAt: { type: Date },
  method: { type: String, default: 'Manual' }
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
  schemeStatus: { type: String, enum: ['NotJoined', 'Active', 'Suspended', 'RefundPending', 'Refunded'], default: 'NotJoined' },
  schemeFirstDueMonth: { type: String, default: '' },
  schemeAnchorDay: { type: Number, default: 0 },
  schemeScheduleVersion: { type: Number, default: 1 },
  schemeTermsAcceptedAt: Date,
  schemeTermsVersion: { type: String, default: '' },
  schemeCycle: { type: Number, default: 1 },
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
  cart: [{ product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, quantity: { type: Number, default: 1 } }],
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }]
}, { timestamps: true });
const User = mongoose.models.User || mongoose.model('User', userSchema);
const Category = mongoose.models.Category || mongoose.model('Category', new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  parentCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null }
}, { timestamps: true }));
const Product = mongoose.models.Product || mongoose.model('Product', new mongoose.Schema({
  title: { type: String, required: true },
  category: { type: String, required: true },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  weight: { type: String, required: true },
  price: { type: Number, default: 0 },
  imageUrl: { type: String, required: true }
}, { timestamps: true }));
const paymentRequestSchema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  customerId: { type: String, required: true },
  schemeCycle: { type: Number, default: 1, index: true },
  monthNum: { type: Number, required: true, min: 1, max: 12 },
  amount: { type: Number, required: true },
  transactionId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending', index: true },
  reviewedAt: Date, reviewedBy: String, rejectionReason: { type: String, default: '' },
  // Approval is a bank/UPI verification, independent of whether this payment
  // is currently applied to the customer's 12-month passbook.
  passbookApplied: { type: Boolean, default: false },
  passbookAdjustments: { type: [{
    action: { type: String, enum: ['PAY', 'UNPAY'], required: true },
    at: { type: Date, default: Date.now },
    by: String,
    reason: String
  }], default: [] }
}, { timestamps: true });
paymentRequestSchema.index({ customer: 1, monthNum: 1 },
  { unique: true, partialFilterExpression: { status: 'Pending' } });
const PaymentRequest = mongoose.models.PaymentRequest || mongoose.model('PaymentRequest', paymentRequestSchema);
// Financial corrections and deletions retain an independent, admin-only audit trail.
// Passwords are never included in the audit snapshot.
const AdminAudit = mongoose.models.AdminAudit || mongoose.model('AdminAudit', new mongoose.Schema({
  action: { type: String, required: true, index: true },
  customerRef: { type: mongoose.Schema.Types.ObjectId, index: true },
  customerId: { type: String, required: true, index: true },
  monthNum: Number,
  reason: { type: String, required: true },
  actor: { type: String, default: ADMIN_EMAIL },
  details: mongoose.Schema.Types.Mixed
}, { timestamps: true }));
const GoldRate = mongoose.models.GoldRate || mongoose.model('GoldRate', new mongoose.Schema({
  _id: { type: String, default: 'published_gold_rate' },
  enabled: { type: Boolean, default: false },
  carat: { type: String, default: '22K' },
  priceInrPerGram: { type: Number, default: 0 },
  updatedBy: { type: String, default: 'admin' }
}, { timestamps: true }));
function discountEligible(c) {
  if (!c || !c.schemeJoined || (c.schemeStatus && c.schemeStatus !== 'Active') || Number(c.paidMonths || 0) < 12) return false;
  const final = (c.paymentHistory || []).find(p => Number(p.monthNum) === 12);
  const date = final?.verifiedAt || final?.paidAt;
  return Boolean(date && istMonth(new Date()) > istMonth(new Date(date)));
}
function publicCustomer(c) {
  if (!c) return null;
  const obj = typeof c.toObject === 'function' ? c.toObject() : { ...c };
  delete obj.password; delete obj.__v;
  obj.eligibleForMakingChargeDiscount = discountEligible(obj);
  obj.isLaborFree = obj.eligibleForMakingChargeDiscount;
  obj.schemeDeadline = schemeDeadlineFor(obj);
  return obj;
}
// Reconcile lazily on profile/payment/admin reads AND on a server timer.
// An on-time submitted UPI request protects the customer until verification.
async function ensureSchemeFresh(customer) {
  if (!customer || !customer.schemeJoined || (customer.schemeStatus && customer.schemeStatus !== 'Active') ||
      Number(customer.paidMonths || 0) >= 12) return customer;
  const deadline = schemeDeadlineFor(customer);
  if (deadline.stage !== 'OVERDUE') return customer;
  const pending = await PaymentRequest.find({
    customer: customer._id, schemeCycle: cycleFilter(schemeCycle(customer)),
    monthNum: Number(customer.paidMonths || 0) + 1, status: 'Pending'
  }).select('createdAt').lean();
  if (pending.some(p => istDate(new Date(p.createdAt)) <= deadline.graceEndDate)) return customer;
  const updated = await User.findOneAndUpdate({
    _id: customer._id, paidMonths: Number(customer.paidMonths || 0),
    schemeStatus: 'Active', schemeJoined: true
  }, { $set: {
    schemeStatus: 'Suspended', schemeSuspendedAt: new Date(),
    schemeSuspendedDueMonth: deadline.dueMonth, schemeSuspendedDueDate: deadline.dueDate,
    schemeAdminDecision: 'Awaiting admin review'
  } }, { new: true });
  if (updated) {
    await AdminAudit.create({ action: 'SCHEME_AUTO_SUSPEND', customerRef: updated._id,
      customerId: updated.customerId, monthNum: Number(updated.paidMonths || 0) + 1,
      reason: 'No verified installment or on-time pending UPI within 5 dates of the due date',
      details: { dueMonth: deadline.dueMonth, dueDate: deadline.dueDate,
        cycle: schemeCycle(updated), deadline: deadline.graceEndDate } });
    return updated;
  }
  return await User.findById(customer._id) || customer;
}
async function sweepOverdueSchemes() {
  const candidates = await User.find({ schemeJoined: true,
    schemeStatus: 'Active', paidMonths: { $lt: 12 } }).select(
    '_id customerId paidMonths schemeJoined schemeStatus schemeCycle schemeFirstDueMonth schemeAnchorDay schemeScheduleVersion startDate'
  );
  for (const c of candidates) {
    try { await ensureSchemeFresh(c); }
    catch (err) { console.error('Scheme deadline check failed:', c.customerId, err.message); }
  }
}
function refundQuoteFromLedger(customer, approved) {
  const approvedUtrs = new Set(approved.map(p => p.transactionId));
  const upi = approved.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  // Old verified UPI entries can predate PaymentRequest records. Do not omit them.
  const legacyUpi = (customer.paymentHistory || []).filter(p =>
    p.method === 'UPI' && !approvedUtrs.has(p.transactionId))
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const manual = (customer.paymentHistory || []).filter(p => p.method !== 'UPI')
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  return { upi, legacyUpi, manual, total: upi + legacyUpi + manual,
    note: 'Reconcile actual bank/cash receipts before initiating refund; approved UPI is counted even when passbook is Unpaid.' };
}
async function refundQuote(customer) {
  const approved = await PaymentRequest.find({ customer: customer._id,
    schemeCycle: cycleFilter(schemeCycle(customer)), status: 'Approved' }).lean();
  return refundQuoteFromLedger(customer, approved);
}
function customerToken(c) {
  return jwt.sign({ sub: String(c._id), role: 'customer', type: 'customer', v: Number(c.tokenVersion || 0) }, JWT_SECRET, { expiresIn: '7d' });
}
function readToken(req, cookieName) {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.cookies?.[cookieName];
}
function adminAuth(req, res, next) {
  try {
    const token = readToken(req, 'admin_token');
    if (!token) return res.status(401).json({ success: false, message: 'Admin login required.' });
    const p = jwt.verify(token, JWT_SECRET);
    if (!(p.type === 'admin' || p.role === 'admin' ||
      (!p.type && !p.role && clean(p.email).toLowerCase() === ADMIN_EMAIL))) {
      return res.status(403).json({ success: false, message: 'Admin access only.' });
    }
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Admin session expired.' });
  }
}
const customerAuth = wrap(async (req, res, next) => {
  const token = readToken(req, 'customer_token');
  if (!token) bad(401, 'Customer login required.');
  let p;
  try { p = jwt.verify(token, JWT_SECRET); } catch { bad(401, 'Customer session expired.'); }
  if (p.type !== 'customer' && p.role !== 'customer') bad(403, 'Customer access only.');
  if (!validId(p.sub)) bad(401, 'Invalid customer token.');
  let customer = await User.findById(p.sub);
  if (!customer) bad(401, 'Customer account not found.');
  if (customer.isActive === false) bad(403, 'Account deactivated.');
  if (Number(p.v || 0) !== Number(customer.tokenVersion || 0)) bad(401, 'Customer session expired after password reset. Please log in again.');
  customer = await ensureSchemeFresh(customer);
  req.customer = customer;
  next();
});
app.get('/', (_req, res) => res.send('Rahul Jewellers Sheoganj Backend is Running'));
app.get('/health', (_req, res) => res.json({ success: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));

// ============================================================
// ADMIN EMAIL OTP
// ============================================================
const otpStorage = new Map();
app.post('/api/client/send-email-otp', loginLimiter, wrap(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  if (email !== ADMIN_EMAIL) bad(403, 'Unauthorized admin email.');
  if (!resend) bad(503, 'RESEND_API_KEY is not configured.');
  const otp = String(randomInt(100000, 1000000));
  const result = await resend.emails.send({
    from: RESEND_FROM, to: [ADMIN_EMAIL],
    subject: 'Rahul Jewellers Admin Login OTP',
    html: `<p>Your admin verification code: <strong>${otp}</strong> (valid for 5 minutes).</p>`
  });
  if (result.error) bad(502, 'OTP email could not be sent. Check verified sender.');
  otpStorage.set(email, {
    hash: createHash('sha256').update(otp).digest('hex'),
    expires: Date.now() + 300000, attempts: 0
  });
  res.json({ success: true, message: 'Admin OTP sent.' });
}));
app.post('/api/client/verify-email-otp', loginLimiter, wrap(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const otp = clean(req.body.otp);
  const record = otpStorage.get(email);
  if (email !== ADMIN_EMAIL || !record || record.expires < Date.now() || record.attempts >= 5)
    bad(401, 'OTP expired or invalid.');
  record.attempts++;
  if (!/^\d{6}$/.test(otp) ||
    !timingSafeEqual(createHash('sha256').update(otp).digest(), Buffer.from(record.hash, 'hex')))
    bad(401, 'Incorrect OTP.');
  otpStorage.delete(email);
  const token = jwt.sign({ sub: 'admin', type: 'admin', role: 'admin', email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, message: 'Admin verified.' });
}));
app.get('/api/client/admin-session', adminAuth, (_req, res) => res.json({ success: true, message: 'Session active.' }));
app.post('/api/client/admin-logout', (_req, res) => {
  res.clearCookie('admin_token', { httpOnly: true, secure: true, sameSite: 'none' });
  res.json({ success: true });
});

// ============================================================
// SHOWROOM PRODUCTS: GOLD AND SILVER BOTH ALLOWED
// ============================================================
app.get('/api/products', wrap(async (_req, res) => {
  res.json({ success: true, products: await Product.find().sort({ createdAt: -1 }).lean() });
}));
app.post('/api/admin/products', adminAuth, wrap(async (req, res) => {
  const title = safe(req.body.title, 150), category = safe(req.body.category, 60);
  const weight = safe(req.body.weight, 80), imageUrl = clean(req.body.imageUrl);
  const price = req.body.price == null || req.body.price === '' ? 0 : Number(req.body.price);
  if (!title || !category || !weight) bad(400, 'Product name, category and weight are required.');
  if (!Number.isFinite(price) || price < 0) bad(400, 'Invalid price.');
  if (!/^(data:image\/(?:png|jpeg|webp|gif);base64,|https:\/\/)/i.test(imageUrl))
    bad(400, 'Valid image is required.');
  const categoryId = validId(req.body.categoryId) ? req.body.categoryId : null;
  const product = await Product.create({ title, category, weight, imageUrl, price, categoryId });
  res.status(201).json({ success: true, product });
}));
app.delete('/api/admin/products/:id', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id)) bad(400, 'Invalid product ID.');
  if (!await Product.findByIdAndDelete(req.params.id)) bad(404, 'Product not found.');
  res.json({ success: true, message: 'Product deleted.' });
}));
app.get('/api/categories', wrap(async (_req, res) => {
  res.json({ success: true, categories: await Category.find().populate('parentCategory').sort({ createdAt: -1 }).lean() });
}));
app.post('/api/admin/categories', adminAuth, wrap(async (req, res) => {
  const name = safe(req.body.name, 100);
  if (!name) bad(400, 'Category name is required.');
  const parentCategory = validId(req.body.parentCategory) ? req.body.parentCategory : null;
  if (parentCategory && !await Category.exists({ _id: parentCategory })) bad(404, 'Parent category not found.');
  const category = await Category.create({ name, description: safe(req.body.description, 400), parentCategory });
  res.status(201).json({ success: true, category });
}));
app.delete('/api/admin/categories/:id', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id)) bad(400, 'Invalid category ID.');
  if (await Product.exists({ categoryId: req.params.id })) bad(409, 'Move products out of this category first.');
  if (await Category.exists({ parentCategory: req.params.id })) bad(409, 'Delete subcategories first.');
  if (!await Category.findByIdAndDelete(req.params.id)) bad(404, 'Category not found.');
  res.json({ success: true, message: 'Category deleted.' });
}));

// ============================================================
// CUSTOMER REGISTRATION: ACCOUNT IS NOT AUTOMATIC SCHEME JOIN
// ============================================================
async function createCustomer({ name, dob = '', phone, email, address = '', password,
                                schemeJoined = false, customInstallment = 10000,
                                schemeConsentConfirmed = false }) {
  const joinedDate = istDate();
  return User.create({
    customerId: `RJ${randomInt(100000000, 1000000000)}`,
    name, dob, phone, email, address, password: await hashPassword(password),
    schemeJoined, schemeJoinedAt: schemeJoined ? new Date() : undefined,
    customInstallment, startDate: schemeJoined ? joinedDate : '',
    schemeStatus: schemeJoined ? 'Active' : 'NotJoined',
    schemeFirstDueMonth: schemeJoined ? joinedDate.slice(0, 7) : '',
    schemeAnchorDay: schemeJoined ? Number(joinedDate.slice(8, 10)) : 0,
    schemeScheduleVersion: 2,
    schemeTermsAcceptedAt: schemeJoined && schemeConsentConfirmed ? new Date() : undefined,
    schemeTermsVersion: schemeJoined && schemeConsentConfirmed ? 'rolling-5-day-v1' : '',
    schemeCycle: 1,
    paidMonths: 0, isLaborFree: false, isActive: true
  });
}
app.post('/api/customer/register', loginLimiter, wrap(async (req, res) => {
  const name = safe(req.body.name, 100), dob = clean(req.body.dob);
  const phone = clean(req.body.phone), email = normalizeEmail(req.body.email);
  const address = safe(req.body.address, 500);
  const password = String(req.body.password ?? '');
  if (!name || !validPhone(phone) || !validDate(dob) || !validEmail(email))
    bad(400, 'Valid name, email, date of birth (YYYY-MM-DD) and Indian mobile are required.');
  if (password.length < 8 || password.length > 128) bad(400, 'Password must have 8–128 characters.');
  if (req.body.confirmPassword !== undefined && req.body.confirmPassword !== password)
    bad(400, 'Passwords do not match.');
  if (await User.exists({ phone })) bad(409, 'Mobile number already registered.');
  const customer = await createCustomer({ name, dob, phone, email, address, password });
  res.status(201).json({ success: true, customer: publicCustomer(customer), token: customerToken(customer) });
}));
app.post('/api/customer/login', loginLimiter, wrap(async (req, res) => {
  const identifier = clean(req.body.identifier), password = String(req.body.password ?? '');
  if (!identifier || !password) bad(400, 'Customer ID/mobile and password required.');
  const customer = await User.findOne({ $or: [
    { customerId: { $regex: `^${escapeRegex(identifier)}$`, $options: 'i' } },
    { phone: identifier }
  ] }).select('+password');
  if (!customer || !await verifyPassword(password, customer.password)) bad(401, 'Incorrect login details.');
  if (customer.isActive === false) bad(403, 'Account deactivated. Contact Rahul Jewellers Sheoganj.');
  if (!customer.password.startsWith('scrypt$')) {
    customer.password = await hashPassword(password);
    await customer.save();
  }
  const current = await ensureSchemeFresh(customer);
  res.json({ success: true, customer: publicCustomer(current), token: customerToken(current) });
}));
app.get('/api/customer/profile/:id', customerAuth, wrap(async (req, res) => {
  if (String(req.customer._id) !== req.params.id) bad(403, 'Access denied to this profile.');
  res.json({ success: true, customer: publicCustomer(req.customer) });
}));
async function updateCustomerProfile(req, res) {
  const c = req.customer;
  const id = req.params.id || req.body.userId;
  if (id && String(id) !== String(c._id)) bad(403, 'You can only edit your account.');
  if (req.body.name !== undefined) {
    const name = safe(req.body.name, 100);
    if (!name) bad(400, 'Name cannot be empty.');
    c.name = name;
  }
  if (req.body.address !== undefined) c.address = safe(req.body.address, 500);
  if (req.body.email !== undefined) {
    const email = normalizeEmail(req.body.email);
    if (!validEmail(email)) bad(400, 'Enter a valid email address.');
    c.email = email;
  }
  if (req.body.dob !== undefined) {
    const dob = clean(req.body.dob);
    if (dob && !validDate(dob)) bad(400, 'Invalid date of birth.');
    c.dob = dob;
  }
  if (req.body.phone !== undefined && clean(req.body.phone) !== c.phone) {
    const phone = clean(req.body.phone);
    if (!validPhone(phone)) bad(400, 'Invalid Indian mobile.');
    if (await User.exists({ phone, _id: { $ne: c._id } })) bad(409, 'Mobile already registered.');
    c.phone = phone;
  }
  if (req.body.password) {
    const newPassword = String(req.body.password), currentPassword = String(req.body.currentPassword || '');
    if (newPassword.length < 8 || newPassword.length > 128) bad(400, 'New password must have 8–128 characters.');
    if (!currentPassword) bad(400, 'Current password required to change password.');
    const existing = await User.findById(c._id).select('+password');
    if (!existing || !await verifyPassword(currentPassword, existing.password)) bad(401, 'Current password incorrect.');
    c.password = await hashPassword(newPassword);
    c.tokenVersion = Number(c.tokenVersion || 0) + 1;
  }
  await c.save();
  const customer = publicCustomer(c);
  res.json({ success: true, customer, user: customer, token: customerToken(c) });
}
app.put('/api/customer/update-profile/:id', customerAuth, wrap(updateCustomerProfile));
app.put('/api/customer/settings/update', customerAuth, wrap(updateCustomerProfile));
app.post('/api/customer/wishlist/toggle', customerAuth, wrap(async (req, res) => {
  if (req.body.userId && String(req.body.userId) !== String(req.customer._id)) bad(403, 'Access denied.');
  const productId = req.body.productId;
  if (!validId(productId) || !await Product.exists({ _id: productId })) bad(404, 'Product not found.');
  if (req.customer.wishlist.some(id => String(id) === String(productId)))
    req.customer.wishlist.pull(productId);
  else req.customer.wishlist.addToSet(productId);
  await req.customer.save();
  const customer = publicCustomer(req.customer);
  res.json({ success: true, customer, user: customer });
}));

// ============================================================
// GOLD-ONLY 12+1 SCHEME — SEPARATE JOIN ACTION
// ============================================================
app.post('/api/customer/join-scheme', customerAuth, wrap(async (req, res) => {
  const amount = Number(req.body.amount ?? req.body.customInstallment);
  if (!validAmount(amount)) bad(400, 'Monthly amount must be ₹1,000 to ₹10,00,000.');
  if (!validEmail(normalizeEmail(req.customer.email))) bad(400, 'Add a valid email to your profile before joining.');
  if (req.body.termsAccepted !== true) bad(400, 'Please accept the 5-day deadline, cancellation and refund review terms.');
  if (req.customer.schemeJoined || req.customer.schemeStatus === 'RefundPending' ||
      req.customer.schemeStatus === 'Suspended') bad(409, 'Existing scheme must be reviewed and refunded before starting a new one.');
  const nextCycle = schemeCycle(req.customer) + (req.customer.schemeStatus === 'Refunded' ? 1 : 0);
  const joinedDate = istDate();
  const updated = await User.findOneAndUpdate(
    { _id: req.customer._id, schemeJoined: { $ne: true }, paidMonths: 0,
      schemeStatus: req.customer.schemeStatus || 'NotJoined' },
    { $set: { schemeJoined: true, schemeJoinedAt: new Date(),
      schemeStatus: 'Active', schemeCycle: nextCycle,
      schemeFirstDueMonth: joinedDate.slice(0, 7),
      schemeAnchorDay: Number(joinedDate.slice(8, 10)), schemeScheduleVersion: 2,
      schemeTermsAcceptedAt: new Date(), schemeTermsVersion: 'rolling-5-day-v1',
      schemeSuspendedAt: null, schemeSuspendedDueMonth: '', schemeSuspendedDueDate: '',
      schemeCustomerReason: '', schemeAdminDecision: '',
      schemeRefundAmount: 0, schemeRefundReference: '', schemeRefundedAt: null,
      paymentHistory: [], paidMonths: 0,
      customInstallment: amount, startDate: joinedDate, isLaborFree: false } },
    { new: true }
  );
  if (!updated) bad(409, 'Scheme state changed. Refresh and try again.');
  res.json({ success: true, customer: publicCustomer(updated), message: 'Gold Scheme joined.' });
}));

// Customer UTR submission NEVER marks an installment paid automatically.
app.post('/api/customer/pay-installment', customerAuth, wrap(async (req, res) => {
  const c = req.customer;
  if (req.body.userId && String(req.body.userId) !== String(c._id)) bad(403, 'Not your scheme.');
  if (!c.schemeJoined || c.schemeStatus !== 'Active') bad(409, 'Scheme is suspended or closed. Contact the store for admin review.');
  const deadline = schemeDeadlineFor(c);
  if (deadline.stage !== 'DUE') bad(409, deadline.stage === 'UPCOMING'
    ? `Installment opens on ${deadline.dueDate} and closes on ${deadline.graceEndDate}.`
    : 'Payment deadline passed. Scheme is suspended; contact the showroom.');
  const monthNum = Number(req.body.monthNum), amount = Number(req.body.amount);
  const transactionId = clean(req.body.transactionId ?? req.body.utr).toUpperCase();
  if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) bad(400, 'Invalid month.');
  if (monthNum !== Number(c.paidMonths || 0) + 1) bad(409, 'Only the next unpaid installment can be submitted.');
  if (amount !== Number(c.customInstallment)) bad(400, 'Amount must match your monthly installment.');
  if (!/^[A-Z0-9]{10,20}$/.test(transactionId)) bad(400, 'UTR must contain 10–20 letters/digits.');
  if (await User.exists({ 'paymentHistory.transactionId': transactionId }))
    bad(409, 'UTR already verified.');
  if (await PaymentRequest.exists({ transactionId }))
    bad(409, 'This UTR has already been submitted.');
  if (await AdminAudit.exists({ action: 'CUSTOMER_DELETE', 'details.paymentRequests.transactionId': transactionId }))
    bad(409, 'This UTR belongs to an archived financial record. Contact the showroom.');
  if (await PaymentRequest.exists({ customer: c._id, schemeCycle: cycleFilter(schemeCycle(c)), monthNum, status: 'Pending' }))
    bad(409, 'A payment for this month is already pending review.');
  if (await PaymentRequest.exists({ customer: c._id, schemeCycle: cycleFilter(schemeCycle(c)), monthNum, status: 'Approved' }))
    bad(409, 'A UPI payment for this month is already approved. Contact the admin to reapply it to the passbook; do not pay again.');
  const paymentRequest = await PaymentRequest.create({
    customer: c._id, customerId: c.customerId, schemeCycle: schemeCycle(c), monthNum, amount, transactionId
  });
  res.status(201).json({
    success: true, verified: false, status: 'Pending',
    message: 'Submitted for admin verification. Your paid months have NOT increased yet.',
    paymentRequest, request: paymentRequest, customer: publicCustomer(c)
  });
}));
app.get('/api/customer/payment-requests', customerAuth, wrap(async (req, res) => {
  const requests = await PaymentRequest.find({ customer: req.customer._id, schemeCycle: cycleFilter(schemeCycle(req.customer)) }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, requests, paymentRequests: requests });
}));

// ============================================================
// ADMIN CUSTOMER DIRECTORY / CREATION / STATUS
// ============================================================
app.get('/api/admin/customers', adminAuth, wrap(async (_req, res) => {
  await sweepOverdueSchemes();
  const customers = (await User.find().select('-password').sort({ createdAt: -1 }).lean()).map(publicCustomer);
  res.json({ success: true, customers, users: customers });
}));
app.post('/api/admin/create-customer', adminAuth, wrap(async (req, res) => {
  const name = safe(req.body.name, 100), phone = clean(req.body.phone);
  const email = normalizeEmail(req.body.email);
  const dob = clean(req.body.dob), address = safe(req.body.address, 500);
  const password = String(req.body.password ?? '');
  if (!name || !validPhone(phone) || !validEmail(email)) bad(400, 'Valid name, email and Indian mobile required.');
  if (dob && !validDate(dob)) bad(400, 'Invalid date of birth.');
  if (password.length < 8 || password.length > 128) bad(400, 'Password must have 8–128 characters.');
  if (await User.exists({ phone })) bad(409, 'Mobile already registered.');
  // Existing admin passbook form explicitly sends installment AND startDate.
  // Website registration does NOT automatically join the scheme.
  const join = req.body.schemeJoined === true ||
    (req.body.schemeJoined !== false && req.body.customInstallment != null && Boolean(req.body.startDate));
  const amount = Number(req.body.customInstallment ?? 10000);
  if (join && !validAmount(amount)) bad(400, 'Invalid monthly installment.');
  if (join && req.body.schemeConsentConfirmed !== true)
    bad(400, "Record the customer acceptance of the 5-day cancellation/refund terms.");
  const customer = await createCustomer({
    name, phone, email, dob, address, password, schemeJoined: join,
    customInstallment: join ? amount : 10000,
    schemeConsentConfirmed: join && req.body.schemeConsentConfirmed === true
  });
  res.status(201).json({ success: true, customer: publicCustomer(customer) });
}));
// Existing customers may have been created before email was collected.
app.put('/api/admin/customers/:id/email', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id)) bad(400, 'Invalid customer ID.');
  const email = normalizeEmail(req.body.email);
  if (!validEmail(email)) bad(400, 'Enter a valid customer email address.');
  const customer = await User.findByIdAndUpdate(req.params.id, { $set: { email } }, { new: true });
  if (!customer) bad(404, 'Customer not found.');
  await AdminAudit.create({ action: 'CUSTOMER_EMAIL_UPDATED', customerRef: customer._id,
    customerId: customer.customerId, reason: 'Admin updated customer contact email' });
  res.json({ success: true, customer: publicCustomer(customer) });
}));
// Secure reset: new password shown once; all previous customer tokens become invalid.
app.post('/api/admin/customers/:id/reset-password', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id)) bad(400, 'Invalid customer ID.');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  const temporaryPassword = Array.from(randomBytes(18), n => alphabet[n % alphabet.length]).join('');
  const customer = await User.findByIdAndUpdate(req.params.id,
    { $set: { password: await hashPassword(temporaryPassword) }, $inc: { tokenVersion: 1 } },
    { new: true });
  if (!customer) bad(404, 'Customer not found.');
  await AdminAudit.create({ action: 'CUSTOMER_PASSWORD_RESET', customerRef: customer._id,
    customerId: customer.customerId, reason: 'Admin reset customer login password' });
  res.json({ success: true, temporaryPassword, customerId: customer.customerId,
    message: 'Password reset. Old customer sessions are invalid.' });
}));
app.put('/api/admin/customer-status/:id', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id) || typeof req.body.isActive !== 'boolean')
    bad(400, 'Valid ID and isActive boolean required.');
  const customer = await User.findByIdAndUpdate(req.params.id, { isActive: req.body.isActive }, { new: true });
  if (!customer) bad(404, 'Customer not found.');
  res.json({ success: true, customer: publicCustomer(customer) });
}));
// The admin can delete test customers even if installments/UPI were recorded.
// We remove linked requests in the SAME transaction and retain a financial audit.
// This never refunds or cancels the real UPI/bank transaction.
app.delete('/api/admin/delete-customer/:id', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id)) bad(400, 'Invalid customer ID.');
  const confirmation = clean(req.body?.confirmCustomerId);
  const reason = safe(req.body?.reason, 300);
  if (req.body?.confirmDelete !== true || !confirmation || reason.length < 5)
    bad(400, 'Confirm the exact Customer ID and enter a deletion reason (at least 5 characters).');

  const session = await mongoose.startSession();
  let deletedCustomerId = '';
  let removedRequests = 0;
  try {
    await session.withTransaction(async () => {
      const customer = await User.findById(req.params.id).session(session);
      if (!customer) bad(404, 'Customer not found. Refresh the directory.');
      if (confirmation !== customer.customerId)
        bad(400, 'Customer ID confirmation does not match. Nothing was deleted.');
      const requests = await PaymentRequest.find({ customer: customer._id }).session(session).lean();
      deletedCustomerId = customer.customerId;
      // Retain a minimal FINANCIAL snapshot only; no password, name, address or phone.
      const financialSnapshot = {
        schemeJoined: customer.schemeJoined,
        customInstallment: customer.customInstallment,
        paidMonths: customer.paidMonths,
        paymentHistory: customer.paymentHistory.map(p => ({
          monthNum: p.monthNum, amount: p.amount, transactionId: p.transactionId,
          paidAt: p.paidAt, verifiedAt: p.verifiedAt, method: p.method
        })),
        paymentRequests: requests.map(p => ({
          monthNum: p.monthNum, amount: p.amount, transactionId: p.transactionId,
          status: p.status, passbookApplied: p.passbookApplied,
          reviewedAt: p.reviewedAt, passbookAdjustments: p.passbookAdjustments
        }))
      };
      await AdminAudit.create([{
        action: 'CUSTOMER_DELETE', customerRef: customer._id,
        customerId: customer.customerId, reason,
        details: financialSnapshot
      }], { session });
      const requestsResult = await PaymentRequest.deleteMany({ customer: customer._id }).session(session);
      removedRequests = requestsResult.deletedCount || 0;
      const customerResult = await User.deleteOne({ _id: customer._id }).session(session);
      if (customerResult.deletedCount !== 1) bad(409, 'Customer changed during deletion. Retry.');
    });
  } finally { await session.endSession(); }
  res.json({ success: true, deletedCustomerId, removedRequests,
    message: 'Customer and linked payment requests deleted. Financial audit retained; no bank refund was made.' });
}));

// Admin can toggle the LATEST paid month or NEXT unpaid month, including an
// already-approved UPI payment. This is a PASSBOOK adjustment, NOT a refund.
// Approved UPI UTRs remain in PaymentRequest and cannot be double-counted.
app.post('/api/admin/manual-passbook-update', adminAuth, wrap(async (req, res) => {
  const userId = req.body.userId, monthNum = Number(req.body.monthNum);
  const action = clean(req.body.action).toUpperCase();
  const reason = safe(req.body.reason || (action === 'PAY' ? 'Admin passbook entry' : ''), 300);
  if (!validId(userId) || !Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12 ||
      !['PAY', 'UNPAY'].includes(action)) bad(400, 'Invalid passbook action.');
  if (reason.length < 5) bad(400, 'Enter a reason (at least 5 characters) for this adjustment.');

  const session = await mongoose.startSession();
  let updated, source = 'Manual';
  try {
    await session.withTransaction(async () => {
      const c = await User.findById(userId).session(session);
      if (!c) bad(404, 'Customer not found.');
      if (!c.schemeJoined || c.schemeStatus !== 'Active') bad(409, 'Scheme suspended/closed. Resume it in Scheme Alerts first.');
      if (c.isActive === false) bad(403, 'Customer is deactivated. Activate before editing the passbook.');
      if (action === 'PAY' && schemeDeadlineFor(c).stage !== 'DUE')
        bad(409, 'Installment can only be marked paid during its own 5-day window.');
      const paidMonths = Number(c.paidMonths || 0);
      const now = new Date();
      let transactionId = '';
      let request = null;
      let amount = Number(c.customInstallment);

      if (action === 'PAY') {
        if (monthNum !== paidMonths + 1) bad(409, 'Only the next unpaid month can be marked paid.');
        if (await PaymentRequest.exists({ customer: c._id, schemeCycle: cycleFilter(schemeCycle(c)), monthNum, status: 'Pending' }).session(session))
          bad(409, 'UPI request pending. Approve or reject it first.');
        request = await PaymentRequest.findOne({ customer: c._id, schemeCycle: cycleFilter(schemeCycle(c)), monthNum, status: 'Approved' })
          .sort({ reviewedAt: -1 }).session(session);
        if (request) {
          // Old approved requests may not have this new field yet. In that case
          // they are considered applied, never silently re-verified.
          if (request.passbookApplied !== false)
            bad(409, 'UPI was already approved/applied. Refresh or contact support before changing it.');
          source = 'UPI_REAPPLIED';
          transactionId = request.transactionId;
          amount = request.amount;
          if (amount !== Number(c.customInstallment))
            bad(409, 'Verified UPI amount differs from current monthly installment.');
        } else {
          source = 'ADMIN_MANUAL';
          transactionId = `ADMIN_MANUAL_${Date.now()}_${randomInt(1000, 9999)}`;
        }
        updated = await User.findOneAndUpdate(
          { _id: c._id, paidMonths, schemeJoined: true, isActive: { $ne: false },
            'paymentHistory.monthNum': { $ne: monthNum } },
          { $inc: { paidMonths: 1 }, $push: { paymentHistory: {
            monthNum, amount, transactionId,
            paidAt: request?.createdAt || now, verifiedAt: request?.reviewedAt || now,
            method: request ? 'UPI' : 'AdminManual'
          } }, $set: { isLaborFree: false } },
          { new: true, session }
        );
        if (!updated) bad(409, 'Passbook changed. Refresh and retry.');
        if (request) {
          const r = await PaymentRequest.updateOne(
            { _id: request._id, status: 'Approved', passbookApplied: false },
            { $set: { passbookApplied: true },
              $push: { passbookAdjustments: { action: 'PAY', at: now, by: ADMIN_EMAIL, reason } } },
            { session }
          );
          if (r.modifiedCount !== 1) bad(409, 'UPI status changed. Refresh and retry.');
        }
      } else {
        if (monthNum !== paidMonths) bad(409, 'Only the latest paid month can be marked unpaid.');
        const history = c.paymentHistory.find(p => Number(p.monthNum) === monthNum);
        if (!history) bad(409, 'Payment history is missing for this paid month.');
        transactionId = history.transactionId;
        amount = history.amount;
        if (history.method === 'UPI') {
          request = await PaymentRequest.findOne({
            customer: c._id, schemeCycle: cycleFilter(schemeCycle(c)), monthNum, status: 'Approved', transactionId
          }).session(session);
          if (!request) bad(409, 'Approved UPI record is missing. Cannot safely adjust this month.');
          source = 'UPI_ADJUSTED';
        } else {
          source = 'ADMIN_MANUAL';
        }
        updated = await User.findOneAndUpdate(
          { _id: c._id, paidMonths, 'paymentHistory.transactionId': transactionId },
          { $inc: { paidMonths: -1 }, $pull: { paymentHistory: { monthNum } },
            $set: { isLaborFree: false } },
          { new: true, session }
        );
        if (!updated) bad(409, 'Passbook changed. Refresh and retry.');
        if (request) {
          const r = await PaymentRequest.updateOne(
            { _id: request._id, status: 'Approved', passbookApplied: { $ne: false } },
            { $set: { passbookApplied: false },
              $push: { passbookAdjustments: { action: 'UNPAY', at: now, by: ADMIN_EMAIL, reason } } },
            { session }
          );
          if (r.modifiedCount !== 1) bad(409, 'UPI status changed. Refresh and retry.');
        }
      }
      await AdminAudit.create([{
        action: `PASSBOOK_${action}`, customerRef: c._id,
        customerId: c.customerId, monthNum, reason,
        details: { source, amount, transactionId, oldPaidMonths: paidMonths,
          newPaidMonths: updated.paidMonths, paymentRequestId: request?._id || null }
      }], { session });
    });
  } finally { await session.endSession(); }
  res.json({ success: true, customer: publicCustomer(updated), source,
    message: action === 'UNPAY'
      ? 'Installment removed from passbook. Approved UPI remains verified; no bank refund was made.'
      : source === 'UPI_REAPPLIED'
        ? 'Previously verified UPI payment reapplied to passbook. No new payment was charged.'
        : 'Installment marked paid manually.' });
}));

// Recent admin changes, including financial corrections and test customer deletion.
app.get('/api/admin/audit-log', adminAuth, wrap(async (req, res) => {
  const events = await AdminAudit.find().select('-details').sort({ createdAt: -1 }).limit(100).lean();
  res.json({ success: true, events });
}));

// ============================================================
// ADMIN PAYMENT REVIEW — MONGODB ATLAS TRANSACTION
// ============================================================
app.get('/api/admin/payment-requests', adminAuth, wrap(async (req, res) => {
  const status = clean(req.query.status);
  if (status && !['Pending', 'Approved', 'Rejected'].includes(status)) bad(400, 'Invalid status.');
  const requests = await PaymentRequest.find(status ? { status } : {})
    .populate('customer', 'customerId name phone paidMonths customInstallment isActive schemeJoined')
    .sort({ createdAt: -1 }).lean();
  res.json({ success: true, requests, paymentRequests: requests });
}));
app.get('/api/admin/pending-payments', adminAuth, wrap(async (_req, res) => {
  const requests = await PaymentRequest.find({ status: 'Pending' })
    .populate('customer', 'customerId name phone paidMonths customInstallment')
    .sort({ createdAt: -1 }).lean();
  res.json({ success: true, requests, paymentRequests: requests });
}));
async function reviewPayment(req, res, action) {
  const id = req.params.id || req.body.paymentRequestId || req.body.requestId || req.body.id;
  if (!validId(id)) bad(400, 'Valid payment request ID required.');
  if (action === 'Rejected') {
    const paymentRequest = await PaymentRequest.findOneAndUpdate(
      { _id: id, status: 'Pending' },
      { $set: { status: 'Rejected', rejectionReason: safe(req.body.reason ?? req.body.rejectionReason, 300),
        reviewedAt: new Date(), reviewedBy: ADMIN_EMAIL } }, { new: true }
    );
    if (!paymentRequest) bad(409, 'Payment request already reviewed.');
    const c = await User.findById(paymentRequest.customer);
    if (c) await ensureSchemeFresh(c);
    return res.json({ success: true, status: 'Rejected', paymentRequest });
  }
  const session = await mongoose.startSession();
  let paymentRequest, customer;
  try {
    await session.withTransaction(async () => {
      const request = await PaymentRequest.findOne({ _id: id, status: 'Pending' }).session(session);
      if (!request) bad(409, 'Payment request already reviewed.');
      const c = await User.findById(request.customer).session(session);
      if (!c || c.isActive === false || !c.schemeJoined || c.schemeStatus !== 'Active' ||
          Number(request.schemeCycle || 1) !== schemeCycle(c)) bad(409, 'Customer scheme is inactive or payment belongs to an old scheme cycle.');
      if (Number(c.paidMonths || 0) + 1 !== request.monthNum) bad(409, 'Not the next unpaid installment.');
      if (Number(c.customInstallment) !== request.amount) bad(409, 'Installment amount mismatch.');
      if (await PaymentRequest.exists({ customer: c._id, schemeCycle: cycleFilter(schemeCycle(c)), monthNum: request.monthNum, status: 'Approved' }).session(session))
        bad(409, 'This month already has a verified UPI payment. Reapply it in the admin passbook instead of approving another.');
      if (await User.exists({ 'paymentHistory.transactionId': request.transactionId }).session(session))
        bad(409, 'UTR already verified.');
      if (await AdminAudit.exists({ action: 'CUSTOMER_DELETE', 'details.paymentRequests.transactionId': request.transactionId }).session(session))
        bad(409, 'UTR belongs to a deleted customer audit record.');
      const now = new Date();
      customer = await User.findOneAndUpdate(
        { _id: c._id, schemeJoined: true, schemeStatus: 'Active', isActive: { $ne: false }, paidMonths: request.monthNum - 1 },
        { $inc: { paidMonths: 1 }, $push: { paymentHistory: {
          monthNum: request.monthNum, amount: request.amount,
          transactionId: request.transactionId, paidAt: request.createdAt,
          verifiedAt: now, method: 'UPI'
        } }, $set: { isLaborFree: false } }, { new: true, session }
      );
      if (!customer) bad(409, 'Passbook changed. Refresh and retry.');
      paymentRequest = await PaymentRequest.findOneAndUpdate(
        { _id: id, status: 'Pending' },
        { $set: { status: 'Approved', passbookApplied: true, reviewedAt: now, reviewedBy: ADMIN_EMAIL } },
        { new: true, session }
      );
      if (!paymentRequest) bad(409, 'Payment request already reviewed.');
    });
  } finally { await session.endSession(); }
  res.json({ success: true, verified: true, status: 'Approved',
    paymentRequest, customer: publicCustomer(customer) });
}
for (const method of ['post', 'put']) {
  app[method]('/api/admin/payment-requests/:id/approve', adminAuth,
    wrap((req, res) => reviewPayment(req, res, 'Approved')));
  app[method]('/api/admin/payment-requests/:id/reject', adminAuth,
    wrap((req, res) => reviewPayment(req, res, 'Rejected')));
}
app.post('/api/admin/approve-payment', adminAuth, wrap((req, res) => reviewPayment(req, res, 'Approved')));
app.post('/api/admin/reject-payment', adminAuth, wrap((req, res) => reviewPayment(req, res, 'Rejected')));
app.post('/api/admin/verify-payment', adminAuth, wrap((req, res) =>
  reviewPayment(req, res, clean(req.body.action).toLowerCase() === 'reject' ? 'Rejected' : 'Approved')));

// Preview only: final making-charge waiver requires next calendar month after installment 12.
app.post('/api/customer/redeem-scheme', customerAuth, wrap(async (req, res) => {
  if (req.body.userId && String(req.body.userId) !== String(req.customer._id)) bad(403, 'Not your scheme.');
  const standardMakingCharges = Number(req.body.standardMakingCharges || 0);
  if (!Number.isFinite(standardMakingCharges) || standardMakingCharges < 0)
    bad(400, 'Invalid making charges.');
  const eligible = discountEligible(req.customer);
  const totalAccumulatedSavings = req.customer.paymentHistory.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  res.json({
    success: true, message: eligible ? 'Eligible subject to store verification and scheme terms.' : 'Not yet eligible.',
    redemptionDetails: {
      customerId: req.customer.customerId, customerName: req.customer.name,
      totalAccumulatedSavings, standardMakingCharges,
      makingChargesDiscountPercentage: eligible ? 100 : 0,
      finalMakingChargesToPay: eligible ? 0 : standardMakingCharges,
      eligible, goldOnly: true, previewOnly: true
    }
  });
}));

// ============================================================
// STORE UPI SETTINGS & WHATSAPP REMINDERS
// ============================================================
// ============================================================
// FIVE-DAY DEADLINE: ADMIN REVIEW / RESUME / REFUND
// ============================================================
app.get('/api/admin/scheme-alerts', adminAuth, wrap(async (_req, res) => {
  await sweepOverdueSchemes();
  const customers = await User.find({ schemeStatus: { $in: ['Suspended', 'RefundPending'] } })
    .select('-password').sort({ schemeSuspendedAt: -1 }).lean();
  const alerts = await Promise.all(customers.map(async c => ({
    ...publicCustomer(c), refundQuote: await refundQuote(c)
  })));
  res.json({ success: true, alerts, count: alerts.length });
}));

app.post('/api/admin/scheme/:id/resume', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id)) bad(400, 'Invalid customer ID.');
  const reason = safe(req.body.reason, 400);
  const customerExplanation = safe(req.body.customerExplanation, 400);
  if (reason.length < 10 || customerExplanation.length < 5)
    bad(400, 'Record the customer explanation (5+ characters) and admin decision reason (10+ characters).');
  const nextDueMonth = shiftMonth(istDate().slice(0, 7), 1);
  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      const current = await User.findById(req.params.id).session(session);
      if (!current || current.schemeStatus !== 'Suspended') bad(409, 'Only suspended schemes can be resumed.');
      const firstDueMonth = shiftMonth(nextDueMonth, -Number(current.paidMonths || 0));
      updated = await User.findOneAndUpdate({ _id: current._id, schemeStatus: 'Suspended' },
        { $set: { schemeStatus: 'Active', schemeFirstDueMonth: firstDueMonth,
          schemeScheduleVersion: 2, schemeAnchorDay: schemeAnchorDay(current),
          schemeAdminDecision: `Resumed: ${reason}`, schemeCustomerReason: customerExplanation,
          schemeSuspendedAt: null, schemeSuspendedDueMonth: '', schemeSuspendedDueDate: '' } }, { new: true, session });
      if (!updated) bad(409, 'Scheme status changed. Refresh and retry.');
      await AdminAudit.create([{ action: 'SCHEME_RESUME', customerRef: current._id,
        customerId: current.customerId, reason, details: { customerExplanation, nextDueMonth,
          nextDueDate: dueDateInMonth(nextDueMonth, schemeAnchorDay(current)),
          previousDueMonth: current.schemeSuspendedDueMonth, cycle: schemeCycle(current) } }], { session });
    });
  } finally { await session.endSession(); }
  const nextDueDate = dueDateInMonth(nextDueMonth, schemeAnchorDay(updated));
  res.json({ success: true, customer: publicCustomer(updated), nextDueMonth, nextDueDate,
    message: `Scheme resumed. Next installment opens ${nextDueDate}, last day ${addDaysISO(nextDueDate, 4)} (IST).` });
}));

app.post('/api/admin/scheme/:id/start-refund', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id)) bad(400, 'Invalid customer ID.');
  const reason = safe(req.body.reason, 400);
  const customerExplanation = safe(req.body.customerExplanation, 400);
  if (reason.length < 10) bad(400, 'Enter admin decision reason (at least 10 characters).');
  const session = await mongoose.startSession();
  let updated, quote;
  try {
    await session.withTransaction(async () => {
      const c = await User.findById(req.params.id).session(session);
      if (!c || c.schemeStatus !== 'Suspended') bad(409, 'Only suspended schemes can enter refund review.');
      // Any pending UPI must be resolved before refund so funds cannot be omitted.
      const pending = await PaymentRequest.exists({ customer: c._id,
        schemeCycle: cycleFilter(schemeCycle(c)), status: 'Pending' }).session(session);
      if (pending) bad(409, 'Review pending UPI payments first. Cannot start refund with unresolved UPI.');
      const approved = await PaymentRequest.find({ customer: c._id,
        schemeCycle: cycleFilter(schemeCycle(c)), status: 'Approved' }).session(session);
      quote = refundQuoteFromLedger(c, approved);
      if (Number(req.body.confirmedAmount) !== quote.total)
        bad(409, `Refund amount mismatch. Confirm ₹${quote.total} after checking receipts.`);
      updated = await User.findOneAndUpdate({ _id: c._id, schemeStatus: 'Suspended' },
        { $set: { schemeStatus: 'RefundPending', schemeRefundAmount: quote.total,
          schemeAdminDecision: `Refund initiated: ${reason}`, schemeCustomerReason: customerExplanation } },
        { new: true, session });
      if (!updated) bad(409, 'Scheme changed. Refresh and retry.');
      await AdminAudit.create([{ action: 'SCHEME_REFUND_INITIATED', customerRef: c._id,
        customerId: c.customerId, reason, details: { quote, customerExplanation, cycle: schemeCycle(c) } }], { session });
    });
  } finally { await session.endSession(); }
  res.json({ success: true, customer: publicCustomer(updated), refundQuote: quote,
    message: 'Refund review started. NO money was transferred automatically.' });
}));

app.post('/api/admin/scheme/:id/complete-refund', adminAuth, wrap(async (req, res) => {
  if (!validId(req.params.id)) bad(400, 'Invalid customer ID.');
  const reference = safe(req.body.refundReference, 100);
  const reason = safe(req.body.reason, 300);
  if (req.body.confirmTransfer !== true || reference.length < 6 || reason.length < 5)
    bad(400, 'Confirm actual refund transfer, enter reference (6+ characters) and reason.');
  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      const c = await User.findById(req.params.id).session(session);
      if (!c || c.schemeStatus !== 'RefundPending') bad(409, 'Scheme is not awaiting refund completion.');
      if (Number(req.body.confirmedAmount) !== Number(c.schemeRefundAmount))
        bad(400, 'Confirmed refund amount must match approved refund amount.');
      const pending = await PaymentRequest.exists({ customer: c._id,
        schemeCycle: cycleFilter(schemeCycle(c)), status: 'Pending' }).session(session);
      if (pending) bad(409, 'Resolve pending UPI before completing refund.');
      const snapshot = { cycle: schemeCycle(c), refundAmount: c.schemeRefundAmount,
        refundReference: reference, paidMonths: c.paidMonths,
        paymentHistory: c.paymentHistory.map(p => p.toObject()) };
      updated = await User.findOneAndUpdate({ _id: c._id, schemeStatus: 'RefundPending' },
        { $set: { schemeStatus: 'Refunded', schemeJoined: false, paidMonths: 0,
          paymentHistory: [], schemeFirstDueMonth: '', isLaborFree: false,
          schemeRefundReference: reference, schemeRefundedAt: new Date(),
          schemeAdminDecision: `Refund completed: ${reason}` } }, { new: true, session });
      if (!updated) bad(409, 'Scheme changed. Refresh and retry.');
      await AdminAudit.create([{ action: 'SCHEME_REFUND_COMPLETED', customerRef: c._id,
        customerId: c.customerId, reason, details: snapshot }], { session });
    });
  } finally { await session.endSession(); }
  res.json({ success: true, customer: publicCustomer(updated),
    message: 'Refund recorded. Customer can join a NEW scheme; old UPI records remain archived.' });
}));

app.get('/api/store/settings', wrap(async (_req, res) => {
  const settings = await StoreSettings.findByIdAndUpdate(
    'store_config', { $setOnInsert: { merchantName: 'Rahul Jewellers' } },
    { upsert: true, new: true }
  );
  res.json({ success: true, settings });
}));
app.put('/api/store/settings', adminAuth, wrap(async (req, res) => {
  const upiId = clean(req.body.upiId), merchantName = safe(req.body.merchantName, 100);
  if (!upiId || !merchantName || !/^[\w.\-]+@[\w.\-]+$/.test(upiId))
    bad(400, 'Valid UPI ID and merchant name required.');
  const qrCodeUrl = req.body.qrCodeUrl;
  if (qrCodeUrl !== undefined && qrCodeUrl &&
    !/^(data:image\/(?:png|jpeg|webp);base64,|https:\/\/)/i.test(qrCodeUrl))
    bad(400, 'Invalid QR image.');
  const settings = await StoreSettings.findByIdAndUpdate(
    'store_config',
    { $set: { upiId, merchantName, ...(qrCodeUrl !== undefined ? { qrCodeUrl } : {}) } },
    { upsert: true, new: true }
  );
  res.json({ success: true, settings });
}));
app.post('/api/admin/send-whatsapp-reminder', adminAuth, wrap(async (req, res) => {
  const c = await User.findOne({ customerId: clean(req.body.customerId) });
  if (!c || !c.schemeJoined || c.schemeStatus !== 'Active') bad(404, 'Active Gold Scheme subscriber not found.');
  if (Number(c.paidMonths || 0) >= 12) bad(409, 'All installments completed.');
  const month = Number(c.paidMonths || 0) + 1;
  const deadline = schemeDeadlineFor(c);
  const message = `नमस्ते ${c.name} जी,\n\nRahul Jewellers Sheoganj Gold Savings Scheme रिमाइंडर।\nCustomer ID: ${c.customerId}\nकिस्त: ${month}/12\nराशि: ₹${Number(c.customInstallment).toLocaleString('en-IN')}\nकिस्त शुरू: ${deadline.dueDate}\nअंतिम तारीख: ${deadline.graceEndDate}\n\n5 दिन में किस्त न भरने पर स्कीम सस्पेंड होगी। एडमिन से बात करके ही Resume हो सकेगी।\nधन्यवाद!`;
  res.json({ success: true, url: `https://wa.me/91${c.phone}?text=${encodeURIComponent(message)}` });
}));

// ============================================================
// MANUAL ADMIN-PUBLISHED 22K GOLD RATE (NOT AN MCX LIVE FEED)
// ============================================================
const goldClients = new Set();
function goldPayload(rate) {
  return {
    success: true, type: 'gold', enabled: Boolean(rate?.enabled),
    carat: '22K', priceInrPerGram: Number(rate?.priceInrPerGram || 0),
    source: 'manual', connected: Boolean(rate?.enabled),
    timestamp: rate?.updatedAt ? new Date(rate.updatedAt).getTime() : Date.now(),
    goldLastUpdated: rate?.updatedAt ? new Date(rate.updatedAt).getTime() : null
  };
}
function broadcastGoldRate(rate) {
  const message = `data: ${JSON.stringify(goldPayload(rate))}\n\n`;
  for (const client of goldClients) {
    try { client.write(message); } catch { goldClients.delete(client); }
  }
}
app.get('/api/gold-rate', wrap(async (_req, res) => {
  res.json(goldPayload(await GoldRate.findById('published_gold_rate').lean()));
}));
app.put('/api/admin/gold-rate', adminAuth, wrap(async (req, res) => {
  if (typeof req.body.enabled !== 'boolean') bad(400, 'enabled must be true or false.');
  const price = Number(req.body.priceInrPerGram);
  if (!Number.isFinite(price) || price < 0 || (req.body.enabled && price <= 0))
    bad(400, 'Enter a valid rate in INR per gram.');
  const goldRate = await GoldRate.findByIdAndUpdate(
    'published_gold_rate',
    { $set: { enabled: req.body.enabled, priceInrPerGram: price, carat: '22K', updatedBy: ADMIN_EMAIL } },
    { new: true, upsert: true, runValidators: true }
  );
  broadcastGoldRate(goldRate);
  res.json({ success: true, goldRate, rate: goldRate });
}));
app.get('/api/gold-rate/stream', wrap(async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  goldClients.add(res);
  const rate = await GoldRate.findById('published_gold_rate').lean();
  res.write(`data: ${JSON.stringify(goldPayload(rate))}\n\n`);
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 15000);
  req.on('close', () => { clearInterval(heartbeat); goldClients.delete(res); });
}));

// ============================================================
// AI SUPPORT CHAT (OPTIONAL)
// ============================================================
app.post('/api/support/chat', wrap(async (req, res) => {
  const message = safe(req.body.message, 1500);
  if (!message) bad(400, 'Message required.');
  if (!ai) bad(503, 'Support chat is temporarily unavailable.');
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    contents: message,
    config: {
      systemInstruction: `You are the Hindi-first assistant for Rahul Jewellers Sheoganj, Rajasthan. The showroom sells Gold and Silver jewellery. The 12+1 savings scheme is GOLD ONLY. Customers pay 12 monthly installments, and in the following month eligible customers get 100% off labour/making charges on gold jewellery, subject to terms. There is NO free 13th installment, free extra gold, or silver savings scheme. UPI installment submissions remain Pending until admin verifies. Never claim a manually entered gold rate is a live market rate.`
    }
  });
  res.json({ success: true, reply: response.text || 'Please contact Rahul Jewellers Sheoganj.' });
}));

// Legacy /api/schemes endpoints are intentionally disabled: the original
// Scheme.js exported an Express router instead of a Mongoose model, and
// its payment endpoint could advance due dates without UPI verification.
app.use('/api/schemes', (_req, res) => res.status(410).json({
  success: false, message: 'Legacy scheme routes disabled. Use verified customer/admin payment APIs.'
}));

app.use((err, _req, res, _next) => {
  if (err instanceof mongoose.Error.ValidationError)
    return res.status(400).json({ success: false, message: err.message });
  if (err?.code === 11000)
    return res.status(409).json({ success: false,
      message: 'Duplicate mobile, Customer ID, UTR or pending installment.' });
  if (err?.status) return res.status(err.status).json({ success: false, message: err.message });
  console.error('Backend error:', err);
  res.status(500).json({ success: false, message: 'Server error. Please try again.' });
});

mongoose.connect(MONGO_URI).then(async () => {
  // Existing old passbook accounts have a startDate even when paidMonths is zero.
  // New independent customer accounts use startDate='', so they remain unjoined.
  await User.updateMany(
    { schemeJoined: { $exists: false },
      $or: [{ paidMonths: { $gt: 0 } }, { startDate: { $type: 'string', $ne: '' } }] },
    { $set: { schemeJoined: true } }
  );
  // One-time safe migration: existing members get their NEXT unpaid installment
  // due in the configured go-live month, instead of being cancelled retroactively.
  await User.updateMany({ schemeJoined: true, schemeStatus: { $exists: false } },
    { $set: { schemeStatus: 'Active' } });
  await User.updateMany({ schemeJoined: false, schemeStatus: { $exists: false } },
    { $set: { schemeStatus: 'NotJoined' } });
  const legacy = await User.find({ schemeJoined: true,
    $or: [{ schemeFirstDueMonth: { $exists: false } }, { schemeFirstDueMonth: '' }] })
    .select('_id paidMonths');
  for (const c of legacy) {
    await User.updateOne({ _id: c._id, $or: [
      { schemeFirstDueMonth: { $exists: false } }, { schemeFirstDueMonth: '' }] },
    { $set: { schemeFirstDueMonth: shiftMonth(SCHEME_DEADLINE_START_MONTH, -Number(c.paidMonths || 0)) } });
  }
  console.log('Legacy scheme deadline protection month:', SCHEME_DEADLINE_START_MONTH);
  console.log('New scheme: anchor day is joining day; five calendar dates including start date.');
  await Promise.all([User.init(), PaymentRequest.init()]);
  await sweepOverdueSchemes();
  const schemeSweepTimer = setInterval(() => {
    sweepOverdueSchemes().catch(err => console.error('Scheme sweep failed:', err));
  }, 5 * 60 * 1000);
  schemeSweepTimer.unref?.();
  app.listen(PORT, '0.0.0.0', () => console.log(`Rahul Jewellers backend listening on ${PORT}`));
}).catch(err => {
  console.error('MongoDB startup error:', err);
  process.exitCode = 1;
});
