const appPaths = require('./utils/appPaths');
require('dotenv').config({ path: appPaths.envPath });
const path = require('path');
const fs = require('fs');

// pdfkit loads its built-in fonts through a package-internal alias
// ("#standard-fonts/Helvetica") that the .exe packager cannot resolve, so in the
// packaged build the alias is pointed at the font files bundled with it.
if (appPaths.packaged) {
  const Module = require('module');
  const fontsDir = path.join(__dirname, '..', 'node_modules', 'pdfkit', 'js', 'standard-fonts');
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (typeof request === 'string' && request.startsWith('#standard-fonts/')) {
      request = path.join(fontsDir, request.slice('#standard-fonts/'.length) + '.cjs');
    }
    return originalResolve.call(this, request, ...rest);
  };
}

// A packaged copy has no .env, so it makes (and keeps) its own session secret
// instead of using the built-in development one.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!appPaths.packaged) return 'dev-secret-change-me';
  const file = path.join(appPaths.dataDir, 'session-secret.txt');
  try {
    fs.mkdirSync(appPaths.dataDir, { recursive: true });
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const secret = require('crypto').randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret);
    return secret;
  } catch (e) {
    return require('crypto').randomBytes(32).toString('hex');
  }
}
const express = require('express');
const session = require('express-session');
const SqliteSessionStore = require('./db/sessionStore');
const methodOverride = require('method-override');

const seed = require('./db/seed');
const { injectLocals, requireLogin, licenseGate, licenseWarning } = require('./middleware/auth');
const { uploadsDir } = require('./middleware/upload');
const { idleTimeout, IDLE_MS } = require('./middleware/idle');

const authRoutes = require('./routes/auth');
const ticketRoutes = require('./routes/tickets');
const adminRoutes = require('./routes/admin');
const lostFoundRoutes = require('./routes/lostfound');
const accessRequestRoutes = require('./routes/access-requests');
const maintenanceRoutes = require('./routes/maintenance');
const workflowRequestRoutes = require('./routes/workflow-requests');
const notificationRoutes = require('./routes/notifications');

// Ensure schema + default data exist before serving requests
seed();

const app = express();
const PORT = process.env.PORT || 3000;

// Registered explicitly: Express would otherwise load 'ejs' dynamically, which the
// .exe packager cannot see and so would not bundle.
app.engine('ejs', require('ejs').__express);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SqliteSessionStore(),
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 }, // 12 hours
}));

app.use(idleTimeout);
app.use((req, res, next) => { res.locals.idleTimeoutMs = IDLE_MS; next(); });
app.use(injectLocals);
app.use(licenseGate);
app.use(licenseWarning);

// The hotel's own logo (set under Admin > License). Public on purpose: the sign-in page can show it.
app.get('/branding/logo', (req, res) => {
  const name = require('./utils/appSettings').getSetting('site_logo');
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return res.status(404).end();
  const file = path.join(uploadsDir, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(file);
});

// Uploaded ticket photos — only visible to signed-in staff
app.use('/uploads', requireLogin, express.static(uploadsDir));

app.use('/', authRoutes);
app.use('/tickets', ticketRoutes);
app.use('/admin', adminRoutes);
app.use('/lost-found', lostFoundRoutes);
app.use('/access-requests', accessRequestRoutes);
app.use('/maintenance', maintenanceRoutes);
app.use('/workflow-requests', workflowRequestRoutes);
app.use('/notifications', notificationRoutes);

// The browser calls this while the person is using the page, so the idle timer restarts.
app.post('/session/ping', requireLogin, (req, res) => res.status(204).end());

app.get('/', requireLogin, (req, res) => res.redirect('/home'));
app.get('/home', requireLogin, (req, res) => res.render('home', { title: 'Home' }));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong. Please try again.' });
});

const server = app.listen(PORT, () => {
  console.log(`IT Ticketing System running at http://localhost:${PORT}`);
  if (appPaths.packaged) {
    // Show the addresses other PCs on the network can use, then open the browser here.
    const nets = require('os').networkInterfaces();
    Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal)
      .forEach(n => console.log(`  Other PCs on this network can open: http://${n.address}:${PORT}`));
    console.log('Keep this window open while people use OSA. Close it to stop the system.');
    if (!process.env.OSA_NO_BROWSER) require('child_process').exec(`start "" "http://localhost:${PORT}"`);
  }
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. OSA may already be running on this PC (check the taskbar), or set a different PORT.`);
  } else {
    console.error(err);
  }
  if (appPaths.packaged) setTimeout(() => process.exit(1), 15000); // leave the message readable
  else process.exit(1);
});
