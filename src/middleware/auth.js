const { verifyToken } = require('../services/authService');
const userRepo = require('../db/repositories/userRepo');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  try {
    const payload = verifyToken(token);
    const user = userRepo.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    if (user.status !== 'active') return res.status(403).json({ error: 'User account is disabled' });
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role || 'user',
      status: user.status || 'active',
      isAdmin: user.role === 'admin',
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = requireAuth;
