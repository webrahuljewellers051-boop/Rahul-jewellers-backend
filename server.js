import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { Resend } from 'resend';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import dns from 'dns';
import { GoogleGenAI } from '@google/genai';
import schemeRoutes from './routes/schemeRoutes.js';
import './services/cronService.js';
import WebSocket from 'ws';

dns.setServers(['8.8.8.8', '8.8.4.4']);
dotenv.config();

const app = express();

app.set('trust proxy', true);

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'RahulJewellers_JWT_Secret_2026_ChangeThisLater_9x7K2m';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ==========================================
// LIVE GOLD RATE - FCS WEBSOCKET
// ==========================================

const FCS_SOCKET_API_KEY =
  process.env.FCS_SOCKET_API_KEY;

const FCS_SOCKET_URL =
  'wss://ws-v4.fcsapi.com/ws';

const TROY_OUNCE_GRAMS =
  31.1034768;

let fcsSocket = null;

let goldUsd = null;
let usdInr = null;

let goldLastUpdated = null;
let fxLastUpdated = null;

let goldClients = new Set();

let goldReconnectTimer = null;

let fcsConnected = false;


// Calculate 24K INR per gram
function calculateGoldPriceINR() {
  if (
    !Number.isFinite(goldUsd) ||
    !Number.isFinite(usdInr)
  ) {
    return null;
  }

  return (
    goldUsd *
    usdInr
  ) / TROY_OUNCE_GRAMS;
}


// Send current gold rate to all website clients
function broadcastGoldRate() {

  const priceInrPerGram =
    calculateGoldPriceINR();

  if (
    !Number.isFinite(
      priceInrPerGram
    )
  ) {
    return;
  }

  const payload =
    JSON.stringify({
      type: 'gold',

      priceInrPerGram,

      xauUsd:
        goldUsd,

      usdInr:
        usdInr,

      timestamp:
        Date.now(),

      connected:
        fcsConnected
    });

  for (
    const client of goldClients
  ) {

    try {

      client.write(
        `data: ${payload}\n\n`
      );

    } catch (error) {

      console.error(
        'Gold SSE client error:',
        error.message
      );

    }

  }

  console.log(
    `💰 LIVE 24K GOLD: ₹${priceInrPerGram.toFixed(2)}/g`
  );
}


// Process FCS WebSocket messages
function processFCSMessage(rawMessage) {

  try {

    const data =
      JSON.parse(
        rawMessage.toString()
      );

    console.log(
      'FCS MESSAGE:',
      JSON.stringify(data)
    );


    // --------------------------------------
    // PRICE MESSAGE
    // --------------------------------------

    if (
      data.type === 'price'
    ) {

      const symbol =
        String(
          data.symbol || ''
        ).toUpperCase();

      const prices =
        data.prices || {};

      const currentPrice =
        Number(
          prices.c
        );


      if (
        !Number.isFinite(
          currentPrice
        )
      ) {
        return;
      }


      // XAU/USD
      if (
        symbol.includes(
          'XAUUSD'
        )
      ) {

        goldUsd =
          currentPrice;

        goldLastUpdated =
          Date.now();

        console.log(
          `🥇 XAU/USD: ${goldUsd}`
        );

        broadcastGoldRate();

        return;
      }


      // USD/INR
      if (
        symbol.includes(
          'USDINR'
        )
      ) {

        usdInr =
          currentPrice;

        fxLastUpdated =
          Date.now();

        console.log(
          `💱 USD/INR: ${usdInr}`
        );

        broadcastGoldRate();

        return;
      }

    }


    // --------------------------------------
    // FCS ERROR
    // --------------------------------------

    if (
      data.type === 'error'
    ) {

      console.error(
        '❌ FCS ERROR:',
        data.message || data
      );

    }

  } catch (error) {

    console.error(
      '❌ FCS message parsing error:',
      error.message
    );

  }
}


