
import jwt from 'jsonwebtoken';

// ==========================================
// RAHUL JEWELLERS — ADMIN AUTHENTICATION
// ==========================================

export function requireAdmin(req, res, next) {
  try {
    const authorization = req.headers.authorization || '';

    const bearerToken = authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : null;

    const token = bearerToken || req.cookies?.admin_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Admin login required.'
      });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
      console.error('JWT_SECRET is not configured.');

      return res.status(503).json({
        success: false,
        message: 'Authentication is not configured.'
      });
    }

    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256']
    });

    const adminEmail = (
      process.env.ADMIN_EMAIL ||
      'web.rahuljewellers051@gmail.com'
    ).trim().toLowerCase();

    const tokenEmail = String(
      decoded.email || ''
    ).trim().toLowerCase();

    // Supports existing admin JWTs that contain email
    // and newer JWTs with role: 'admin'.
    if (
      tokenEmail !== adminEmail ||
      (decoded.role && decoded.role !== 'admin')
    ) {
      return res.status(403).json({
        success: false,
        message: 'Admin access denied.'
      });
    }

    req.admin = {
      email: tokenEmail,
      role: 'admin'
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Admin session expired or invalid.'
    });
  }
}

export default requireAdmin;
