// VENDOR-ONLY license generator. This is a completely separate mini-app from
// the hotel-facing system in src/ — it is NEVER deployed to a client, is
// never bundled with the main app, and runs on a different port, purely as a
// convenience so you (the vendor) don't have to remember CLI flags.
//
// Run it with: npm run license-tool
// Then open:   http://localhost:4100
//
// Protection: a single local password (set in vendor-tool/.env, see
// vendor-tool/.env.example) gates access. This is a local convenience gate,
// not a hardened auth system — the real protection is that this whole folder
// and license-private-key.pem never leave your machine. See vendor-tool/README.md.

const paths = require('./paths');

// `license-tool.exe set-password "new-password"` — lets the packaged build set
// its password without needing Node installed on that PC.
if (process.argv[2] === 'set-password') {
  try {
    console.log(`Password set. Saved (hashed) to ${require('./password').setPassword(process.argv[3])}.`);
    process.exit(0);
  } catch (e) {
    console.error('Usage: license-tool set-password "your-new-password"');
    console.error(e.message);
    process.exit(1);
  }
}

// pdfkit loads its built-in fonts through a package-internal alias
// ("#standard-fonts/Helvetica"), which the .exe packager can't resolve. In the
// packaged build, point the alias at the font files bundled alongside it.
if (paths.packaged) {
  const Module = require('module');
  const fontsDir = require('path').join(__dirname, '..', 'node_modules', 'pdfkit', 'js', 'standard-fonts');
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (typeof request === 'string' && request.startsWith('#standard-fonts/')) {
      request = require('path').join(fontsDir, request.slice('#standard-fonts/'.length) + '.cjs');
    }
    return originalResolve.call(this, request, ...rest);
  };
}

require('dotenv').config({ path: paths.envPath });

const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { buildLicenseString, encryptLicenseFile } = require('../src/utils/licenseCrypto');
const { saveRecord, listWithStatus, getByRecordId, generateSerialNumber, isLicenseIdTaken } = require('./licenseStore');

const PORT = process.env.VENDOR_TOOL_PORT || 4100;
const PASSWORD_HASH = process.env.VENDOR_TOOL_PASSWORD_HASH;
const KEY_PATH = paths.keyPath;

const app = express();
// Registered explicitly (Express would otherwise require 'ejs' dynamically,
// which the .exe packager can't see and so wouldn't bundle).
app.engine('ejs', require('ejs').__express);
app.set('view engine', 'ejs');
app.set('views', paths.viewsDir);
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.VENDOR_TOOL_SESSION_SECRET || 'vendor-tool-local-only-' + Math.random(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 4 },
}));

function requireAuth(req, res, next) {
  if (req.session.authed) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (!PASSWORD_HASH) {
    return res.render('login', {
      error: 'No password set yet. Run: ' + (paths.packaged
        ? 'license-tool.exe set-password "your-password"'
        : 'node vendor-tool/set-password.js "your-password"') + ', then restart the tool.',
    });
  }
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  if (!PASSWORD_HASH) return res.redirect('/login');
  if (bcrypt.compareSync(req.body.password || '', PASSWORD_HASH)) {
    req.session.authed = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'Incorrect password.' });
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

function keyStatus() {
  if (!fs.existsSync(KEY_PATH)) {
    return `Private key not found at ${KEY_PATH}. Copy license-private-key.pem there from the machine where it was generated.`;
  }
  return null;
}

app.get('/', requireAuth, (req, res) => {
  res.render('generate', { result: null, error: keyStatus(), values: { site: '', license_id: '', expires: '' }, licenses: listWithStatus() });
});

app.post('/', requireAuth, (req, res) => {
  const { site, license_id, expires } = req.body;
  const keyError = keyStatus();
  const render = (error, values) => res.render('generate', { result: null, error, values, licenses: listWithStatus() });

  if (keyError) return render(keyError, req.body);
  if (!site || !site.trim()) return render('Site name is required.', req.body);
  if (!license_id || !license_id.trim()) return render('License ID is required.', req.body);
  if (isLicenseIdTaken(license_id)) return render(`License ID "${license_id.trim()}" is already in use — choose a different one.`, req.body);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires || '')) return render('A valid expiry date is required.', req.body);

  const privateKeyPem = fs.readFileSync(KEY_PATH, 'utf8');
  const payload = {
    site: site.trim(),
    id: license_id.trim(),
    sn: generateSerialNumber(site.trim()),
    issued: new Date().toISOString().slice(0, 10),
    expires,
  };
  const licenseString = buildLicenseString(payload, privateKeyPem);

  const recordId = saveRecord({
    site: payload.site,
    id: payload.id,
    sn: payload.sn,
    issued: payload.issued,
    expires: payload.expires,
    generatedAt: new Date().toISOString(),
    licenseString,
  });

  res.render('generate', {
    result: { licenseString, payload, recordId },
    error: null,
    values: { site: '', license_id: '', expires: '' },
    licenses: listWithStatus(),
  });
});

