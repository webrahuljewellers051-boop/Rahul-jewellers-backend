
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

// ==========================================
// RAHUL JEWELLERS
// SECURE CUSTOMER AUTHENTICATION
// ==========================================

const getBearerToken = (req) => {
  const header = req.headers.authorization || '';

  if (
    typeof header !== 'string' ||
    !header.startsWith('Bearer ')
  ) {
    return null;
  }

  return header.slice(7).trim() || null;
};

// ==========================================
// CREATE CUSTOMER LOGIN TOKEN
// ==========================================

export function createCustomerToken(customer) {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      'JWT_SECRET is missing from environment variables.'
    );
  }

  return jwt.sign(
    {
      sub: String(customer._id),
      role: 'customer',
      tokenVersion: Number(
        customer.tokenVersion || 0
      )
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: '7d'
    }
  );
}

// ==========================================
// VERIFY CUSTOMER SESSION
// ==========================================

export async function requireCustomer(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Please login to continue.'
      });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
      return res.status(503).json({
        success: false,
        message: 'Authentication is not configured.'
      });
    }

    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256']
    });

    if (
      decoded.role !== 'customer' ||
      !mongoose.isValidObjectId(decoded.sub)
    ) {
      return res.status(401).json({
        success: false,
        message: 'Invalid customer session.'
      });
    }

    // The User model must already be registered
    // by server.js before requests are handled.
    const User = mongoose.model('User');

    const customer = await User.findById(
      decoded.sub
    );

    if (!customer) {
      return res.status(401).json({
        success: false,
        message:
          'Customer account no longer exists. Please login again.'
      });
    }

    // Block deactivated and archived accounts.
    if (
      customer.isActive === false ||
      customer.deletedAt
    ) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_INACTIVE',
        message:
          'Your account is inactive. Please contact Rahul Jewellers.'
      });
    }

    // Every password change or admin deactivation
    // can increment tokenVersion.
    // Existing tokens will then stop working.
    const currentVersion = Number(
      customer.tokenVersion || 0
    );

    const tokenVersion = Number(
      decoded.tokenVersion || 0
    );

    if (currentVersion !== tokenVersion) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_EXPIRED',
        message:
          'Your session has expired. Please login again.'
      });
    }

    req.customer = customer;
    req.customerId = String(customer._id);

    next();
  } catch (error) {
    if (
      error.name === 'TokenExpiredError' ||
      error.name === 'JsonWebTokenError' ||
      error.name === 'NotBeforeError'
    ) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_SESSION',
        message:
          'Customer session expired. Please login again.'
      });
    }

    console.error(
      'Customer authentication error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to verify customer session.'
    });
  }
}

// ==========================================
// VERIFY CUSTOMER OWNS REQUESTED PROFILE
// ==========================================

export function requireOwnProfile(req, res, next) {
  const requestedId = String(
    req.params.id || req.body?.userId || ''
  );

  if (
    !requestedId ||
    requestedId !== req.customerId
  ) {
    return res.status(403).json({
      success: false,
      message:
        'You cannot access another customer account.'
    });
  }

  next();
}

// ==========================================
// REMOVE PRIVATE FIELDS FROM API RESPONSES
// ==========================================

export function safeCustomer(customer) {
  if (!customer) return null;

  const data =
    typeof customer.toObject === 'function'
      ? customer.toObject()
      : { ...customer };

  delete data.password;
  delete data.tokenVersion;
  delete data.__v;

  return data;
}

export default requireCustomer;
