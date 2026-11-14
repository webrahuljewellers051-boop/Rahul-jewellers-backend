
 // Rahul Jewellers Sheoganj — Backend server.js
// Required environment variables:
// MONGO_URI, JWT_SECRET, ADMIN_EMAIL, RESEND_API_KEY,
// RESEND_FROM, CORS_ORIGINS
// Optional: PORT, GEMINI_API_KEY, GEMINI_MODEL

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { Resend } from 'resend';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import {
  randomInt,
  randomBytes,
  scrypt as scryptCallback,
  createHash,
  timingSafeEqual
} from 'node:crypto';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;

const ADMIN_EMAIL = (
  process.env.ADMIN_EMAIL ||
  'web.rahuljewellers051@gmail.com'
).trim().toLowerCase();

const RESEND_FROM =
  process.env.RESEND_FROM || 'onboarding@resend.dev';

if (!MONGO_URI) {
  throw new Error('MONGO_URI is required.');
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'Set a strong JWT_SECRET of at least 32 characters.'
  );
}

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    })
  : null;

const scrypt = promisify(scryptCallback);

// Accept both new CORS_ORIGINS and existing URL variables.
const allowedOrigins = new Set(
  [
    process.env.CORS_ORIGINS,
    process.env.CLIENT_ORIGIN,
    process.env.ADMIN_ORIGIN,
    process.env.ADMIN_URL,
    process.env.CUSTOMER_URL
  ]
    .filter(Boolean)
    .flatMap(value => value.split(','))
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins.has(origin) ||
        (
          process.env.NODE_ENV !== 'production' &&
          /^http:\/\/localhost(?::\d+)?$/.test(origin)
        )
      ) {
        return callback(null, true);
      }

      return callback(
        new Error('Origin not allowed; configure CORS_ORIGINS.')
      );
    },
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'ngrok-skip-browser-warning'
    ],
    methods: [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS'
    ]
  })
);

app.use(express.json({ limit: '15mb' }));
app.use(
  express.urlencoded({
    extended: true,
    limit: '15mb'
  })
);
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please try again later.'
  }
});

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (status, message) => {
  throw new ApiError(status, message);
};

const wrap = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const clean = value => String(value ?? '').trim();

const safe = (value, limit = 300) =>
  clean(value).slice(0, limit);

const validId = value => mongoose.isValidObjectId(value);

const validPhone = value =>
  /^[6-9]\d{9}$/.test(value);

const validAmount = value =>
  Number.isFinite(value) &&
  value >= 1000 &&
  value <= 1000000;

const escapeRegex = value =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function istParts(date, fields) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      ...fields
    })
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
}

