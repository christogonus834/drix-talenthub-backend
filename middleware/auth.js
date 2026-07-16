const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const adminMiddleware = (req, res, next) => {
  const token = req.cookies?.adminToken || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!['admin', 'super_admin', 'moderator'].includes(decoded.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = { authMiddleware, adminMiddleware };