// Connect to FCS WebSocket
function connectFCSGoldFeed() {

  if (
    !FCS_SOCKET_API_KEY
  ) {

    console.error(
      '❌ FCS_SOCKET_API_KEY is missing.'
    );

    return;

  }


  console.log(
    '🔌 Connecting to FCS Gold WebSocket...'
  );


  const socketUrl =
    `${FCS_SOCKET_URL}?access_key=${encodeURIComponent(
      FCS_SOCKET_API_KEY
    )}`;


  fcsSocket =
    new WebSocket(
      socketUrl
    );


  // --------------------------------------
  // CONNECTED
  // --------------------------------------

  fcsSocket.on(
    'open',
    () => {

      fcsConnected =
        true;

      console.log(
        '✅ FCS WebSocket connected'
      );


      /*
       * Subscribe to XAU/USD.
       *
       * XAUUSD is a commodity symbol
       * according to FCS.
       */

      fcsSocket.send(
        JSON.stringify({
          type:
            'join_symbol',

          symbol:
            'XAUUSD',

          timeframe:
            '1'
        })
      );


      /*
       * Subscribe to USD/INR.
       */

      fcsSocket.send(
        JSON.stringify({
          type:
            'join_symbol',

          symbol:
            'FX:USDINR',

          timeframe:
            '1'
        })
      );


      // Tell connected website clients
      for (
        const client of goldClients
      ) {

        try {

          client.write(
            `data: ${JSON.stringify({
              type: 'status',
              connected: true
            })}\n\n`
          );

        } catch {}

      }

    }
  );


  // --------------------------------------
  // MESSAGE
  // --------------------------------------

  fcsSocket.on(
    'message',
    processFCSMessage
  );


  // --------------------------------------
  // ERROR
  // --------------------------------------

  fcsSocket.on(
    'error',
    (error) => {

      console.error(
        '❌ FCS WebSocket error:',
        error.message
      );

    }
  );


  // --------------------------------------
  // CLOSED
  // --------------------------------------

  fcsSocket.on(
    'close',
    () => {

      fcsConnected =
        false;

      console.log(
        '⚠️ FCS WebSocket disconnected'
      );


      for (
        const client of goldClients
      ) {

        try {

          client.write(
            `data: ${JSON.stringify({
              type: 'status',
              connected: false
            })}\n\n`
          );

        } catch {}

      }


      if (
        goldReconnectTimer
      ) {

        clearTimeout(
          goldReconnectTimer
        );

      }


      goldReconnectTimer =
        setTimeout(
          () => {

            console.log(
              '🔄 Reconnecting FCS Gold Feed...'
            );

            connectFCSGoldFeed();

          },
          5000
        );

    }
  );

}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Please try again later.' }
});

app.get('/', (req, res) => {
  res.send('🚀 Rahul Jewellers (Sheoganj) Backend is Live & Running!');
});

const HARDCODED_ADMIN_EMAIL = 'web.rahuljewellers051@gmail.com';
const resend = new Resend(process.env.RESEND_API_KEY);

const otpStorage = {};
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://viveksoni2400_db_user:RahulJewellers123@cluster0.hz6lo1n.mongodb.net/rahul_jewellers?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ CONNECTED TO MONGODB ATLAS'))
  .catch((err) => console.error('❌ MONGODB ERROR:', err.message));

// ==========================================
// SCHEMAS & MODELS
// ==========================================
const storeSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'store_config' },
  upiId: { type: String, default: '9950091024@okbizaxis' },
  merchantName: { type: String, default: 'Rahul Jewellers' },
  qrCodeUrl: { type: String, default: '' }
}, { timestamps: true });

const StoreSettings = mongoose.model('StoreSettings', storeSettingsSchema);

const userSchema = new mongoose.Schema({
  customerId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: { type: String, default: '' },
  password: { type: String, required: true },
  address: { type: String, default: '' },
  customInstallment: { type: Number, default: 10000 },
  paidMonths: { type: Number, default: 0 },
  isLaborFree: { type: Boolean, default: false },
  startDate: { type: String, default: () => new Date().toISOString().split('T')[0] },
  finalDueDate: { type: String },
  isActive: { type: Boolean, default: true },
  paymentHistory: [
    {
      monthNum: { type: Number, required: true },
      amount: { type: Number, required: true },
      transactionId: { type: String, required: true },
      paidAt: { type: Date, default: Date.now }
    }
  ],
  cart: [{ product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, quantity: { type: Number, default: 1 } }],
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }]
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  parentCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null }
}, { timestamps: true });