function istDate(date = new Date()) {
  const parts = istParts(date, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function istMonth(date = new Date()) {
  const parts = istParts(date, {
    year: 'numeric',
    month: '2-digit'
  });

  return Number(parts.year) * 12 + Number(parts.month);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value <= istDate()
  );
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');

  const hash = await scrypt(password, salt, 64);

  return `scrypt$${salt}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') {
    return false;
  }

  if (stored.startsWith('scrypt$')) {
    const [, salt, hex] = stored.split('$');

    if (
      !/^[a-f0-9]{32}$/i.test(salt || '') ||
      !/^[a-f0-9]{128}$/i.test(hex || '')
    ) {
      return false;
    }

    return timingSafeEqual(
      await scrypt(password, salt, 64),
      Buffer.from(hex, 'hex')
    );
  }

  // Upgrade legacy plaintext passwords after successful login.
  const first = Buffer.from(password);
  const second = Buffer.from(stored);

  return (
    first.length === second.length &&
    timingSafeEqual(first, second)
  );
}

// ============================================================
// DATABASE MODELS
// ============================================================

const StoreSettings =
  mongoose.models.StoreSettings ||
  mongoose.model(
    'StoreSettings',
    new mongoose.Schema(
      {
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
        }
      },
      { timestamps: true }
    )
  );

const paymentHistorySchema = new mongoose.Schema(
  {
    monthNum: {
      type: Number,
      required: true,
      min: 1,
      max: 12
    },
    amount: {
      type: Number,
      required: true
    },
    transactionId: {
      type: String,
      required: true
    },
    paidAt: {
      type: Date,
      default: Date.now
    },
    verifiedAt: {
      type: Date
    },
    method: {
      type: String,
      default: 'Manual'
    }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    customerId: {
      type: String,
      required: true,
      unique: true
    },
    name: {
      type: String,
      required: true
    },
    dob: {
      type: String,
      default: ''
    },
    phone: {
      type: String,
      required: true,
      unique: true
    },
    email: {
      type: String,
      default: ''
    },
    password: {
      type: String,
      required: true,
      select: false
    },
    address: {
      type: String,
      default: ''
    },
    schemeJoined: {
      type: Boolean,
      default: false
    },
    schemeJoinedAt: {
      type: Date
    },
    customInstallment: {
      type: Number,
      default: 10000
    },
    paidMonths: {
      type: Number,
      default: 0,
      min: 0,
      max: 12
    },
    isLaborFree: {
      type: Boolean,
      default: false
    },
    startDate: {
      type: String,
      default: ''
    },
    finalDueDate: {
      type: String,
      default: ''
    },
    isActive: {
      type: Boolean,
      default: true
    },
    paymentHistory: {
      type: [paymentHistorySchema],
      default: []
    },
    cart: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Product'
        },
        quantity: {
          type: Number,
          default: 1
        }
      }
    ],
    wishlist: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
      }
    ]
  },
  { timestamps: true }
);

const User =
  mongoose.models.User ||
  mongoose.model('User', userSchema);

const Category =
  mongoose.models.Category ||
  mongoose.model(
    'Category',
    new mongoose.Schema(
      {
        name: {
          type: String,
          required: true
        },
        description: {
          type: String,
          default: ''
        },
        parentCategory: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Category',
          default: null
        }
      },
      { timestamps: true }
    )
  );

const Product =
  mongoose.models.Product ||
  mongoose.model(
    'Product',
    new mongoose.Schema(
      {
        title: {
          type: String,
          required: true
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
        weight: {
          type: String,
          required: true
        },
        price: {
          type: Number,
          default: 0
        },
        imageUrl: {
          type: String,
          required: true
        }
      },
      { timestamps: true }
    )
  );

const paymentRequestSchema = new mongoose.Schema(
  {
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
    monthNum: {
      type: Number,
      required: true,
      min: 1,
      max: 12
    },
    amount: {
      type: Number,
      required: true
    },
    transactionId: {
      type: String,
      required: true,
      unique: true
    },
    status: {
      type: String,
      enum: ['Pending', 'Approved', 'Rejected'],
      default: 'Pending',
      index: true
    },
    reviewedAt: Date,
    reviewedBy: String,
    rejectionReason: {
      type: String,
      default: ''
    }
  },
  { timestamps: true }
);

paymentRequestSchema.index(
  {
    customer: 1,
    monthNum: 1
  },
  {
    unique: true,
    partialFilterExpression: {
      status: 'Pending'
    }
  }
);

const PaymentRequest =
  mongoose.models.PaymentRequest ||
  mongoose.model('PaymentRequest', paymentRequestSchema);

const GoldRate =
  mongoose.models.GoldRate ||
  mongoose.model(
    'GoldRate',
    new mongoose.Schema(
      {
        _id: {
          type: String,
          default: 'published_gold_rate'
        },
        enabled: {
          type: Boolean,
          default: false
        },
        carat: {
          type: String,
          default: '22K'
        },
        priceInrPerGram: {
          type: Number,
          default: 0
        },
        updatedBy: {
          type: String,
          default: 'admin'
        }
      },
      { timestamps: true }
    )
  );

// ============================================================
// CUSTOMER / AUTH HELPERS
// ============================================================

function discountEligible(customer) {
  if (
    !customer ||
    !customer.schemeJoined ||
    Number(customer.paidMonths || 0) < 12
  ) {
    return false;
  }

  const finalPayment = (
    customer.paymentHistory || []
  ).find(payment => Number(payment.monthNum) === 12);

  const date =
    finalPayment?.verifiedAt ||
    finalPayment?.paidAt;

  return Boolean(
    date &&
    istMonth(new Date()) > istMonth(new Date(date))
  );
}

function publicCustomer(customer) {
  if (!customer) {
    return null;
  }

  const object =
    typeof customer.toObject === 'function'
      ? customer.toObject()
      : { ...customer };

  delete object.password;
  delete object.__v;

  object.eligibleForMakingChargeDiscount =
    discountEligible(object);

  object.isLaborFree =
    object.eligibleForMakingChargeDiscount;

  return object;
}

function customerToken(customer) {
  return jwt.sign(
    {
      sub: String(customer._id),
      role: 'customer',
      type: 'customer'
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function readToken(req, cookieName) {
  const authorization = req.headers.authorization;

  return (
    typeof authorization === 'string' &&
    authorization.startsWith('Bearer ')
  )
    ? authorization.slice(7).trim()
    : req.cookies?.[cookieName];
}

function adminAuth(req, res, next) {
  try {
    const token = readToken(req, 'admin_token');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Admin login required.'
      });
    }

    const payload = jwt.verify(token, JWT_SECRET);

    if (
      !(
        payload.type === 'admin' ||
        payload.role === 'admin' ||
        (
          !payload.type &&
          !payload.role &&
          clean(payload.email).toLowerCase() === ADMIN_EMAIL
        )
      )
    ) {
      return res.status(403).json({
        success: false,
        message: 'Admin access only.'
      });
    }

    next();
  } catch {
    res.status(401).json({
      success: false,
      message: 'Admin session expired.'
    });
  }
}

const customerAuth = wrap(async (req, res, next) => {
  const token = readToken(req, 'customer_token');

  if (!token) {
    bad(401, 'Customer login required.');
  }

  let payload;

  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    bad(401, 'Customer session expired.');
  }

  if (
    payload.type !== 'customer' &&
    payload.role !== 'customer'
  ) {
    bad(403, 'Customer access only.');
  }

  if (!validId(payload.sub)) {
    bad(401, 'Invalid customer token.');
  }

  const customer = await User.findById(payload.sub);

  if (!customer) {
    bad(401, 'Customer account not found.');
  }

  if (customer.isActive === false) {
    bad(403, 'Account deactivated.');
  }

  req.customer = customer;
  next();
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (_req, res) => {
  res.send('Rahul Jewellers Sheoganj Backend is Running');
});

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    database:
      mongoose.connection.readyState === 1
        ? 'connected'
        : 'disconnected'
  });
});

// ============================================================
// ADMIN EMAIL OTP
// ============================================================

const otpStorage = new Map();

app.post(
  '/api/client/send-email-otp',
  loginLimiter,
  wrap(async (req, res) => {
    const email = clean(req.body.email).toLowerCase();

    if (email !== ADMIN_EMAIL) {
      bad(403, 'Unauthorized admin email.');
    }

    if (!resend) {
      bad(503, 'RESEND_API_KEY is not configured.');
    }

    const otp = String(randomInt(100000, 1000000));

    const result = await resend.emails.send({
      from: RESEND_FROM,
      to: [ADMIN_EMAIL],
      subject: 'Rahul Jewellers Admin Login OTP',
      html: `
        <p>
          Your admin verification code:
          <strong>${otp}</strong>
          (valid for 5 minutes).
        </p>
      `
    });

    if (result.error) {
      bad(
        502,
        'OTP email could not be sent. Check verified sender.'
      );
    }

    otpStorage.set(email, {
      hash: createHash('sha256')
        .update(otp)
        .digest('hex'),
      expires: Date.now() + 300000,
      attempts: 0
    });

    res.json({
      success: true,
      message: 'Admin OTP sent.'
    });
  })
);

app.post(
  '/api/client/verify-email-otp',
  loginLimiter,
  wrap(async (req, res) => {
    const email = clean(req.body.email).toLowerCase();
    const otp = clean(req.body.otp);
    const record = otpStorage.get(email);

    if (
      email !== ADMIN_EMAIL ||
      !record ||
      record.expires < Date.now() ||
      record.attempts >= 5
    ) {
      bad(401, 'OTP expired or invalid.');
    }

    record.attempts++;

    const enteredHash = createHash('sha256')
      .update(otp)
      .digest();

    if (
      !/^\d{6}$/.test(otp) ||
      !timingSafeEqual(
        enteredHash,
        Buffer.from(record.hash, 'hex')
      )
    ) {
      bad(401, 'Incorrect OTP.');
    }

    otpStorage.delete(email);

    const token = jwt.sign(
      {
        sub: 'admin',
        type: 'admin',
        role: 'admin',
        email
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      message: 'Admin verified.'
    });
  })
);

app.get(
  '/api/client/admin-session',
  adminAuth,
  (_req, res) => {
    res.json({
      success: true,
      message: 'Session active.'
    });
  }
);

app.post('/api/client/admin-logout', (_req, res) => {
  res.clearCookie('admin_token', {
    httpOnly: true,
    secure: true,
    sameSite: 'none'
  });

  res.json({ success: true });
});

// ============================================================
// PRODUCTS — GOLD AND SILVER
// ============================================================

app.get(
  '/api/products',
  wrap(async (_req, res) => {
    const products = await Product.find()
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      products
    });
  })
);

app.post(
  '/api/admin/products',
  adminAuth,
  wrap(async (req, res) => {
    const title = safe(req.body.title, 150);
    const category = safe(req.body.category, 60);
    const weight = safe(req.body.weight, 80);
    const imageUrl = clean(req.body.imageUrl);

    const price =
      req.body.price == null ||
      req.body.price === ''
        ? 0
        : Number(req.body.price);

    if (!title || !category || !weight) {
      bad(
        400,
        'Product name, category and weight are required.'
      );
    }

    if (!Number.isFinite(price) || price < 0) {
      bad(400, 'Invalid price.');
    }

    if (
      !/^(data:image\/(?:png|jpeg|webp|gif);base64,|https:\/\/)/i
        .test(imageUrl)
    ) {
      bad(400, 'Valid image is required.');
    }

    const categoryId = validId(req.body.categoryId)
      ? req.body.categoryId
      : null;

    const product = await Product.create({
      title,
      category,
      weight,
      imageUrl,
      price,
      categoryId
    });

    res.status(201).json({
      success: true,
      product
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

    const deleted = await Product.findByIdAndDelete(
      req.params.id
    );

    if (!deleted) {
      bad(404, 'Product not found.');
    }

    res.json({
      success: true,
      message: 'Product deleted.'
    });
  })
);

app.get(
  '/api/categories',
  wrap(async (_req, res) => {
    const categories = await Category.find()
      .populate('parentCategory')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      categories
    });
  })
);

app.post(
  '/api/admin/categories',
  adminAuth,
  wrap(async (req, res) => {
    const name = safe(req.body.name, 100);

    if (!name) {
      bad(400, 'Category name is required.');
    }

    const parentCategory = validId(
      req.body.parentCategory
    )
      ? req.body.parentCategory
      : null;

    if (
      parentCategory &&
      !await Category.exists({ _id: parentCategory })
    ) {
      bad(404, 'Parent category not found.');
    }

    const category = await Category.create({
      name,
      description: safe(req.body.description, 400),
      parentCategory
    });

    res.status(201).json({
      success: true,
      category
    });
  })
);

app.delete(
  '/api/admin/categories/:id',
  adminAuth,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) {
      bad(400, 'Invalid category ID.');
    }

    if (
      await Product.exists({
        categoryId: req.params.id
      })
    ) {
      bad(
        409,
        'Move products out of this category first.'
      );
    }

    if (
      await Category.exists({
        parentCategory: req.params.id
      })
    ) {
      bad(409, 'Delete subcategories first.');
    }

    const deleted = await Category.findByIdAndDelete(
      req.params.id
    );

    if (!deleted) {
      bad(404, 'Category not found.');
    }

    res.json({
      success: true,
      message: 'Category deleted.'
    });
  })
);

// ============================================================
// CUSTOMER REGISTRATION AND LOGIN
// ============================================================

async function createCustomer({
  name,
  dob = '',
  phone,
  address = '',
  password,
  schemeJoined = false,
  customInstallment = 10000,
  startDate = ''
}) {
  return User.create({
    customerId: `RJ${randomInt(100000000, 1000000000)}`,
    name,
    dob,
    phone,
    address,
    password: await hashPassword(password),
    schemeJoined,
    schemeJoinedAt: schemeJoined
      ? new Date()
      : undefined,
    customInstallment,
    startDate: schemeJoined
      ? (startDate || istDate())
      : '',
    paidMonths: 0,
    isLaborFree: false,
    isActive: true
  });
}

app.post(
  '/api/customer/register',
  loginLimiter,
  wrap(async (req, res) => {
    const name = safe(req.body.name, 100);
    const dob = clean(req.body.dob);
    const phone = clean(req.body.phone);
    const address = safe(req.body.address, 500);
    const password = String(req.body.password ?? '');

    if (
      !name ||
      !validPhone(phone) ||
      !validDate(dob)
    ) {
      bad(
        400,
        'Valid name, date of birth (YYYY-MM-DD) and Indian mobile are required.'
      );
    }

    if (
      password.length < 8 ||
      password.length > 128
    ) {
      bad(
        400,
        'Password must have 8–128 characters.'
      );
    }

    if (
      req.body.confirmPassword !== undefined &&
      req.body.confirmPassword !== password
    ) {
      bad(400, 'Passwords do not match.');
    }

    if (await User.exists({ phone })) {
      bad(409, 'Mobile number already registered.');
    }

    const customer = await createCustomer({
      name,
      dob,
      phone,
      address,
      password
    });

    res.status(201).json({
      success: true,
      customer: publicCustomer(customer),
      token: customerToken(customer)
    });
  })
);

app.post(
  '/api/customer/login',
  loginLimiter,
  wrap(async (req, res) => {
    const identifier = clean(req.body.identifier);
    const password = String(req.body.password ?? '');

    if (!identifier || !password) {
      bad(
        400,
        'Customer ID/mobile and password required.'
      );
    }

    const customer = await User.findOne({
      $or: [
        {
          customerId: {
            $regex: `^${escapeRegex(identifier)}$`,
            $options: 'i'
          }
        },
        {
          phone: identifier
        }
      ]
    }).select('+password');

    if (
      !customer ||
      !await verifyPassword(
        password,
        customer.password
      )
    ) {
      bad(401, 'Incorrect login details.');
    }

    if (customer.isActive === false) {
      bad(
        403,
        'Account deactivated. Contact Rahul Jewellers Sheoganj.'
      );
    }

    if (!customer.password.startsWith('scrypt$')) {
      customer.password = await hashPassword(password);
      await customer.save();
    }

    res.json({
      success: true,
      customer: publicCustomer(customer),
      token: customerToken(customer)
    });
  })
);

app.get(
  '/api/customer/profile/:id',
  customerAuth,
  wrap(async (req, res) => {
    if (
      String(req.customer._id) !== req.params.id
    ) {
      bad(403, 'Access denied to this profile.');
    }

    res.json({
      success: true,
      customer: publicCustomer(req.customer)
    });
  })
);

async function updateCustomerProfile(req, res) {
  const customer = req.customer;

  const id =
    req.params.id ||
    req.body.userId;

  if (
    id &&
    String(id) !== String(customer._id)
  ) {
    bad(403, 'You can only edit your account.');
  }

  if (req.body.name !== undefined) {
    const name = safe(req.body.name, 100);

    if (!name) {
      bad(400, 'Name cannot be empty.');
    }

    customer.name = name;
  }

  if (req.body.address !== undefined) {
    customer.address = safe(req.body.address, 500);
  }

  if (req.body.dob !== undefined) {
    if (!validDate(clean(req.body.dob))) {
      bad(400, 'Invalid date of birth.');
    }

    customer.dob = clean(req.body.dob);
  }

  if (
    req.body.phone !== undefined &&
    clean(req.body.phone) !== customer.phone
  ) {
    const phone = clean(req.body.phone);

    if (!validPhone(phone)) {
      bad(400, 'Invalid Indian mobile.');
    }

    if (
      await User.exists({
        phone,
        _id: { $ne: customer._id }
      })
    ) {
      bad(409, 'Mobile already registered.');
    }

    customer.phone = phone;
  }

  if (req.body.password) {
    const newPassword = String(req.body.password);
    const currentPassword = String(
      req.body.currentPassword || ''
    );

    if (
      newPassword.length < 8 ||
      newPassword.length > 128
    ) {
      bad(
        400,
        'New password must have 8–128 characters.'
      );
    }

    if (!currentPassword) {
      bad(
        400,
        'Current password required to change password.'
      );
    }

    const existing = await User.findById(
      customer._id
    ).select('+password');

    if (
      !existing ||
      !await verifyPassword(
        currentPassword,
        existing.password
      )
    ) {
      bad(401, 'Current password incorrect.');
    }

    customer.password = await hashPassword(newPassword);
  }

  await customer.save();

  const result = publicCustomer(customer);

  res.json({
    success: true,
    customer: result,
    user: result
  });
}

app.put(
  '/api/customer/update-profile/:id',
  customerAuth,
  wrap(updateCustomerProfile)
);

app.put(
  '/api/customer/settings/update',
  customerAuth,
  wrap(updateCustomerProfile)
);

app.post(
  '/api/customer/wishlist/toggle',
  customerAuth,
  wrap(async (req, res) => {
    if (
      req.body.userId &&
      String(req.body.userId) !==
        String(req.customer._id)
    ) {
      bad(403, 'Access denied.');
    }

    const productId = req.body.productId;

    if (
      !validId(productId) ||
      !await Product.exists({ _id: productId })
    ) {
      bad(404, 'Product not found.');
    }

    if (
      req.customer.wishlist.some(
        id => String(id) === String(productId)
      )
    ) {
      req.customer.wishlist.pull(productId);
    } else {
      req.customer.wishlist.addToSet(productId);
    }

    await req.customer.save();

    const customer = publicCustomer(req.customer);

    res.json({
      success: true,
      customer,
      user: customer
    });
  })
);

// ============================================================
// GOLD-ONLY 12+1 SCHEME
// ============================================================

// Customer creates account first, then separately joins scheme.
// The chosen monthly installment amount is locked after joining.

app.post(
  '/api/customer/join-scheme',
  customerAuth,
  wrap(async (req, res) => {
    const amount = Number(
      req.body.amount ??
      req.body.customInstallment
    );

    if (!validAmount(amount)) {
      bad(
        400,
        'Monthly amount must be ₹1,000 to ₹10,00,000.'
      );
    }

    if (req.customer.schemeJoined) {
      bad(409, 'Already joined the Gold Scheme.');
    }

    const updated = await User.findOneAndUpdate(
      {
        _id: req.customer._id,
        schemeJoined: { $ne: true },
        paidMonths: 0
      },
      {
        $set: {
          schemeJoined: true,
          schemeJoinedAt: new Date(),
          customInstallment: amount,
          startDate: istDate(),
          isLaborFree: false
        }
      },
      { new: true }
    );

    if (!updated) {
      bad(
        409,
        'Scheme state changed. Refresh and try again.'
      );
    }

    res.json({
      success: true,
      customer: publicCustomer(updated),
      message: 'Gold Scheme joined.'
    });
  })
);

// ============================================================
// CUSTOMER UPI PAYMENT — PENDING UNTIL ADMIN APPROVAL
// ============================================================

app.post(
  '/api/customer/pay-installment',
  customerAuth,
  wrap(async (req, res) => {
    const customer = req.customer;

    if (
      req.body.userId &&
      String(req.body.userId) !==
        String(customer._id)
    ) {
      bad(403, 'Not your scheme.');
    }

    if (!customer.schemeJoined) {
      bad(409, 'Join Gold Scheme first.');
    }

    const monthNum = Number(req.body.monthNum);
    const amount = Number(req.body.amount);

    const transactionId = clean(
      req.body.transactionId ??
      req.body.utr
    ).toUpperCase();

    if (
      !Number.isInteger(monthNum) ||
      monthNum < 1 ||
      monthNum > 12
    ) {
      bad(400, 'Invalid month.');
    }

    if (
      monthNum !==
      Number(customer.paidMonths || 0) + 1
    ) {
      bad(
        409,
        'Only the next unpaid installment can be submitted.'
      );
    }

    if (
      amount !== Number(customer.customInstallment)
    ) {
      bad(
        400,
        'Amount must match your monthly installment.'
      );
    }

    if (!/^[A-Z0-9]{10,20}$/.test(transactionId)) {
      bad(
        400,
        'UTR must contain 10–20 letters/digits.'
      );
    }

    if (
      await User.exists({
        'paymentHistory.transactionId': transactionId
      })
    ) {
      bad(409, 'UTR already verified.');
    }

    if (
      await PaymentRequest.exists({
        customer: customer._id,
        monthNum,
        status: 'Pending'
      })
    ) {
      bad(
        409,
        'A payment for this month is already pending review.'
      );
    }

    const paymentRequest = await PaymentRequest.create({
      customer: customer._id,
      customerId: customer.customerId,
      monthNum,
      amount,
      transactionId
    });

    res.status(201).json({
      success: true,
      verified: false,
      status: 'Pending',
      message:
        'Submitted for admin verification. Your paid months have NOT increased yet.',
      paymentRequest,
      request: paymentRequest,
      customer: publicCustomer(customer)
    });
  })
);

app.get(
  '/api/customer/payment-requests',
  customerAuth,
  wrap(async (req, res) => {
    const requests = await PaymentRequest.find({
      customer: req.customer._id
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      requests,
      paymentRequests: requests
    });
  })
);

// ============================================================
// ADMIN CUSTOMER DIRECTORY
// ============================================================

app.get(
  '/api/admin/customers',
  adminAuth,
  wrap(async (_req, res) => {
    const customers = (
      await User.find()
        .select('-password')
        .sort({ createdAt: -1 })
        .lean()
    ).map(publicCustomer);

    res.json({
      success: true,
      customers,
      users: customers
    });
  })
);

app.post(
  '/api/admin/create-customer',
  adminAuth,
  wrap(async (req, res) => {
    const name = safe(req.body.name, 100);
    const phone = clean(req.body.phone);
    const dob = clean(req.body.dob);
    const address = safe(req.body.address, 500);
    const password = String(req.body.password ?? '');

    if (!name || !validPhone(phone)) {
      bad(
        400,
        'Valid name and Indian mobile required.'
      );
    }

    if (dob && !validDate(dob)) {
      bad(400, 'Invalid date of birth.');
    }

    if (
      password.length < 8 ||
      password.length > 128
    ) {
      bad(
        400,
        'Password must have 8–128 characters.'
      );
    }

    if (await User.exists({ phone })) {
      bad(409, 'Mobile already registered.');
    }

    const join =
      req.body.schemeJoined === true ||
      (
        req.body.schemeJoined !== false &&
        req.body.customInstallment != null &&
        Boolean(req.body.startDate)
      );

    const amount = Number(
      req.body.customInstallment ?? 10000
    );

    const startDate = clean(req.body.startDate);

    if (join && !validAmount(amount)) {
      bad(400, 'Invalid monthly installment.');
    }

    if (
      join &&
      startDate &&
      !validDate(startDate)
    ) {
      bad(400, 'Invalid start date.');
    }

    const customer = await createCustomer({
      name,
      phone,
      dob,
      address,
      password,
      schemeJoined: join,
      customInstallment: join ? amount : 10000,
      startDate: join
        ? startDate || istDate()
        : ''
    });

    res.status(201).json({
      success: true,
      customer: publicCustomer(customer)
    });
  })
);

app.put(
  '/api/admin/customer-status/:id',
  adminAuth,
  wrap(async (req, res) => {
    if (
      !validId(req.params.id) ||
      typeof req.body.isActive !== 'boolean'
    ) {
      bad(
        400,
        'Valid ID and isActive boolean required.'
      );
    }

    const customer = await User.findByIdAndUpdate(
      req.params.id,
      { isActive: req.body.isActive },
      { new: true }
    );

    if (!customer) {
      bad(404, 'Customer not found.');
    }

    res.json({
      success: true,
      customer: publicCustomer(customer)
    });
  })
);

app.delete(
  '/api/admin/delete-customer/:id',
  adminAuth,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) {
      bad(400, 'Invalid customer ID.');
    }

    const customer = await User.findById(
      req.params.id
    );

    if (!customer) {
      bad(404, 'Customer not found.');
    }

    if (
      Number(customer.paidMonths || 0) > 0 ||
      await PaymentRequest.exists({
        customer: customer._id
      })
    ) {
      bad(
        409,
        'Financial records exist. Deactivate this customer instead of deleting.'
      );
    }

    await User.deleteOne({
      _id: customer._id
    });

    res.json({
      success: true,
      message: 'Customer deleted.'
    });
  })
);

// ============================================================
// ADMIN MANUAL PASSBOOK
// ============================================================

app.post(
  '/api/admin/manual-passbook-update',
  adminAuth,
  wrap(async (req, res) => {
    const userId = req.body.userId;
    const monthNum = Number(req.body.monthNum);
    const action = clean(req.body.action).toUpperCase();

    if (
      !validId(userId) ||
      !Number.isInteger(monthNum) ||
      monthNum < 1 ||
      monthNum > 12 ||
      !['PAY', 'UNPAY'].includes(action)
    ) {
      bad(400, 'Invalid passbook action.');
    }

    const customer = await User.findById(userId);

    if (!customer) {
      bad(404, 'Customer not found.');
    }

    if (!customer.schemeJoined) {
      bad(
        409,
        'Customer has not joined Gold Scheme.'
      );
    }

    if (customer.isActive === false) {
      bad(403, 'Customer is deactivated.');
    }

    if (action === 'PAY') {
      if (
        monthNum !==
        Number(customer.paidMonths || 0) + 1
      ) {
        bad(
          409,
          'Only next unpaid month can be marked paid.'
        );
      }

      if (
        await PaymentRequest.exists({
          customer: customer._id,
          monthNum,
          status: 'Pending'
        })
      ) {
        bad(
          409,
          'UPI request pending. Approve/reject it first.'
        );
      }

      const now = new Date();

      const updated = await User.findOneAndUpdate(
        {
          _id: customer._id,
          paidMonths: monthNum - 1,
          schemeJoined: true
        },
        {
          $inc: {
            paidMonths: 1
          },
          $push: {
            paymentHistory: {
              monthNum,
              amount: customer.customInstallment,
              transactionId:
                `ADMIN_MANUAL_${Date.now()}_${randomInt(1000, 9999)}`,
              paidAt: now,
              verifiedAt: now,
              method: 'AdminManual'
            }
          },
          $set: {
            isLaborFree: false
          }
        },
        { new: true }
      );

      if (!updated) {
        bad(
          409,
          'Passbook changed. Refresh and retry.'
        );
      }

      return res.json({
        success: true,
        customer: publicCustomer(updated)
      });
    }

    if (
      monthNum !== Number(customer.paidMonths || 0)
    ) {
      bad(
        409,
        'Only latest paid month can be reversed.'
      );
    }

    if (
      await PaymentRequest.exists({
        customer: customer._id,
        monthNum,
        status: 'Approved'
      })
    ) {
      bad(
        409,
        'Approved UPI payment cannot be reversed here; use audited refund process.'
      );
    }

    const updated = await User.findOneAndUpdate(
      {
        _id: customer._id,
        paidMonths: monthNum
      },
      {
        $inc: {
          paidMonths: -1
        },
        $pull: {
          paymentHistory: { monthNum }
        },
        $set: {
          isLaborFree: false
        }
      },
      { new: true }
    );

    if (!updated) {
      bad(
        409,
        'Passbook changed. Refresh and retry.'
      );
    }

    res.json({
      success: true,
      customer: publicCustomer(updated)
    });
  })
);

// ============================================================
// ADMIN PAYMENT REVIEW
// ============================================================

app.get(
  '/api/admin/payment-requests',
  adminAuth,
  wrap(async (req, res) => {
    const status = clean(req.query.status);

    if (
      status &&
      !['Pending', 'Approved', 'Rejected'].includes(status)
    ) {
      bad(400, 'Invalid status.');
    }

    const requests = await PaymentRequest.find(
      status ? { status } : {}
    )
      .populate(
        'customer',
        'customerId name phone paidMonths customInstallment isActive schemeJoined'
      )
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      requests,
      paymentRequests: requests
    });
  })
);

app.get(
  '/api/admin/pending-payments',
  adminAuth,
  wrap(async (_req, res) => {
    const requests = await PaymentRequest.find({
      status: 'Pending'
    })
      .populate(
        'customer',
        'customerId name phone paidMonths customInstallment'
      )
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      requests,
      paymentRequests: requests
    });
  })
);

async function reviewPayment(req, res, action) {
  const id =
    req.params.id ||
    req.body.paymentRequestId ||
    req.body.requestId ||
    req.body.id;

  if (!validId(id)) {
    bad(400, 'Valid payment request ID required.');
  }

  if (action === 'Rejected') {
    const paymentRequest =
      await PaymentRequest.findOneAndUpdate(
        {
          _id: id,
          status: 'Pending'
        },
        {
          $set: {
            status: 'Rejected',
            rejectionReason: safe(
              req.body.reason ??
              req.body.rejectionReason,
              300
            ),
            reviewedAt: new Date(),
            reviewedBy: ADMIN_EMAIL
          }
        },
        { new: true }
      );

    if (!paymentRequest) {
      bad(
        409,
        'Payment request already reviewed.'
      );
    }

    return res.json({
      success: true,
      status: 'Rejected',
      paymentRequest
    });
  }

  const session = await mongoose.startSession();

  let paymentRequest;
  let customer;

  try {
    await session.withTransaction(async () => {
      const request = await PaymentRequest.findOne({
        _id: id,
        status: 'Pending'
      }).session(session);

      if (!request) {
        bad(
          409,
          'Payment request already reviewed.'
        );
      }

      const existingCustomer = await User.findById(
        request.customer
      ).session(session);

      if (
        !existingCustomer ||
        existingCustomer.isActive === false ||
        !existingCustomer.schemeJoined
      ) {
        bad(409, 'Customer not eligible.');
      }

      if (
        Number(existingCustomer.paidMonths || 0) + 1 !==
        request.monthNum
      ) {
        bad(
          409,
          'Not the next unpaid installment.'
        );
      }

      if (
        Number(existingCustomer.customInstallment) !==
        request.amount
      ) {
        bad(
          409,
          'Installment amount mismatch.'
        );
      }

      if (
        await User.exists({
          'paymentHistory.transactionId':
            request.transactionId
        }).session(session)
      ) {
        bad(409, 'UTR already verified.');
      }

      const now = new Date();

      customer = await User.findOneAndUpdate(
        {
          _id: existingCustomer._id,
          schemeJoined: true,
          isActive: { $ne: false },
          paidMonths: request.monthNum - 1
        },
        {
          $inc: {
            paidMonths: 1
          },
          $push: {
            paymentHistory: {
              monthNum: request.monthNum,
              amount: request.amount,
              transactionId: request.transactionId,
              paidAt: request.createdAt,
              verifiedAt: now,
              method: 'UPI'
            }
          },
          $set: {
            isLaborFree: false
          }
        },
        {
          new: true,
          session
        }
      );

      if (!customer) {
        bad(
          409,
          'Passbook changed. Refresh and retry.'
        );
      }

      paymentRequest =
        await PaymentRequest.findOneAndUpdate(
          {
            _id: id,
            status: 'Pending'
          },
          {
            $set: {
              status: 'Approved',
              reviewedAt: now,
              reviewedBy: ADMIN_EMAIL
            }
          },
          {
            new: true,
            session
          }
        );

      if (!paymentRequest) {
        bad(
          409,
          'Payment request already reviewed.'
        );
      }
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
  app[method](
    '/api/admin/payment-requests/:id/approve',
    adminAuth,
    wrap((req, res) =>
      reviewPayment(req, res, 'Approved')
    )
  );

  app[method](
    '/api/admin/payment-requests/:id/reject',
    adminAuth,
    wrap((req, res) =>
      reviewPayment(req, res, 'Rejected')
    )
  );
}

app.post(
  '/api/admin/approve-payment',
  adminAuth,
  wrap((req, res) =>
    reviewPayment(req, res, 'Approved')
  )
);

app.post(
  '/api/admin/reject-payment',
  adminAuth,
  wrap((req, res) =>
    reviewPayment(req, res, 'Rejected')
  )
);

app.post(
  '/api/admin/verify-payment',
  adminAuth,
  wrap((req, res) =>
    reviewPayment(
      req,
      res,
      clean(req.body.action).toLowerCase() === 'reject'
        ? 'Rejected'
        : 'Approved'
    )
  )
);

// ============================================================
// GOLD SCHEME REDEMPTION PREVIEW
// ============================================================

app.post(
  '/api/customer/redeem-scheme',
  customerAuth,
  wrap(async (req, res) => {
    if (
      req.body.userId &&
      String(req.body.userId) !==
        String(req.customer._id)
    ) {
      bad(403, 'Not your scheme.');
    }

    const standardMakingCharges = Number(
      req.body.standardMakingCharges || 0
    );

    if (
      !Number.isFinite(standardMakingCharges) ||
      standardMakingCharges < 0
    ) {
      bad(400, 'Invalid making charges.');
    }

    const eligible = discountEligible(
      req.customer
    );

    const totalAccumulatedSavings =
      req.customer.paymentHistory.reduce(
        (sum, payment) =>
          sum + Number(payment.amount || 0),
        0
      );

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
        makingChargesDiscountPercentage:
          eligible ? 100 : 0,
        finalMakingChargesToPay:
          eligible ? 0 : standardMakingCharges,
        eligible,
        goldOnly: true,
        previewOnly: true
      }
    });
  })
);

// ============================================================
// STORE SETTINGS / UPI
// ============================================================

app.get(
  '/api/store/settings',
  wrap(async (_req, res) => {
    const settings =
      await StoreSettings.findByIdAndUpdate(
        'store_config',
        {
          $setOnInsert: {
            merchantName: 'Rahul Jewellers'
          }
        },
        {
          upsert: true,
          new: true
        }
      );

    res.json({
      success: true,
      settings
    });
  })
);

app.put(
  '/api/store/settings',
  adminAuth,
  wrap(async (req, res) => {
    const upiId = clean(req.body.upiId);
    const merchantName = safe(
      req.body.merchantName,
      100
    );

    if (
      !upiId ||
      !merchantName ||
      !/^[\w.\-]+@[\w.\-]+$/.test(upiId)
    ) {
      bad(
        400,
        'Valid UPI ID and merchant name required.'
      );
    }

    const qrCodeUrl = req.body.qrCodeUrl;

    if (
      qrCodeUrl !== undefined &&
      qrCodeUrl &&
      !/^(data:image\/(?:png|jpeg|webp);base64,|https:\/\/)/i
        .test(qrCodeUrl)
    ) {
      bad(400, 'Invalid QR image.');
    }

    const settings =
      await StoreSettings.findByIdAndUpdate(
        'store_config',
        {
          $set: {
            upiId,
            merchantName,
            ...(
              qrCodeUrl !== undefined
                ? { qrCodeUrl }
                : {}
            )
          }
        },
        {
          upsert: true,
          new: true
        }
      );

    res.json({
      success: true,
      settings
    });
  })
);

// ============================================================
// WHATSAPP REMINDERS
// ============================================================

app.post(
  '/api/admin/send-whatsapp-reminder',
  adminAuth,
  wrap(async (req, res) => {
    const customer = await User.findOne({
      customerId: clean(req.body.customerId)
    });

    if (
      !customer ||
      !customer.schemeJoined
    ) {
      bad(
        404,
        'Gold Scheme subscriber not found.'
      );
    }

    if (
      Number(customer.paidMonths || 0) >= 12
    ) {
      bad(
        409,
        'All installments completed.'
      );
    }

    const month =
      Number(customer.paidMonths || 0) + 1;

    const message =
      `नमस्ते ${customer.name} जी,\n\n` +
      `Rahul Jewellers Sheoganj Gold Savings Scheme रिमाइंडर।\n` +
      `Customer ID: ${customer.customerId}\n` +
      `किस्त: ${month}/12\n` +
      `राशि: ₹${Number(customer.customInstallment)
        .toLocaleString('en-IN')}\n\n` +
      `12 किस्तें पूरी करने के अगले महीने ` +
      `Gold Jewellery के Labour/Making Charges पर ` +
      `नियमानुसार 100% छूट।\nधन्यवाद!`;

    res.json({
      success: true,
      url:
        `https://wa.me/91${customer.phone}` +
        `?text=${encodeURIComponent(message)}`
    });
  })
);

