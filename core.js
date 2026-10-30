/* Lock-In Coach core — shared by index.html (browser) and scripts/alerts.js (GitHub Actions).
   Data: Sleeper public API (league, roster, matchup, injuries) + ESPN public JSON (schedule, box scores, game logs). */
(function (G) {
  'use strict';

  const SLEEPER = 'https://api.sleeper.app/v1';
  const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
  const ESPN_WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba';

  // Used only if the league's own scoring can't be read. The app checks itself against Sleeper's numbers.
  const FALLBACK_SCORING = { pts: 0.5, reb: 1, ast: 1, stl: 2, blk: 2, to: -1, tpm: 0.5, dd: 1, td: 2 };
  const S2E = { NOP: 'NO', NYK: 'NY', UTA: 'UTAH', WAS: 'WSH', GSW: 'GS', SAS: 'SA', PHO: 'PHX' };
  const RISK = { safe: 0.9, balanced: 1, gamble: 1.1 };

  const espnTeam = t => S2E[t] || t || '';
  const nmKey = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '').replace(/(jr|sr|ii|iii|iv)$/, '');
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  // NBA dates are Eastern; use ET calendar days everywhere so a 9pm CT tip isn't a "tomorrow" game
  function etDate(d) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const g = t => p.find(x => x.type === t).value;
    return g('year') + g('month') + g('day');
  }
  const dateObj = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), 12);
  const addDays = (s, n) => { const d = dateObj(s); d.setDate(d.getDate() + n); return ymd(d); };
  const dayDiff = (a, b) => Math.round((dateObj(b) - dateObj(a)) / 864e5);
  const nbaSeasonYear = (d = new Date()) => d.getMonth() >= 7 ? d.getFullYear() + 1 : d.getFullYear();

  async function getJSON(url, opt = {}, ms = 20000) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl && setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { ...opt, signal: ctl && ctl.signal });
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return await r.json();
    } finally { if (t) clearTimeout(t); }
  }

  /* ---------------- scoring ---------------- */
  const STAT_OF = {
    pts: b => b.PTS, reb: b => b.REB, ast: b => b.AST, stl: b => b.STL, blk: b => b.BLK,
    to: b => b.TO, tov: b => b.TO, turnovers: b => b.TO,
    tpm: b => b.TPM, '3pm': b => b.TPM, fg3m: b => b.TPM, tpa: b => b.TPA, '3pa': b => b.TPA,
    tpmi: b => b.TPA - b.TPM, '3pmi': b => b.TPA - b.TPM,
    fgm: b => b.FGM, fga: b => b.FGA, fgmi: b => b.FGA - b.FGM,
    ftm: b => b.FTM, fta: b => b.FTA, ftmi: b => b.FTA - b.FTM,
    oreb: b => b.OREB, dreb: b => b.DREB, pf: b => b.PF
  };
  const BONUS_STAT = { pt: 'PTS', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK' };

  function fpts(b, sc, ddStack) {
    if (!b) return 0;
    let t = 0;
    for (const k in sc) {
      const w = +sc[k]; if (!w) continue;
      if (STAT_OF[k]) { t += w * (STAT_OF[k](b) || 0); continue; }
      const m = /^bonus_([a-z]+)_(\d+)p$/.exec(k);
      if (m && BONUS_STAT[m[1]] && (b[BONUS_STAT[m[1]]] || 0) >= +m[2]) t += w;
    }
    const tens = ['PTS', 'REB', 'AST', 'STL', 'BLK'].filter(x => (b[x] || 0) >= 10).length;
    if (tens >= 3) t += (+sc.td || 0) + (ddStack ? (+sc.dd || 0) : 0);
    else if (tens >= 2) t += (+sc.dd || 0);
    return Math.round(t * 100) / 100;
  }
  const usedScoring = sc => {
    const out = {};
    for (const k in sc) if (+sc[k] && (STAT_OF[k] || k === 'dd' || k === 'td' || /^bonus_[a-z]+_\d+p$/.test(k))) out[k] = +sc[k];
    return Object.keys(out).length ? out : null;
  };

  /* ---------------- ESPN parsing ---------------- */
  const split = v => String(v || '0-0').split('-').map(x => parseInt(x) || 0);
  function boxFrom(labels, stats) {
    const get = l => { const i = labels.indexOf(l); return i < 0 ? '0' : stats[i]; };
    const [FGM, FGA] = split(get('FG')), [TPM, TPA] = split(get('3PT')), [FTM, FTA] = split(get('FT'));
    return { MIN: parseInt(get('MIN')) || 0, PTS: +get('PTS') || 0, REB: +get('REB') || 0, AST: +get('AST') || 0,
      STL: +get('STL') || 0, BLK: +get('BLK') || 0, TO: +get('TO') || 0, PF: +get('PF') || 0,
      OREB: +get('OREB') || 0, DREB: +get('DREB') || 0, FGM, FGA, TPM, TPA, FTM, FTA };
  }

  async function gameLog(espnId, season) {
    const j = await getJSON(`${ESPN_WEB}/athletes/${espnId}/gamelog?season=${season}`);
    const labels = j.labels || [], evs = j.events || {}, out = [];
    for (const st of (j.seasonTypes || [])) {
      if (/pre|post|play-?in/i.test(st.displayName || '')) continue;
      for (const cat of (st.categories || [])) for (const e of (cat.events || [])) {
        const ev = evs[e.eventId] || {};
        if (!ev.gameDate) continue;
        out.push({ id: String(e.eventId), date: etDate(new Date(ev.gameDate)), home: ev.atVs !== '@',
          opp: (ev.opponent && ev.opponent.abbreviation) || '', result: ev.gameResult || '', box: boxFrom(labels, e.stats || []) });
      }
    }
    const seen = new Set();
    return out.filter(g => !seen.has(g.id) && seen.add(g.id)).sort((a, b) => a.date.localeCompare(b.date));
  }

  async function scoreboard(day) {
    const j = await getJSON(`${ESPN_SITE}/scoreboard?dates=${day}`);
    return (j.events || []).map(e => {
      const c = (e.competitions || [])[0] || {}, st = (e.status || c.status || {}).type || {};
      const tm = (c.competitors || []).map(x => ({ abbr: x.team && x.team.abbreviation, home: x.homeAway === 'home', score: +x.score || 0 }));
      return { id: String(e.id), date: etDate(new Date(e.date)), start: new Date(e.date).getTime(), state: st.state || 'pre',
        detail: st.shortDetail || st.detail || '', teams: tm };
    });
  }

  async function boxScore(eventId) {
    const j = await getJSON(`${ESPN_SITE}/summary?event=${eventId}`);
    const out = {};
    for (const team of ((j.boxscore || {}).players || [])) for (const s of (team.statistics || [])) {
      const labels = s.labels || s.names || [];
      for (const a of (s.athletes || [])) {
        const id = a.athlete && String(a.athlete.id); if (!id) continue;
        out[id] = (a.didNotPlay || !(a.stats || []).length) ? { dnp: true, reason: a.reason || '' } : { box: boxFrom(labels, a.stats) };
      }
    }
    return out;
  }

  /* ---------------- decision model ----------------
     Sleeper rule: you can lock a game only before the player's next game tips. If you never lock,
     his LAST game of the week counts, even a DNP (0). So passing = taking your chances on the rest. */
  function sampleOf(cur, prev) {
    const s = [];
    cur.forEach((g, i) => s.push({ v: g.fp, w: i >= cur.length - 5 ? 1.3 : 1 }));
    const pw = cur.length >= 20 ? 0 : cur.length >= 10 ? 0.25 : 0.5;
    if (pw) prev.slice(-40).forEach(g => s.push({ v: g.fp, w: pw }));
    const W = s.reduce((a, x) => a + x.w, 0);
    return W >= 3 ? { pts: s, W } : null;
  }
  const expMax = (S, t) => S.pts.reduce((a, x) => a + x.w * Math.max(x.v, t), 0) / S.W;
  const mean = S => S.pts.reduce((a, x) => a + x.w * x.v, 0) / S.W;
  const pAbove = (S, x) => S.pts.reduce((a, p) => a + (p.v > x ? p.w : 0), 0) / S.W;
  const pctile = (S, x) => Math.round(100 * S.pts.reduce((a, p) => a + (p.v < x ? p.w : p.v === x ? p.w / 2 : 0), 0) / S.W);

  function playChance(inj, i) {
    const s = String(inj || '').toLowerCase();
    if (!s) return 0.95;
    if (/\b(out|ofs|sus|suspended|inactive|ir)\b/.test(s)) return 0.05;
    if (/doubt/.test(s)) return i ? 0.6 : 0.25;
    if (/quest|gtd|day/.test(s)) return i ? 0.85 : 0.6;
    if (/prob/.test(s)) return 0.9;
    return 0.9;
  }
  // value of passing on the current game = what you expect to end up with if you play the rest optimally
  function passValue(S, plays) {
    if (!plays.length) return null;
    let V = plays[plays.length - 1] * mean(S);
    for (let j = plays.length - 2; j >= 0; j--) V = plays[j] * expMax(S, V) + (1 - plays[j]) * V;
    return V;
  }
  const beatChance = (S, plays, x) => 1 - plays.reduce((a, p) => a * (1 - p * pAbove(S, x)), 1);

  function summarize(games) {
    if (!games.length) return null;
    const v = games.map(g => g.fp), n = v.length, avg = v.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - avg) ** 2, 0) / n), l5 = v.slice(-5);
    return { n, avg, sd, hi: Math.max(...v), lo: Math.min(...v), l5: l5.reduce((a, b) => a + b, 0) / l5.length,
      min: games.reduce((a, g) => a + (g.box.MIN || 0), 0) / n };
  }

  function analyze(p, ctx) {
    const S = sampleOf(p.cur, p.prev), risk = RISK[ctx.risk] || 1;
    const wk = p.week, idx = wk.findIndex(g => g.state !== 'post');
    const done = idx < 0 ? wk : wk.slice(0, idx), next = idx < 0 ? null : wk[idx];
    const a = { stats: summarize(p.cur), prevStats: summarize(p.prev), sample: S, done, next };
    const plays = arr => arr.map((g, i) => playChance(p.injury, i));
    a.expectedWeek = S && wk.length ? passValue(S, plays(wk.filter(g => g.state === 'pre'))) : null;
    const lock = ctx.locks && ctx.locks[p.sid];
    if (lock) { Object.assign(a, { status: 'locked', score: lock.fp, lockedBy: lock.by }); return a; }
    if (!wk.length) { a.status = 'nogames'; return a; }
    if (next && next.state === 'in') {
      const left = wk.slice(idx + 1);
      Object.assign(a, { status: 'live', live: next, score: next.fp || 0, autoCounts: !left.length });
      if (S) { a.pct = pctile(S, a.score); a.passValue = left.length ? passValue(S, plays(left)) : null; }
      return a;
    }
    if (!done.length) { a.status = 'waiting'; return a; }
    const cand = done[done.length - 1];
    a.cand = cand; a.score = cand.fp || 0;
    if (!next) { a.status = 'final'; if (S) a.pct = pctile(S, a.score); return a; }
    const rest = wk.slice(idx), pl = plays(rest);
    a.deadline = next.start; a.restCount = rest.length;
    a.b2b = rest.some((g, i) => dayDiff(i ? rest[i - 1].date : cand.date, g.date) === 1);
    if (!S) { a.status = cand.dnp ? 'pass' : 'decide'; a.note = 'Not enough games yet to judge — trust your gut on this one.'; return a; }
    a.pct = pctile(S, a.score);
    a.passValue = passValue(S, pl);
    a.beat = beatChance(S, pl, a.score);
    a.margin = (a.score - a.passValue * risk) / Math.max(a.passValue, 1);
    a.status = cand.dnp ? 'pass' : (a.score >= a.passValue * risk ? 'lock' : 'pass');
    a.strength = Math.abs(a.margin) > 0.2 ? 'strong' : 'lean';
    return a;
  }

  /* ---------------- loading everything ---------------- */
  async function load(cfg, cache = {}) {
    const C = cache, sc = { get: k => C.get ? C.get(k) : null, set: (k, v) => C.set && C.set(k, v) };
    const lid = cfg.leagueId;
    const [league, rosters, users, state] = await Promise.all([
      getJSON(`${SLEEPER}/league/${lid}`), getJSON(`${SLEEPER}/league/${lid}/rosters`),
      getJSON(`${SLEEPER}/league/${lid}/users`), getJSON(`${SLEEPER}/state/nba`)]);
    const uname = String(cfg.username || '').toLowerCase();
    const me = users.find(u => (u.display_name || '').toLowerCase() === uname || (u.username || '').toLowerCase() === uname);
    if (!me) throw new Error(`Couldn't find "${cfg.username}" in this league. Check the Sleeper username in Settings.`);
    const roster = rosters.find(r => r.owner_id === me.user_id || (r.co_owners || []).includes(me.user_id));
    if (!roster) throw new Error('Found you in the league but not your roster.');
    const week = cfg.week || state.week || 1;
    let matchups = [];
    try { matchups = await getJSON(`${SLEEPER}/league/${lid}/matchups/${week}`); } catch (e) {}
    const mine = matchups.find(m => m.roster_id === roster.roster_id) || {};
    const oppM = mine.matchup_id ? matchups.find(m => m.matchup_id === mine.matchup_id && m.roster_id !== roster.roster_id) : null;
    const oppR = oppM && rosters.find(r => r.roster_id === oppM.roster_id);
    const oppU = oppR && users.find(u => u.user_id === oppR.owner_id);

    // players: slim copy cached for a day
    let P = sc.get('players');
    if (!P || P.day !== etDate(new Date())) {
      const raw = await getJSON(`${SLEEPER}/players/nba`, {}, 45000), m = {};
      for (const id in raw) { const q = raw[id]; if (!q || !q.full_name) continue;
        m[id] = [q.full_name, q.team || 'FA', (q.fantasy_positions || [q.position]).filter(Boolean).join('/'), q.injury_status || '', q.espn_id ? String(q.espn_id) : ''];
      }
      P = { day: etDate(new Date()), m }; sc.set('players', P);
    }
    // ESPN ids by name (only if Sleeper doesn't carry them)
    const ids = (roster.players || []).filter(id => P.m[id]);
    let E = null;
    if (ids.some(id => !P.m[id][4])) {
      E = sc.get('espnIds');
      if (!E || E.day !== P.day) {
        const f = { filterActive: { value: true }, limit: 1500 };
        const list = await getJSON(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${nbaSeasonYear()}/players?scoringPeriodId=0&view=players_wl`,
          { headers: { 'X-Fantasy-Filter': JSON.stringify(f) } }, 30000).catch(() => []);
        E = { day: P.day, m: {} }; for (const x of list) E.m[nmKey(x.fullName)] = String(x.id);
        sc.set('espnIds', E);
      }
    }
    const scoring = usedScoring(league.scoring_settings || {}) || FALLBACK_SCORING;

    // this week = Monday..Sunday (Sleeper NBA weeks), in ET days
    const today = etDate(new Date()), dow = (dateObj(today).getDay() + 6) % 7;
    const wkStart = cfg.weekStart || addDays(today, -dow);
    const days = Array.from({ length: 7 }, (_, i) => addDays(wkStart, i));
    const boards = (await Promise.all(days.map(d => scoreboard(d).catch(() => [])))).flat();

    const starters = new Set((mine.starters || roster.starters || []).filter(x => x && x !== '0'));
    const pts = mine.players_points || {};
    const season = nbaSeasonYear(dateObj(wkStart));
    const boxCache = {};
    const getBox = async g => {
      const k = 'box:' + g.id;
      if (g.state === 'post') { const c = sc.get(k); if (c) return c; }
      if (!boxCache[g.id]) boxCache[g.id] = boxScore(g.id).then(b => { if (g.state === 'post') sc.set(k, b); return b; }).catch(() => ({}));
      return boxCache[g.id];
    };
    const logCached = async (eid, yr, ttlMin) => {
      const k = `log:${eid}:${yr}`, c = sc.get(k);
      if (c && (ttlMin < 0 || Date.now() - c.t < ttlMin * 6e4)) return c.g;
      const g = await gameLog(eid, yr).catch(() => null);
      if (g) sc.set(k, { t: Date.now(), g });
      return g || (c && c.g) || [];
    };

    const players = await Promise.all(ids.map(async sid => {
      const [name, team, pos, injury, espnFromSleeper] = P.m[sid];
      const espnId = espnFromSleeper || (E && E.m[nmKey(name)]) || '';
      const et = espnTeam(team);
      const games = boards.filter(g => g.teams.some(t => t.abbr === et)).sort((a, b) => a.start - b.start);
      const [cur, prev] = espnId ? await Promise.all([logCached(espnId, season, 30), logCached(espnId, season - 1, -1)]) : [[], []];
      const curHist = cur.filter(g => g.date < wkStart);
      const week = await Promise.all(games.map(async g => {
        const mt = g.teams.find(t => t.abbr === et), op = g.teams.find(t => t.abbr !== et) || {};
        const w = { id: g.id, date: g.date, start: g.start, state: g.state, detail: g.detail, home: !!mt.home, opp: op.abbr || '',
          result: g.state === 'post' ? ((mt.score > op.score ? 'W ' : 'L ') + mt.score + '-' + op.score) : '' };
        if (g.state !== 'pre' && espnId) {
          const b = (await getBox(g))[espnId];
          if (b && b.box) { w.box = b.box; w.fp = fpts(b.box, scoring, cfg.ddStack); }
          else { w.dnp = g.state === 'post'; w.fp = 0; w.reason = b && b.reason; }
        }
        return w;
      }));
      const withFp = arr => arr.map(g => ({ ...g, fp: fpts(g.box, scoring, cfg.ddStack) }));
      const curAll = withFp(curHist).concat(week.filter(g => g.state === 'post' && g.box).map(g => ({ ...g })));
      return { sid, name, team, pos, injury, espnId, starter: starters.has(sid), sleeperPts: pts[sid],
        cur: curAll, prev: withFp(prev), week };
    }));

    // spot when Sleeper's number shows a lock (score stuck on an earlier game after a later one finished)
    const inferredLocks = {};
    for (const p of players) {
      if (p.sleeperPts == null) continue;
      const done = p.week.filter(g => g.state === 'post');
      if (done.length < 2) continue;
      const last = done[done.length - 1];
      if (Math.abs((last.fp || 0) - p.sleeperPts) < 0.01) continue;
      const hit = done.slice(0, -1).reverse().find(g => Math.abs((g.fp || 0) - p.sleeperPts) < 0.01);
      if (hit) inferredLocks[p.sid] = { fp: hit.fp, date: hit.date, by: 'sleeper' };
    }
    // scoring check: players with exactly one finished game this week and no game live
    const checks = players.filter(p => p.sleeperPts != null && p.week.filter(g => g.state === 'post').length === 1 && !p.week.some(g => g.state === 'in'))
      .map(p => { const g = p.week.find(x => x.state === 'post'); return { name: p.name, mine: g.fp || 0, sleeper: p.sleeperPts }; });
    const matched = checks.filter(c => Math.abs(c.mine - c.sleeper) < 0.01).length;

    return {
      league: { id: lid, name: league.name, avatar: league.avatar }, week, days, wkStart, scoring,
      scoringFromLeague: !!usedScoring(league.scoring_settings || {}),
      me: { name: (me.metadata && me.metadata.team_name) || me.display_name, user: me.display_name, avatar: me.avatar, points: mine.points || 0,
        record: roster.settings ? `${roster.settings.wins || 0}-${roster.settings.losses || 0}` : '' },
      opp: oppM ? { name: (oppU && oppU.metadata && oppU.metadata.team_name) || (oppU && oppU.display_name) || 'Opponent',
        user: oppU && oppU.display_name, avatar: oppU && oppU.avatar, points: oppM.points || 0,
        record: oppR && oppR.settings ? `${oppR.settings.wins || 0}-${oppR.settings.losses || 0}` : '' } : null,
      players, inferredLocks, scoringCheck: { checked: checks.length, matched, rows: checks }, loadedAt: Date.now()
    };
  }

  /* ---------------- alerts ---------------- */
  function fmtTime(ms, tz) {
    return new Date(ms).toLocaleString('en-US', { timeZone: tz || undefined, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const f1 = x => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
  function alertsFor(D, ctx, now = Date.now()) {
    const out = [], tz = ctx.tz;
    for (const p of D.players) {
      if (!p.starter) continue;
      const a = p.a || analyze(p, ctx);
      const nm = p.name;
      if ((a.status === 'lock' || a.status === 'pass') && a.cand) {
        const why = a.passValue != null ? `Pass value ${f1(a.passValue)} with ${a.restCount} game${a.restCount > 1 ? 's' : ''} left · ${Math.round(a.beat * 100)}% chance a later game beats it` : (a.note || '');
        out.push({ key: `final:${a.cand.id}:${p.sid}`, level: a.status,
          title: a.status === 'lock' ? `🔒 Lock ${nm}: ${f1(a.score)} pts` : `⏭️ Pass on ${nm}: ${f1(a.score)} pts`,
          body: `${a.cand.dnp ? 'Did not play. ' : ''}${a.pct != null ? ord(a.pct) + ' percentile for him. ' : ''}${why}. Deadline ${fmtTime(a.deadline, tz)}.` });
        const mins = (a.deadline - now) / 6e4;
        if (a.status === 'lock' && mins > 0 && mins <= 60)
          out.push({ key: `deadline:${a.next.id}:${p.sid}`, level: 'warn', title: `⏰ ${Math.round(mins)} min to lock ${nm} (${f1(a.score)})`,
            body: `His next game tips ${fmtTime(a.deadline, tz)}. Ignore if you already locked him.` });
      }
      if (a.status === 'live' && a.sample && a.pct >= 85 && (a.passValue == null || a.score >= a.passValue))
        out.push({ key: `hot:${a.live.id}:${p.sid}`, level: 'hot', title: `🔥 ${nm} has ${f1(a.score)} pts (${a.live.detail})`,
          body: `Already ${ord(a.pct)} percentile for him. ${a.autoCounts ? 'This is his last game, so it counts.' : 'Get ready to lock it when it ends.'}` });
      if (/out|doubt/i.test(p.injury || '') && !['locked', 'final', 'live'].includes(a.status) && a.next)
        out.push({ key: `inj:${D.week}:${p.sid}:${p.injury}`, level: 'warn', title: `⚠️ ${nm} is ${p.injury}`,
          body: a.cand ? `Lock his ${f1(a.score)} before ${fmtTime(a.deadline, tz)} or swap him out — an unlocked last game counts even if he sits.` :
            `He has no game to lock yet. Swap in a bench player who plays this week.` });
    }
    return out;
  }

  const API = { load, analyze, alertsFor, fpts, passValue, sampleOf, beatChance, pctile, playChance, summarize,
    etDate, addDays, nbaSeasonYear, fmtTime, f1, ord, RISK, FALLBACK_SCORING };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else G.LockCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