const Category = mongoose.model('Category', categorySchema);

const productSchema = new mongoose.Schema({
  title: { type: String, required: true },
  category: { type: String, required: true },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  weight: { type: String, required: true },
  price: { type: Number, default: 0 },
  imageUrl: { type: String, required: true }
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);

app.use('/api/schemes', schemeRoutes);

// ==========================================
// AUTH & SESSION ENDPOINTS
// ==========================================
app.get('/api/client/admin-session', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.split(' ')[1] : req.cookies.admin_token;
  
  if (!token) return res.status(401).json({ success: false, message: 'No session token' });
  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ success: true, message: 'Session active' });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid session' });
  }
});

app.post('/api/client/admin-logout', (req, res) => {
  res.clearCookie('admin_token', { 
    httpOnly: true, 
    secure: true, 
    sameSite: 'none' 
  });
  res.json({ success: true, message: 'Logged out successfully' });
});

app.post('/api/client/send-email-otp', adminAuthLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || email.trim().toLowerCase() !== HARDCODED_ADMIN_EMAIL.toLowerCase()) {
      return res.status(403).json({ success: false, message: 'Access Denied. Unauthorized Email.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStorage[email.trim().toLowerCase()] = otp;

    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: [HARDCODED_ADMIN_EMAIL],
      subject: 'Admin Login OTP - Rahul Jewellers',
      html: `<p>Your secure admin verification code is: <strong>${otp}</strong></p>`
    });

    res.json({ success: true, message: 'Admin OTP sent successfully to your inbox!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/client/verify-email-otp', adminAuthLimiter, (req, res) => {
  const { email, otp } = req.body;
  const cleanEmail = email ? email.trim().toLowerCase() : '';

  if (cleanEmail !== HARDCODED_ADMIN_EMAIL.toLowerCase() || otpStorage[cleanEmail] !== otp) {
    return res.status(401).json({ success: false, message: 'Invalid OTP code or unauthorized email.' });
  }
  
  delete otpStorage[cleanEmail];

  const token = jwt.sign({ email: HARDCODED_ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '7d' });
  
  res.json({ success: true, message: 'Admin verified successfully!', token });
});

// ==========================================
// API ROUTES: PRODUCTS & CATEGORIES
// ==========================================
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/products', async (req, res) => {
  try {
    const { title, category, weight, price, imageUrl, categoryId } = req.body;
    
    const cleanPrice = price !== undefined && price !== '' 
      ? Number(String(price).replace(/[^0-9.-]+/g, '')) 
      : 0;

    const newProduct = new Product({
      title: title.trim(),
      category: category.trim(),
      weight: weight.trim(),
      price: cleanPrice,
      imageUrl: imageUrl,
      categoryId: (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) ? categoryId : null
    });
    await newProduct.save();
    res.status(201).json({ success: true, product: newProduct });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/products/:id', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Product deleted from showroom.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const categories = await Category.find().populate('parentCategory').sort({ createdAt: -1 });
    res.json({ success: true, categories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/categories', async (req, res) => {
  try {
    const { name, description, parentCategory } = req.body;
    const newCat = new Category({
      name: name.trim(),
      description: description ? description.trim() : '',
      parentCategory: (parentCategory && mongoose.Types.ObjectId.isValid(parentCategory)) ? parentCategory : null
    });
    await newCat.save();
    res.status(201).json({ success: true, category: newCat });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/categories/:id', async (req, res) => {
  try {
    await Category.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Category deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// API ROUTES: CUSTOMERS & PASSBOOK
// ==========================================
app.post('/api/customer/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const cleanIdentifier = identifier.trim();
    const cleanPassword = password.trim();
    const customer = await User.findOne({
      $or: [
        { customerId: { $regex: new RegExp(`^${cleanIdentifier}$`, 'i') } },
        { phone: cleanIdentifier }
      ]
    });
    if (!customer) return res.status(404).json({ success: false, message: 'Account not found.' });
    if (customer.password !== cleanPassword) return res.status(401).json({ success: false, message: 'Incorrect password.' });
    if (customer.isActive === false) {
      return res.status(403).json({ success: false, message: 'Your account has been deactivated by the store admin. Please contact Rahul Jewellers.' });
    }
    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/customer/profile/:id', async (req, res) => {
  try {
    const customer = await User.findById(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });
    if (customer.isActive === false) {
      return res.status(403).json({ success: false, message: 'Account deactivated.' });
    }
    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/customer/update-profile/:id', async (req, res) => {
  try {
    const { name, phone, password, address } = req.body;
    const customer = await User.findById(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

    if (name) customer.name = name.trim();
    if (phone) customer.phone = phone.trim();
    if (password) customer.password = password.trim();
    if (address !== undefined) customer.address = address.trim();

    await customer.save();
    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/manual-passbook-update', async (req, res) => {
  try {
    const { userId, monthNum, action } = req.body;
    const customer = await User.findById(userId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });
    if (!customer.paymentHistory) customer.paymentHistory = [];
    const targetMonth = Number(monthNum);

    if (action === 'PAY') {
      if (targetMonth > 1) {
        const previousPaid = customer.paymentHistory.some(p => p.monthNum === targetMonth - 1);
        if (!previousPaid) {
          return res.status(400).json({ success: false, message: `Month #${targetMonth - 1} must be paid first.` });
        }
      }
      if (targetMonth > customer.paidMonths) customer.paidMonths = targetMonth;
      
      const idx = customer.paymentHistory.findIndex(p => p.monthNum === targetMonth);
      const installmentAmount = customer.customInstallment || 10000;

      if (idx > -1) {
        customer.paymentHistory[idx].transactionId = 'VERIFIED_WHATSAPP_SS';
        customer.paymentHistory[idx].amount = installmentAmount;
      } else {
        customer.paymentHistory.push({ 
          monthNum: targetMonth, 
          amount: installmentAmount, 
          transactionId: 'VERIFIED_WHATSAPP_SS' 
        });
      }

      if (customer.paidMonths >= 12) {
        customer.isLaborFree = true;
      }
    } else if (action === 'UNPAY') {
      const higherPaid = customer.paymentHistory.some(p => p.monthNum > targetMonth);
      if (higherPaid) return res.status(400).json({ success: false, message: 'Cannot unpay while subsequent months are paid.' });
      
      customer.paymentHistory = customer.paymentHistory.filter(p => p.monthNum !== targetMonth);
      customer.paidMonths = Math.max(0, targetMonth - 1);
      
      if (customer.paidMonths < 12) {
        customer.isLaborFree = false;
      }
    }
    
    await customer.save();
    const updatedCustomer = await User.findById(userId);
    res.json({ success: true, customer: updatedCustomer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/customer/redeem-scheme', async (req, res) => {
  try {
    const { userId, standardMakingCharges } = req.body;
    
    const customer = await User.findById(userId);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer account not found.' });
    }

    const totalAccumulatedSavings = customer.paymentHistory.reduce((sum, item) => sum + item.amount, 0);
    const finalMakingCharges = customer.isLaborFree ? 0 : (standardMakingCharges || 0);

    res.json({
      success: true,
      message: customer.isLaborFree 
        ? 'Congratulations! 100% Making Charges Discount applied successfully.' 
        : 'Standard rates applied.',
      redemptionDetails: {
        customerId: customer.customerId,
        customerName: customer.name,
        totalAccumulatedSavings,
        standardMakingCharges: standardMakingCharges || 0,
        makingChargesDiscountPercentage: customer.isLaborFree ? 100 : 0,
        finalMakingChargesToPay: finalMakingCharges
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/customers', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ success: true, users, customers: users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/create-customer', async (req, res) => {
  try {
    const { name, phone, password, customInstallment, startDate, finalDueDate } = req.body;
    const cleanPhone = phone ? phone.trim() : '';

    const existingUser = await User.findOne({ phone: cleanPhone });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Login number already exist.' });
    }

    const lastUser = await User.findOne().sort({ createdAt: -1 });
    let nextNum = 1001;
    if (lastUser && lastUser.customerId && lastUser.customerId.startsWith('RJ')) {
      const numPart = parseInt(lastUser.customerId.replace('RJ', ''), 10);
      if (!isNaN(numPart)) nextNum = numPart + 1;
    }
    const customerId = `RJ${nextNum}`;

    const newCustomer = new User({
      customerId, 
      name: name.trim(), 
      phone: cleanPhone, 
      password: password.trim(),
      customInstallment: Number(customInstallment) || 10000, 
      paidMonths: 0, 
      isLaborFree: false,
      isActive: true,
      startDate: startDate || new Date().toISOString().split('T')[0],
      finalDueDate: finalDueDate || ''
    });
    
    await newCustomer.save();
    res.status(201).json({ success: true, customer: newCustomer });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Login number already exist.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/delete-customer/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Customer deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/admin/customer-status/:id', async (req, res) => {
  try {
    const { isActive } = req.body;
    const customer = await User.findById(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

    customer.isActive = isActive;
    await customer.save();
    
    res.json({ success: true, message: 'Customer status updated successfully.', customer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// API ROUTES: STORE SETTINGS, REMINDERS & AI SUPPORT CHAT
// ==========================================
app.get('/api/store/settings', async (req, res) => {
  try {
    let settings = await StoreSettings.findById('store_config');
    if (!settings) {
      settings = await StoreSettings.create({ _id: 'store_config', upiId: '9950091024@okbizaxis', merchantName: 'Rahul Jewellers' });
    }
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/store/settings', async (req, res) => {
  try {
    const { upiId, merchantName, qrCodeUrl } = req.body;
    const updateData = {};
    if (upiId) updateData.upiId = upiId.trim();
    if (merchantName) updateData.merchantName = merchantName.trim();
    if (qrCodeUrl !== undefined) updateData.qrCodeUrl = qrCodeUrl;

    const settings = await StoreSettings.findByIdAndUpdate(
      'store_config',
      updateData,
      { new: true, upsert: true }
    );
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/send-whatsapp-reminder', async (req, res) => {
  try {
    const { phone, name, customerId, nextMonth, amount } = req.body;
    const message = `Namaste ${name} ji,\n\nReminder from *Rahul Jewellers (Sheoganj)* for your 12-Month Savings Scheme.\n\n• Customer ID: ${customerId}\n• Due: Installment Month #${nextMonth}\n• Installment Amount: ₹${Number(amount || 0).toLocaleString('en-IN')}\n\nThank you for saving with us!`;
    res.json({ success: true, url: `https://wa.me/91${phone}?text=${encodeURIComponent(message)}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/support/chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    const systemInstruction = `
      You are an AI customer support assistant for "Rahul Jewellers" located in Main Market, Sheoganj, Rajasthan. 
      Your job is to assist customers with:
      - The 12-Month Savings Scheme (12 monthly installments paid fully, granting a 100% discount on making charges upon redemption).
      - Showroom details, timings (10:00 AM to 6:00 PM), and pure 916 hallmarked gold/silver collections.
      - Helpline numbers: +91 9950091024 / +91 9461452322.
      - Instruct them to send payment screenshots on WhatsApp for manual passbook verification if they ask about online scheme payments.
      Be polite, welcoming, and concise.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: message,
      config: {
        systemInstruction: systemInstruction,
      }
    });

    res.json({ success: true, reply: response.text });
  } catch (err) {
    console.error("Support Chat Error:", err);
    res.status(500).json({ success: false, message: 'Support chat unavailable right now.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Rahul Jewellers Backend running on port ${PORT}`);
});