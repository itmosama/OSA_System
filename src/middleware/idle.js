// Signs a person out after 15 minutes with no activity (OSA_IDLE_MINUTES can change it).
// "Activity" is something the person did: opening a page, saving a form, or the browser
// reporting that they moved the mouse / typed (POST /session/ping). The background
// polls that fetch notifications every 20 seconds do NOT count, otherwise a tab left
// open would keep the session alive forever.
const IDLE_MINUTES = Number(process.env.OSA_IDLE_MINUTES) || 15;
const IDLE_MS = IDLE_MINUTES * 60 * 1000;

const BACKGROUND = /\/api\/notifications$/;

function idleTimeout(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return next();

  const now = Date.now();
  const last = req.session.lastActivity || now;
  if (now - last > IDLE_MS) {
    return req.session.destroy(() => {
      const wantsJson = req.xhr || (req.get('accept') || '').includes('application/json') || BACKGROUND.test(req.path);
      if (wantsJson || req.method !== 'GET') return res.status(401).json({ expired: true, redirect: '/login?timeout=1' });
      return res.redirect('/login?timeout=1');
    });
  }
  if (!BACKGROUND.test(req.path)) req.session.lastActivity = now;
  next();
}

module.exports = { idleTimeout, IDLE_MS, IDLE_MINUTES };
