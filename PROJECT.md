# Lock-In Coach (repo: lgw2222/lockin)

Tells Garrott when to lock in each starter in the Sleeper league **The New Dynasty League**
(league 1416329086271320064, user lgw2), with stats, charts and alerts.
Site: https://lgw2222.github.io/lockin/

## Files
- `index.html` — the app (Lock-ins, Roster, Alerts, Settings tabs; player detail with charts)
- `core.js` — shared logic: loads Sleeper + ESPN data, scores games, decides lock/pass, builds alerts
- `scripts/alerts.js` + `.github/workflows/alerts.yml` — Discord alerts while the app is closed
- `config.json` — league/user/risk/time zone for the Discord bot (no secrets)
- `sw.js`, `lockin.webmanifest`, `icon-*.png` — phone notifications + install as an app

## How the call is made
Sleeper rule: lock a game only before the player's next game tips; if never locked, the LAST game
of the week counts, even a DNP (0). For each finished game the app computes the **pass value** —
what he's expected to end the week with if you pass and keep choosing smartly (backward induction
over his remaining games, using this season's games, weighted toward the last 5, padded with last
season early on, and a play chance from his injury status). Lock if this game ≥ pass value
(× 0.9 "Play it safe", × 1.1 "Swing big").

## Discord alerts (optional, one-time)
1. In Discord: Server Settings → Integrations → Webhooks → New Webhook → pick a channel → Copy Webhook URL.
2. Add it as a secret: github.com/lgw2222/lockin/settings/secrets/actions/new — name `DISCORD_WEBHOOK`.
3. Actions tab → "Lock-in alerts" → Run workflow once. The first run only learns what already
   happened (no spam); later runs post.
Never put the webhook in a file — the fantasy football one got spammed that way.

Alerts: lock/pass call when a starter's game ends, 60-min deadline reminder for "lock" calls,
"on fire" mid-game (85th+ percentile), Out/Doubtful warnings.

## Known unknowns (check on first real use)
- Sleeper's NBA scoring key names are mapped by best guess; Settings → Scoring check compares my
  score with Sleeper's for players with one finished game. If it mismatches, flip the
  double-double toggle; if still off, the key names in core.js `STAT_OF` need adjusting.
- "Looks locked" detection assumes Sleeper's matchup players_points stays on the locked game.
- Manual "I locked it" marks live in this phone's browser only; the Discord bot can't see them.

## Version
v1.0 — 2026-10-30 (Claude)
