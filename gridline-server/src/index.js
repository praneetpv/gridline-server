require('dotenv').config();
require('express-async-errors'); // lets `async (req,res)=>{ throw }` route handlers reach the
                                  // error handler below instead of hanging/crashing the process
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');

const { requireAuth } = require('./auth/auth.middleware');
const { initSocket } = require('./realtime/socket');

const authRoutes = require('./auth/auth.routes');
const networkRoutes = require('./routes/network.routes');
const feederRoutes = require('./routes/feeders.routes');
const nodeRoutes = require('./routes/nodes.routes');
const lineRoutes = require('./routes/lines.routes');
const interlinkRoutes = require('./routes/interlinks.routes');
const transformerRoutes = require('./routes/transformers.routes');
const auditRoutes = require('./routes/audit.routes');

const app = express();
app.use(cors({ origin: (process.env.CORS_ORIGIN || '*').split(','), credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// Serves gridline.html (and anything else dropped in ./public) from the same origin/port as the
// API. Optional for a docker-compose deployment (Nginx handles this there instead), but this is
// what makes a single-service deploy (e.g. Railway, or any other one-process-per-app host) work
// without a separate static file host: one deploy, one domain, no CORS to configure.
// no-cache (not "no-store") on the HTML shell so every browser — especially mobile ones, which tend
// to serve an old disk-cached copy on repeated visits to the same URL — is forced to revalidate with
// the server on every load instead of silently reusing a pre-deploy copy of the app. This has bitten
// us before: role-gating/legend-default fixes were live on the server but a field device kept showing
// stale behavior because it never re-fetched the file. Other static assets keep normal caching.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'gridline.html',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// Auth is the only unauthenticated route group; everything else requires a valid bearer token.
app.use('/api/auth', authRoutes);
app.use('/api/network', requireAuth, networkRoutes);
app.use('/api/feeders', requireAuth, feederRoutes);
app.use('/api/nodes', requireAuth, nodeRoutes);
app.use('/api/lines', requireAuth, lineRoutes);
app.use('/api/interlinks', requireAuth, interlinkRoutes);
app.use('/api/transformers', requireAuth, transformerRoutes);
app.use('/api/audit', requireAuth, auditRoutes);

// Centralized error handler — anything thrown/rejected inside a route lands here rather than
// crashing the process or leaking a raw stack trace to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const server = http.createServer(app);
initSocket(server);

const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`GRIDLINE backend listening on :${port}`);
});

module.exports = { app, server };