// ============================================================
// MANUAL GOLD RATE
// ============================================================

const goldClients = new Set();

function goldPayload(rate) {
  return {
    success: true,
    type: 'gold',
    enabled: Boolean(rate?.enabled),
    carat: '22K',
    priceInrPerGram: Number(
      rate?.priceInrPerGram || 0
    ),
    source: 'manual',
    connected: Boolean(rate?.enabled),
    timestamp: rate?.updatedAt
      ? new Date(rate.updatedAt).getTime()
      : Date.now(),
    goldLastUpdated: rate?.updatedAt
      ? new Date(rate.updatedAt).getTime()
      : null
  };
}

function broadcastGoldRate(rate) {
  const message =
    `data: ${JSON.stringify(goldPayload(rate))}\n\n`;

  for (const client of goldClients) {
    try {
      client.write(message);
    } catch {
      goldClients.delete(client);
    }
  }
}

app.get(
  '/api/gold-rate',
  wrap(async (_req, res) => {
    const rate = await GoldRate.findById(
      'published_gold_rate'
    ).lean();

    res.json(goldPayload(rate));
  })
);

app.put(
  '/api/admin/gold-rate',
  adminAuth,
  wrap(async (req, res) => {
    if (
      typeof req.body.enabled !== 'boolean'
    ) {
      bad(
        400,
        'enabled must be true or false.'
      );
    }

    const price = Number(
      req.body.priceInrPerGram
    );

    if (
      !Number.isFinite(price) ||
      price < 0 ||
      (
        req.body.enabled &&
        price <= 0
      )
    ) {
      bad(
        400,
        'Enter a valid rate in INR per gram.'
      );
    }

    const goldRate =
      await GoldRate.findByIdAndUpdate(
        'published_gold_rate',
        {
          $set: {
            enabled: req.body.enabled,
            priceInrPerGram: price,
            carat: '22K',
            updatedBy: ADMIN_EMAIL
          }
        },
        {
          new: true,
          upsert: true,
          runValidators: true
        }
      );

    broadcastGoldRate(goldRate);

    res.json({
      success: true,
      goldRate,
      rate: goldRate
    });
  })
);

