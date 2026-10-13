const nodemailer = require('nodemailer');

// Email is optional: if SMTP isn't configured, sendMail() just logs and skips
// instead of throwing, so the rest of the app works fully without it. Fill in
// SMTP_HOST/PORT/USER/PASS/FROM in .env to turn it on.
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendMail({ to, subject, html }) {
  if (!transporter || !to) {
    console.log(`[mailer] SMTP not configured or no recipient — skipping email "${subject}" to ${to || '(none)'}`);
    return false;
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, html,
    });
    return true;
  } catch (err) {
    console.error('[mailer] Failed to send email:', err.message);
    return false;
  }
}

module.exports = { sendMail };
