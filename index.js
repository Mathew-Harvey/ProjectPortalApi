require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const workItemRoutes = require('./routes/workItems');
const templateRoutes = require('./routes/templates');

const app = express();
const PORT = process.env.PORT || 3001;

// Render terminates TLS in front of the app and forwards the client IP via
// X-Forwarded-For; trust one proxy hop so rate-limiting sees real IPs.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(helmet());

// CORS — exact origin allowlist (no startsWith), credentials for the auth cookie.
const allowedOrigins = new Set(
  [
    process.env.CLIENT_URL,
    ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://localhost:3001'] : []),
  ].filter(Boolean)
);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
}));

app.use(cookieParser());

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('short'));
}

app.use(express.json({ limit: '2mb' }));

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const skipInTest = process.env.NODE_ENV === 'test' ? () => true : () => false;
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skip: skipInTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});
const apiLimiter = rateLimit({
  windowMs: parsePositiveInt(process.env.API_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  max: parsePositiveInt(process.env.API_RATE_LIMIT_MAX, 10000),
  skip: skipInTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

// Health check — used as Render's healthCheckPath.
app.get('/api/health', async (req, res) => {
  try {
    const pool = require('./config/db');
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
  }
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/projects', apiLimiter, projectRoutes);
app.use('/api/work-items', apiLimiter, workItemRoutes);
app.use('/api/templates', apiLimiter, templateRoutes);

// Global error handler (multer limits, JSON parse errors, etc.)
app.use((err, req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', message: 'File exceeds the maximum upload size.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server only when run directly (tests import the app).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Franmarine Project Portal API running on port ${PORT}`);
    console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);

    // Idempotently seed templates + demo org/project/users on startup so a fresh
    // Render deploy is immediately usable. Migration runs in the build step.
    const pool = require('./config/db');
    const { seedAll } = require('./config/seed');
    seedAll(pool)
      .then((demo) => console.log('  Seed ready:', demo.orgId ? 'ok' : 'skipped'))
      .catch((err) => console.error('  Startup seed error:', err.message));
  });
}

module.exports = app;