app.get(
  '/api/gold-rate/stream',
  wrap(async (req, res) => {
    res.setHeader(
      'Content-Type',
      'text/event-stream'
    );
    res.setHeader(
      'Cache-Control',
      'no-cache, no-transform'
    );
    res.setHeader(
      'Connection',
      'keep-alive'
    );
    res.setHeader(
      'X-Accel-Buffering',
      'no'
    );

    if (
      typeof res.flushHeaders === 'function'
    ) {
      res.flushHeaders();
    }

    goldClients.add(res);

    const rate = await GoldRate.findById(
      'published_gold_rate'
    ).lean();

    res.write(
      `data: ${JSON.stringify(goldPayload(rate))}\n\n`
    );

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {}
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      goldClients.delete(res);
    });
  })
);

// ============================================================
// AI CUSTOMER SUPPORT
// ============================================================

app.post(
  '/api/support/chat',
  wrap(async (req, res) => {
    const message = safe(
      req.body.message,
      1500
    );

    if (!message) {
      bad(400, 'Message required.');
    }

    if (!ai) {
      bad(
        503,
        'Support chat is temporarily unavailable.'
      );
    }

    const response =
      await ai.models.generateContent({
        model:
          process.env.GEMINI_MODEL ||
          'gemini-2.0-flash',
        contents: message,
        config: {
          systemInstruction:
            `You are the Hindi-first assistant for ` +
            `Rahul Jewellers Sheoganj, Rajasthan. ` +
            `The showroom sells Gold and Silver jewellery. ` +
            `The 12+1 savings scheme is GOLD ONLY. ` +
            `Customers pay 12 monthly installments, ` +
            `and in the following month eligible customers ` +
            `get 100% off labour/making charges on gold ` +
            `jewellery, subject to terms. ` +
            `There is NO free 13th installment, free extra ` +
            `gold, or silver savings scheme. ` +
            `UPI installment submissions remain Pending ` +
            `until admin verifies. ` +
            `Never claim a manually entered gold rate ` +
            `is a live market rate.`
        }
      });

    res.json({
      success: true,
      reply:
        response.text ||
        'Please contact Rahul Jewellers Sheoganj.'
    });
  })
);

