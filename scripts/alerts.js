// Discord alerts for Lock-In Coach. Runs in GitHub Actions; the webhook comes ONLY from the
// DISCORD_WEBHOOK repo secret (never put it in code — a public webhook gets spammed).
// Stays on while your players' games are live or about to start, checking every 2 minutes.
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const C = require('../core.js');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const HOOK = process.env.DISCORD_WEBHOOK;
const STATE = path.join(__dirname, '..', 'data', 'sent.json');
const MAX_MS = 5.3 * 3600e3, STARTED = Date.now();
const COLORS = { lock: 0x3BE0B0, pass: 0xF7B84B, hot: 0xFF7A59, warn: 0xFF5D6C };

const sent = new Set(fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : []);
const mem = {}; const cache = { get: k => mem[k], set: (k, v) => { mem[k] = v; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(a) {
  if (!HOOK) { console.log('[no webhook] ' + a.title + ' — ' + a.body); return; }
  const r = await fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Lock-In Coach', embeds: [{ title: a.title, description: a.body + `\n[Open Lock-In Coach](${cfg.siteUrl})`, color: COLORS[a.level] || 0x7FA8FF }] }) });
  if (r.status === 429) { await sleep(3000); return post(a); }
  if (!r.ok) console.log('Discord error', r.status, await r.text());
}
function save() {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify([...sent].slice(-600)));
  if (!process.env.GITHUB_ACTIONS) return;
  try {
    execSync('git config user.name "lockin-bot" && git config user.email "lockin-bot@users.noreply.github.com"');
    execSync('git add data/sent.json && (git diff --cached --quiet || (git commit -m "alerts state" && git pull --rebase -q && git push -q))', { stdio: 'inherit', shell: '/bin/bash' });
  } catch (e) { console.log('state push failed (will retry):', e.message); }
}

(async () => {
  const firstRun = !fs.existsSync(STATE);
  let lastSave = Date.now();
  while (true) {
    let D;
    try { D = await C.load(cfg, cache); } catch (e) { console.log('load failed:', e.message); await sleep(120e3); continue; }
    const ctx = { risk: cfg.risk, locks: D.inferredLocks, tz: cfg.tz };
    D.players.forEach(p => p.a = C.analyze(p, ctx));
    for (const a of C.alertsFor(D, ctx)) {
      if (sent.has(a.key)) continue;
      sent.add(a.key);
      if (!firstRun) await post(a); // first ever run just learns what's already happened
      console.log((firstRun ? '[seed] ' : '') + a.title);
    }
    if (Date.now() - lastSave > 20 * 6e4) { save(); lastSave = Date.now(); }
    // keep going only while a rostered player's game is live or tips within 3 hours
    const now = Date.now(), games = D.players.flatMap(p => p.week);
    const active = games.some(g => g.state === 'in' || (g.state === 'pre' && g.start - now < 3 * 3600e3 && g.start - now > -3 * 3600e3));
    if (!active || firstRun || now - STARTED > MAX_MS) break;
    await sleep(120e3);
  }
  save();
  console.log('done');
})();