// Read-only overview of every license issued — deliberately does not surface
// the license string/code anywhere on this page.
app.get('/reports', requireAuth, (req, res) => {
  res.render('reports', { licenses: listWithStatus() });
});

app.get('/reports/pdf', requireAuth, (req, res) => {
  // Path form on purpose: pdfkit only declares package "exports", which the
  // .exe packager ignores, so it needs the concrete file to bundle it.
  const PDFDocument = require('../node_modules/pdfkit/js/pdfkit.js');
  const licenses = listWithStatus();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="license-report.pdf"');

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  doc.fontSize(16).text('License Report', { align: 'left' });
  doc.fontSize(9).fillColor('#666').text(`Generated ${new Date().toISOString().slice(0, 10)} — ${licenses.length} license(s)`);
  doc.fillColor('#000').moveDown(1);

  const colX = { site: 40, id: 175, sn: 300, created: 445, expires: 520, days: 600, status: 680 };
  const rowTop = () => doc.y;

  function drawHeader() {
    const top = doc.y;
    doc.rect(40, top, doc.page.width - 80, 18).fill('#343a40');
    const y = top + 5;
    doc.fontSize(9).fillColor('#fff');
    doc.text('Hotel / Site', colX.site, y);
    doc.text('License ID', colX.id, y);
    doc.text('SN', colX.sn, y);
    doc.text('Created', colX.created, y);
    doc.text('Expires', colX.expires, y);
    doc.text('Days Left', colX.days, y);
    doc.text('Status', colX.status, y);
    doc.y = top + 22;
    doc.fillColor('#000');
  }

  drawHeader();
  doc.fontSize(9);
  licenses.forEach((l, i) => {
    if (doc.y > doc.page.height - 60) {
      doc.addPage({ margin: 40, size: 'A4', layout: 'landscape' });
      drawHeader();
    }
    const y = rowTop();
    if (i % 2 === 0) doc.rect(40, y, doc.page.width - 80, 16).fill('#f5f6f8').fillColor('#000');
    const daysLabel = l.expired ? `${Math.abs(l.daysRemaining)}d ago` : `${l.daysRemaining}d`;
    const status = l.expired ? 'Expired' : (l.daysRemaining <= 30 ? 'Expiring Soon' : 'Active');
    doc.text(l.site, colX.site, y + 3, { width: 130 });
    doc.text(l.id || '-', colX.id, y + 3, { width: 120 });
    doc.text(l.sn || '-', colX.sn, y + 3, { width: 140 });
    doc.text(l.issued, colX.created, y + 3, { width: 70 });
    doc.text(l.expires, colX.expires, y + 3, { width: 70 });
    doc.text(daysLabel, colX.days, y + 3, { width: 75 });
    doc.text(status, colX.status, y + 3, { width: 100 });
    doc.moveDown(1.15);
  });

  if (licenses.length === 0) {
    doc.fontSize(10).fillColor('#666').text('No licenses generated yet.', 40, doc.y + 5);
  }

  doc.end();
});

// Downloads a previously-generated license as an encrypted .lic file, so it
// doesn't need to be re-generated just to hand it out as a file.
app.get('/download/:recordId', requireAuth, (req, res) => {
  const record = getByRecordId(req.params.recordId);
  if (!record) return res.status(404).send('License not found.');

  const encrypted = encryptLicenseFile(record.licenseString);
  const filenameSafeSite = record.site.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameSafeSite}-license.lic"`);
  res.send(encrypted);
});

// Bound to localhost only: the private key signs licenses, so the tool must
// never be reachable from other machines on the network.
app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Vendor license tool running at ${url} — local use only.`);
  if (paths.packaged) {
    console.log('Keep this window open while you use it; close it to stop the tool.');
    if (!process.env.VENDOR_TOOL_NO_BROWSER) require('child_process').exec(`start "" "${url}"`);
  }
});