// ============================================================
// DISABLE UNSAFE LEGACY SCHEME ENDPOINTS
// ============================================================

app.use('/api/schemes', (_req, res) => {
  res.status(410).json({
    success: false,
    message:
      'Legacy scheme routes disabled. Use verified customer/admin payment APIs.'
  });
});

// ============================================================
// ERROR HANDLING
// ============================================================

app.use((err, _req, res, _next) => {
  if (
    err instanceof mongoose.Error.ValidationError
  ) {
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }

  if (err?.code === 11000) {
    return res.status(409).json({
      success: false,
      message:
        'Duplicate mobile, Customer ID, UTR or pending installment.'
    });
  }

  if (err?.status) {
    return res.status(err.status).json({
      success: false,
      message: err.message
    });
  }

  console.error('Backend error:', err);

  res.status(500).json({
    success: false,
    message: 'Server error. Please try again.'
  });
});

// ============================================================
// CONNECT MONGODB AND START SERVER
// ============================================================

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    // Migrate old passbook accounts into schemeJoined.
    // Newly registered independent accounts remain unjoined.
    await User.updateMany(
      {
        schemeJoined: { $exists: false },
        $or: [
          { paidMonths: { $gt: 0 } },
          {
            startDate: {
              $type: 'string',
              $ne: ''
            }
          }
        ]
      },
      {
        $set: {
          schemeJoined: true
        }
      }
    );

    await Promise.all([
      User.init(),
      PaymentRequest.init()
    ]);

    app.listen(
      PORT,
      '0.0.0.0',
      () => {
        console.log(
          `Rahul Jewellers backend listening on ${PORT}`
        );
      }
    );
  })
  .catch(err => {
    console.error(
      'MongoDB startup error:',
      err
    );

    process.exitCode = 1;
  });
