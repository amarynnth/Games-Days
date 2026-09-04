const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });

const GAMES_DIR = path.join(__dirname, 'games');
const ARCHIVE_DIR = path.join(__dirname, 'archives');
[GAMES_DIR, ARCHIVE_DIR].forEach((d) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Seconds. A game file can set these, and the host can override them on the
// start screen — a manual override sticks even when a new game is loaded.
const DEFAULT_TIMERS = { buzz: 8, answer: 10 };
let timerSettings = { ...DEFAULT_TIMERS, manual: false };
const liveTimers = () => ({ buzz: timerSettings.buzz, answer: timerSettings.answer });

function localIP() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push({ name, address: net.address });
    }
  }
  const preferred = candidates.find((c) => /^192\.168\./.test(c.address))
    || candidates.find((c) => /^10\./.test(c.address))
    || candidates[0];
  return preferred ? preferred.address : 'localhost';
}

const HOST_IP = localIP();
const LAN_URL = `http://${HOST_IP}:${PORT}/play`;

// When deployed, PUBLIC_URL (or the incoming request's own host) is what phones
// should scan — the LAN address is meaningless off the local network.
const PUBLIC_URL = process.env.PUBLIC_URL || '';
function joinUrlFor(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '') + '/play';
  const host = req && req.get && req.get('host');
  const proto = (req && (req.get('x-forwarded-proto') || req.protocol)) || 'http';
  // A hosted box sits behind a proxy and forwards the real protocol.
  if (host && req.get('x-forwarded-proto')) return `${proto}://${host}/play`;
  return LAN_URL;
}
let JOIN_URL = LAN_URL;


// ------------------------------------------------- answer matching (host types)

function normAns(t) {
  return String(t || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(a|an|the|some|your|my|his|her|their|of|to)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Score how well typed text matches one board answer. 0 means no match.
function matchScore(typed, answer) {
  const t = normAns(typed);
  if (!t) return 0;
  const candidates = [answer.text, ...(answer.alt || [])].map(normAns).filter(Boolean);
  let best = 0;
  for (const c of candidates) {
    if (t === c) { best = Math.max(best, 100); continue; }
    if (c.includes(t) || t.includes(c)) { best = Math.max(best, 85); continue; }
    const tw = new Set(t.split(' ')), cw = c.split(' ');
    const shared = cw.filter((w) => w.length > 2 && tw.has(w)).length;
    if (shared) { best = Math.max(best, 60 + shared * 5); continue; }
    // tolerate a typo or two on short answers
    const d = editDistance(t, c);
    if (d <= (c.length > 6 ? 2 : 1)) best = Math.max(best, 70);
  }
  return best;
}

// Returns the index of the best unmatched answer, or -1.
function findAnswer(typed, answers, skip = []) {
  let bestI = -1, bestS = 0;
  answers.forEach((a, i) => {
    if (skip.includes(i)) return;
    const sc = matchScore(typed, a);
    if (sc > bestS) { bestS = sc; bestI = i; }
  });
  return bestS >= 60 ? bestI : -1;
}

// ---------------------------------------------------------------- game state

const blankBuzzer = () => ({ armed: false, lockedBy: null, order: [], outTeams: [], expired: false });

const blankState = () => ({
  title: 'No game loaded',
  rounds: [],
  roundIndex: 0,
  final: null,
  timers: liveTimers(),
  mode: 'jeopardy',          // jeopardy | feud
  phase: 'lobby',            // lobby | board | clue | final | feud
  activeClue: null,
  feud: null,                // set when a Feud game is loaded
  fastMoney: null,           // set when Fast Money is running
  buzzer: blankBuzzer(),
  timer: null,               // { kind, seconds, endsAt, paused, remaining }
  startedAt: null,
});

let state = blankState();

// Roster lives outside `state` so it survives starting a new game.
const players = new Map();
const teams = new Map();
const teamsOn = () => teams.size > 0;
let teamSeq = 0;

function publicState() {
  const teamList = [...teams.values()].map((t) => ({
    ...t,
    members: [...players.values()].filter((p) => p.teamId === t.id)
      .map((p) => ({ name: p.name, connected: p.connected })),
  })).sort((a, b) => b.score - a.score);

  return {
    ...state,
    teamsOn: teamsOn(),
    teams: teamList,
    players: [...players.values()].sort((a, b) => b.score - a.score),
    joinUrl: JOIN_URL,
    timerSettings: { ...timerSettings },
    serverNow: Date.now(),   // lets phones correct for clock drift
  };
}

const push = () => io.emit('state', publicState());
const currentRound = () => state.rounds[state.roundIndex] || null;

function scoreHolder(playerId) {
  const p = players.get(playerId);
  if (!p) return null;
  if (teamsOn()) return p.teamId ? teams.get(p.teamId) : null;
  return p;
}

// What this clue is worth right now — Daily Doubles pay double, both ways.
const clueValue = () => {
  const ac = state.activeClue;
  if (!ac) return 0;
  return ac.dailyDouble ? ac.value * 2 : ac.value;
};

// ------------------------------------------------------------------- timers

let timerHandle = null;

function stopTimer() {
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
  state.timer = null;
}

function startTimer(kind, seconds, onExpire) {
  if (timerHandle) clearTimeout(timerHandle);
  if (!seconds || seconds <= 0) { state.timer = null; return; }
  state.timer = { kind, seconds, endsAt: Date.now() + seconds * 1000, paused: false, remaining: seconds * 1000 };
  timerHandle = setTimeout(() => { timerHandle = null; state.timer = null; onExpire(); }, seconds * 1000);
}

function pauseTimer() {
  if (!state.timer || state.timer.paused) return;
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
  state.timer.remaining = Math.max(0, state.timer.endsAt - Date.now());
  state.timer.paused = true;
}

function resumeTimer(onExpire) {
  if (!state.timer || !state.timer.paused) return;
  const ms = state.timer.remaining;
  state.timer.paused = false;
  state.timer.endsAt = Date.now() + ms;
  timerHandle = setTimeout(() => { timerHandle = null; state.timer = null; onExpire(); }, ms);
}

// Nobody buzzed in time.
function onBuzzTimeout() {
  state.buzzer.armed = false;
  state.buzzer.expired = true;
  push();
}

// The clock ran out on whoever was answering: same as getting it wrong.
function onAnswerTimeout() {
  resolveMiss();
  push();
}

// Shared by "wrong answer" and "ran out of time".
function allEliminated() {
  if (teamsOn()) return teams.size > 0 && state.buzzer.outTeams.length >= teams.size;
  const eligible = [...players.values()].filter((p) => !state.buzzer.order.some((o) => o.id === p.id && o.out));
  return eligible.length === 0;
}

function resolveMiss() {
  const id = state.buzzer.lockedBy;
  if (!id) return;
  const holder = scoreHolder(id);
  if (holder) holder.score -= clueValue();

  const entry = state.buzzer.order.find((o) => o.id === id);
  const p = players.get(id);

  // The team forfeits the clue — teammates further down the queue are skipped.
  if (teamsOn() && p && p.teamId) {
    if (!state.buzzer.outTeams.includes(p.teamId)) state.buzzer.outTeams.push(p.teamId);
    state.buzzer.order.forEach((o) => { if (o.teamId === p.teamId) o.out = true; });
  } else if (entry) {
    entry.out = true;
  }

  const next = state.buzzer.order.find((o) => !o.out);
  if (next) {
    state.buzzer.lockedBy = next.id;
    state.buzzer.armed = true;
    startTimer('answer', state.timers.answer, onAnswerTimeout);
  } else if (allEliminated()) {
    // Nobody left who's allowed to answer — don't leave the board hanging.
    state.buzzer.lockedBy = null;
    state.buzzer.armed = false;
    state.buzzer.expired = true;
    stopTimer();
  } else {
    state.buzzer.lockedBy = null;
    state.buzzer.armed = true;
    startTimer('buzz', state.timers.buzz, onBuzzTimeout);
  }
}

// --------------------------------------------------------------- game loading

// A Feud file looks like { type:"feud", rounds:[{ name, questions:[
//   { prompt, multiplier, answers:[{ text, points }] } ] }] }
function normalizeFeud(raw) {
  const rounds = (raw.rounds || []).map((rd, ri) => ({
    name: rd.name || `Round ${ri + 1}`,
    questions: (rd.questions || []).map((q) => ({
      prompt: q.prompt || '',
      multiplier: Number(q.multiplier) || Number(rd.multiplier) || 1,
      answers: (q.answers || [])
        .map((a) => ({ text: a.text || '', points: Number(a.points) || 0, alt: a.alt || [] }))
        .sort((a, b) => b.points - a.points),   // board always reads top-down
      used: false,
    })),
  }));
  const fm = (raw.fastMoney && raw.fastMoney.questions) || raw.fastMoney || [];
  return {
    title: raw.title || 'Untitled game',
    mode: 'feud',
    rounds,
    fastMoneyBank: (Array.isArray(fm) ? fm : []).map((q) => ({
      prompt: q.prompt || '',
      answers: (q.answers || [])
        .map((a) => ({ text: a.text || '', points: Number(a.points) || 0, alt: a.alt || [] }))
        .sort((a, b) => b.points - a.points),
    })),
    fastMoneyTarget: Number((raw.fastMoney && raw.fastMoney.target)) || 200,
    fileTimers: raw.timers || null,
  };
}

function blankFeud() {
  return {
    qIndex: null,
    revealed: [],
    strikes: 0,
    pot: 0,
    control: null,       // team id (or player id when playing solo)
    stealer: null,
    stage: 'idle',       // idle | faceoff | play | steal | awarded
    lastStrikeAt: 0,
    lastGuess: null,     // { text, hit, at } — what the host last typed
  };
}

function feudQuestion() {
  if (!state.feud || state.feud.qIndex === null) return null;
  const rd = state.rounds[state.roundIndex];
  return rd ? rd.questions[state.feud.qIndex] || null : null;
}

function normalizeGame(raw) {
  const rounds = raw.rounds ? raw.rounds
    : [{ name: raw.roundName || 'Round 1', categories: raw.categories || [] }];

  const built = rounds.map((rd, ri) => ({
    name: rd.name || `Round ${ri + 1}`,
    dailyDoubles: rd.dailyDoubles,
    categories: (rd.categories || []).map((cat) => ({
      name: cat.name || '',
      clues: (cat.clues || []).map((cl, i) => ({
        value: Number(cl.value) || (i + 1) * 200,
        clue: cl.clue || '',
        answer: cl.answer || '',
        dailyDouble: !!cl.dailyDouble,
        used: false,
      })),
    })),
  }));

  // If a round asks for N random Daily Doubles and none were marked by hand,
  // scatter them across clues that actually have text.
  built.forEach((rd) => {
    const want = Number(rd.dailyDoubles !== undefined ? rd.dailyDoubles : raw.dailyDoubles) || 0;
    const alreadyMarked = rd.categories.some((c) => c.clues.some((cl) => cl.dailyDouble));
    if (!want || alreadyMarked) return;
    const pool = [];
    rd.categories.forEach((c, ci) => c.clues.forEach((cl, i) => { if (cl.clue.trim()) pool.push([ci, i]); }));
    for (let n = 0; n < Math.min(want, pool.length); n++) {
      const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      rd.categories[pick[0]].clues[pick[1]].dailyDouble = true;
    }
  });

  return {
    title: raw.title || 'Untitled game',
    rounds: built,
    final: raw.final || raw.finalJeopardy || null,
    fileTimers: raw.timers || null,
  };
}

// ------------------------------------------------------------------- routes

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));

app.get('/api/join', async (req, res) => {
  JOIN_URL = joinUrlFor(req);          // remember it so the board header matches
  const qr = await QRCode.toDataURL(JOIN_URL, { margin: 1, width: 640, color: { dark: '#070C2E', light: '#F5F1E6' } });
  res.json({ url: JOIN_URL, qr });
});

app.get('/api/games', (_req, res) => {
  const files = fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.json'));
  res.json(files.map((f) => {
    let title = f;
    try { title = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), 'utf8')).title || f; } catch (_) {}
    return { file: f, title };
  }));
});

app.get('/api/games/:file', (req, res) => {
  const p = path.join(GAMES_DIR, path.basename(req.params.file));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Game file not found.' });
  res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
});

app.get('/api/archives', (_req, res) => {
  const files = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
  res.json(files.map((f) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')); } catch (_) {}
    return { file: f, title: meta.title, playedAt: meta.playedAt, winner: (meta.finalScores || [])[0] };
  }));
});

app.get('/archives/:file', (req, res) => res.download(path.join(ARCHIVE_DIR, path.basename(req.params.file))));

// ------------------------------------------------------------------ sockets

io.on('connection', (socket) => {
  socket.emit('state', publicState());

  // ---- players
  socket.on('player:join', ({ playerId, name, teamId }) => {
    if (!playerId) return;
    const clean = String(name || '').trim().slice(0, 18) || 'Player';
    const existing = players.get(playerId);
    if (existing) {
      existing.name = clean;
      existing.connected = true;
      if (teamId !== undefined) existing.teamId = teams.has(teamId) ? teamId : null;
    } else {
      players.set(playerId, { id: playerId, name: clean, score: 0, connected: true, teamId: teams.has(teamId) ? teamId : null });
    }
    socket.data.playerId = playerId;
    push();
  });

  socket.on('player:setTeam', ({ teamId }) => {
    const p = players.get(socket.data.playerId);
    if (!p) return;
    p.teamId = teams.has(teamId) ? teamId : null;
    push();
  });

  socket.on('player:buzz', () => {
    const id = socket.data.playerId;
    if (!id || !state.buzzer.armed) return;
    const p = players.get(id);
    if (!p) return;
    if (teamsOn() && !p.teamId) return;                              // must be on a team
    if (state.buzzer.order.some((o) => o.id === id)) return;         // one buzz each
    if (p.teamId && state.buzzer.outTeams.includes(p.teamId)) return; // team already forfeited

    const now = Date.now();
    const first = state.buzzer.order[0];
    const team = p.teamId ? teams.get(p.teamId) : null;
    state.buzzer.order.push({
      id, name: p.name,
      teamId: p.teamId || null,
      teamName: team ? team.name : null,
      t: now, delta: first ? now - first.t : 0, out: false,
    });

    if (!state.buzzer.lockedBy) {
      // Buzzers stay open — everyone else can still line up behind the leader.
      state.buzzer.lockedBy = id;
      startTimer('answer', state.timers.answer, onAnswerTimeout);
    }
    push();
  });

  socket.on('disconnect', () => {
    const id = socket.data.playerId;
    if (id && players.has(id)) { players.get(id).connected = false; push(); }
  });

  // ---- roster
  socket.on('host:addTeam', ({ name }) => {
    const clean = String(name || '').trim().slice(0, 20);
    if (!clean) return;
    const id = 't' + (++teamSeq);
    teams.set(id, { id, name: clean, score: 0 });
    push();
  });

  socket.on('host:removeTeam', ({ teamId }) => {
    teams.delete(teamId);
    players.forEach((p) => { if (p.teamId === teamId) p.teamId = null; });
    push();
  });

  socket.on('host:clearTeams', () => {
    teams.clear();
    players.forEach((p) => { p.teamId = null; });
    push();
  });

  socket.on('host:movePlayer', ({ playerId, teamId }) => {
    const p = players.get(playerId);
    if (p) p.teamId = teams.has(teamId) ? teamId : null;
    push();
  });

  socket.on('host:removePlayer', ({ playerId }) => {
    players.delete(playerId);
    state.buzzer.order = state.buzzer.order.filter((o) => o.id !== playerId);
    if (state.buzzer.lockedBy === playerId) {
      const next = state.buzzer.order.find((o) => !o.out);
      state.buzzer.lockedBy = next ? next.id : null;
      if (!next) { stopTimer(); state.buzzer.armed = true; }
    }
    push();
  });

  socket.on('host:clearPlayers', ({ keepConnected }) => {
    [...players.values()].forEach((p) => { if (!keepConnected || !p.connected) players.delete(p.id); });
    stopTimer();
    state.buzzer = blankBuzzer();
    push();
  });

  // ---- game flow
  socket.on('host:load', (raw) => {
    stopTimer();
    const isFeud = raw.type === 'feud' || (raw.rounds || []).some((r) => r.questions);
    const g = isFeud ? normalizeFeud(raw) : normalizeGame(raw);
    // The host's own setting wins; otherwise take whatever the file asks for.
    if (!timerSettings.manual && g.fileTimers) {
      timerSettings = { ...timerSettings, ...g.fileTimers, manual: false };
    }
    delete g.fileTimers;
    state = {
      ...blankState(), ...g,
      timers: liveTimers(),
      phase: isFeud ? 'feud' : 'board',
      feud: isFeud ? blankFeud() : null,
      fastMoney: null,
      startedAt: Date.now(),
    };
    players.forEach((p) => { p.score = 0; });
    teams.forEach((t) => { t.score = 0; });
    push();
  });

  // Seconds; 0 turns a clock off entirely. Takes effect on the next clue.
  socket.on('host:setTimers', ({ buzz, answer }) => {
    const clamp = (v, fallback) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 0) return fallback;
      return Math.min(n, 120);
    };
    timerSettings = {
      buzz: clamp(buzz, timerSettings.buzz),
      answer: clamp(answer, timerSettings.answer),
      manual: true,
    };
    state.timers = liveTimers();
    push();
  });

  socket.on('host:resetTimers', () => {
    timerSettings = { ...DEFAULT_TIMERS, manual: false };
    state.timers = liveTimers();
    push();
  });

  socket.on('host:selectClue', ({ c, i }) => {
    const round = currentRound();
    if (!round) return;
    const cl = round.categories[c] && round.categories[c].clues[i];
    if (!cl || cl.used) return;
    stopTimer();
    state.activeClue = {
      r: state.roundIndex, c, i,
      value: cl.value, clue: cl.clue, answer: cl.answer,
      dailyDouble: cl.dailyDouble,
      ddSplash: cl.dailyDouble,   // hold on the reveal before showing the clue
      revealed: false,
    };
    state.buzzer = blankBuzzer();
    state.phase = 'clue';
    push();
  });

  // Dismiss the DAILY DOUBLE card and show the clue underneath.
  socket.on('host:ddReveal', () => {
    if (state.activeClue) state.activeClue.ddSplash = false;
    push();
  });

  socket.on('host:arm', () => {
    if (state.activeClue && state.activeClue.ddSplash) return;
    state.buzzer.armed = true;
    state.buzzer.expired = false;
    startTimer('buzz', state.timers.buzz, onBuzzTimeout);
    push();
  });

  socket.on('host:clearBuzz', () => {
    const outTeams = state.buzzer.outTeams;
    state.buzzer = { ...blankBuzzer(), armed: true, outTeams };
    startTimer('buzz', state.timers.buzz, onBuzzTimeout);
    push();
  });

  socket.on('host:toggleTimer', () => {
    if (!state.timer) return;
    if (state.timer.paused) resumeTimer(state.timer.kind === 'buzz' ? onBuzzTimeout : onAnswerTimeout);
    else pauseTimer();
    push();
  });

  socket.on('host:reveal', () => {
    stopTimer();
    if (state.activeClue) { state.activeClue.revealed = true; state.activeClue.ddSplash = false; }
    state.buzzer.armed = false;
    push();
  });

  socket.on('host:judge', ({ correct }) => {
    if (!state.activeClue || !state.buzzer.lockedBy) return;
    if (correct) {
      stopTimer();
      const holder = scoreHolder(state.buzzer.lockedBy);
      if (holder) holder.score += clueValue();
      state.activeClue.revealed = true;
      state.buzzer.armed = false;
      state.buzzer.lockedBy = null;
    } else {
      stopTimer();
      resolveMiss();
    }
    push();
  });

  socket.on('host:closeClue', () => {
    stopTimer();
    const ac = state.activeClue;
    if (ac) {
      const round = state.rounds[ac.r];
      if (round) round.categories[ac.c].clues[ac.i].used = true;
    }
    state.activeClue = null;
    state.buzzer = blankBuzzer();
    state.phase = 'board';
    push();
  });

  socket.on('host:setScore', ({ playerId, teamId, score }) => {
    const target = teamId ? teams.get(teamId) : players.get(playerId);
    if (target) target.score = Number(score) || 0;
    push();
  });

  socket.on('host:nextRound', () => {
    stopTimer();
    if (state.roundIndex < state.rounds.length - 1) { state.roundIndex += 1; state.phase = 'board'; }
    else if (state.final) state.phase = 'final';
    state.activeClue = null;
    state.buzzer = blankBuzzer();
    push();
  });

  socket.on('host:setRound', ({ i }) => {
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0 || n >= state.rounds.length) return;
    stopTimer();
    state.roundIndex = n;
    state.activeClue = null;
    if (state.feud) state.feud = blankFeud();
    state.buzzer = blankBuzzer();
    state.phase = state.mode === 'feud' ? 'feud' : 'board';
    push();
  });

  socket.on('host:final', () => { stopTimer(); state.phase = 'final'; state.activeClue = null; push(); });
  socket.on('host:backToBoard', () => { state.phase = 'board'; push(); });


  // ------------------------------------------------------------ family feud

  socket.on('feud:select', ({ i }) => {
    const rd = state.rounds[state.roundIndex];
    if (!state.feud || !rd) return;
    const q = rd.questions[i];
    if (!q || q.used) return;
    stopTimer();
    state.feud = { ...blankFeud(), qIndex: i, revealed: q.answers.map(() => false), stage: 'faceoff' };
    state.buzzer = blankBuzzer();
    push();
  });

  // Open the buzzers for the face-off.
  socket.on('feud:arm', () => {
    if (!state.feud) return;
    state.buzzer = { ...blankBuzzer(), armed: true };
    startTimer('buzz', state.timers.buzz, () => { state.buzzer.armed = false; state.buzzer.expired = true; push(); });
    push();
  });

  // Hand the board to whoever is playing it.
  socket.on('feud:control', ({ teamId, playerId }) => {
    if (!state.feud) return;
    stopTimer();
    state.feud.control = teamsOn() ? (teamId || null) : (playerId || null);
    state.feud.stage = 'play';
    state.buzzer.armed = false;
    push();
  });

  socket.on('feud:reveal', ({ i }) => {
    const q = feudQuestion();
    if (!q || !state.feud) return;
    const a = q.answers[i];
    if (!a || state.feud.revealed[i]) return;
    state.feud.revealed[i] = true;
    state.feud.pot += a.points * (q.multiplier || 1);
    // Cleared the whole board — nothing left to steal.
    if (state.feud.revealed.every(Boolean) && state.feud.stage !== 'steal') state.feud.stage = 'cleared';
    push();
  });

  socket.on('feud:unreveal', ({ i }) => {
    const q = feudQuestion();
    if (!q || !state.feud || !state.feud.revealed[i]) return;
    state.feud.revealed[i] = false;
    state.feud.pot = Math.max(0, state.feud.pot - q.answers[i].points * (q.multiplier || 1));
    if (state.feud.stage === 'cleared') state.feud.stage = 'play';
    push();
  });

  socket.on('feud:strike', () => {
    if (!state.feud) return;
    if (state.feud.stage === 'steal') { state.feud.stage = 'stealFailed'; push(); return; }
    state.feud.strikes = Math.min(3, state.feud.strikes + 1);
    state.feud.lastStrikeAt = Date.now();
    if (state.feud.strikes >= 3) state.feud.stage = 'steal';
    push();
  });

  socket.on('feud:undoStrike', () => {
    if (!state.feud) return;
    state.feud.strikes = Math.max(0, state.feud.strikes - 1);
    if (state.feud.strikes < 3 && (state.feud.stage === 'steal' || state.feud.stage === 'stealFailed')) {
      state.feud.stage = 'play';
    }
    push();
  });

  // Award the pot. Defaults to whoever holds control.
  socket.on('feud:award', ({ teamId, playerId }) => {
    if (!state.feud) return;
    const id = teamsOn() ? (teamId || state.feud.control) : (playerId || state.feud.control);
    const target = teamsOn() ? teams.get(id) : players.get(id);
    if (target) target.score += state.feud.pot;
    state.feud.stage = 'awarded';
    push();
  });

  // Show every remaining answer, then close the question out.
  socket.on('feud:revealAll', () => {
    const q = feudQuestion();
    if (!q || !state.feud) return;
    state.feud.revealed = q.answers.map(() => true);
    push();
  });


  // Host types what the player actually said; the board finds the tile.
  socket.on('feud:guess', ({ text }) => {
    const q = feudQuestion();
    if (!q || !state.feud) return;
    const already = q.answers.map((_, i) => i).filter((i) => state.feud.revealed[i]);
    const hit = findAnswer(text, q.answers, already);
    if (hit >= 0) {
      state.feud.revealed[hit] = true;
      state.feud.pot += q.answers[hit].points * (q.multiplier || 1);
      if (state.feud.revealed.every(Boolean) && state.feud.stage !== 'steal') state.feud.stage = 'cleared';
    }
    state.feud.lastGuess = { text: String(text || '').slice(0, 60), hit, at: Date.now() };
    push();
  });

  // A countdown for whoever is on the spot. 0 stops it.
  socket.on('feud:clock', ({ seconds }) => {
    const secs = Math.max(0, Math.min(120, Math.round(Number(seconds) || 0)));
    if (!secs) { stopTimer(); push(); return; }
    startTimer('feud', secs, () => { push(); });
    push();
  });

  // ------------------------------------------------------------- fast money

  socket.on('fm:start', () => {
    if (!state.fastMoneyBank || !state.fastMoneyBank.length) return;
    stopTimer();
    state.fastMoney = {
      questions: state.fastMoneyBank,
      names: ['Player 1', 'Player 2'],
      slots: [
        state.fastMoneyBank.map(() => null),
        state.fastMoneyBank.map(() => null),
      ],
      active: 0,
      target: state.fastMoneyTarget || 200,
    };
    state.phase = 'fastmoney';
    push();
  });

  socket.on('fm:setName', ({ slot, name }) => {
    if (!state.fastMoney) return;
    state.fastMoney.names[slot] = String(name || '').trim().slice(0, 18) || ('Player ' + (slot + 1));
    push();
  });

  socket.on('fm:setActive', ({ slot }) => {
    if (!state.fastMoney) return;
    state.fastMoney.active = slot ? 1 : 0;
    push();
  });

  // Type what they said. Blank text records a pass.
  socket.on('fm:answer', ({ slot, qi, text }) => {
    const fm = state.fastMoney;
    if (!fm || !fm.questions[qi]) return;
    const answers = fm.questions[qi].answers;
    const typed = String(text || '').trim();
    if (!typed) { fm.slots[slot][qi] = { text: '', points: 0, matched: -1, revealed: false, dup: false }; push(); return; }
    const hit = findAnswer(typed, answers);
    // Player 2 cannot repeat what player 1 already said for the same question.
    const otherSlot = slot === 1 ? 0 : 1;
    const other = fm.slots[otherSlot][qi];
    const dup = slot === 1 && hit >= 0 && other && other.matched === hit;
    fm.slots[slot][qi] = {
      text: typed,
      points: hit >= 0 && !dup ? answers[hit].points : 0,
      matched: hit,
      revealed: false,
      dup: !!dup,
    };
    push();
  });

  socket.on('fm:reveal', ({ slot, qi }) => {
    const fm = state.fastMoney;
    if (!fm || !fm.slots[slot][qi]) return;
    fm.slots[slot][qi].revealed = true;
    push();
  });

  socket.on('fm:revealAll', ({ slot }) => {
    const fm = state.fastMoney;
    if (!fm) return;
    fm.slots[slot].forEach((e) => { if (e) e.revealed = true; });
    push();
  });

  socket.on('fm:clock', ({ seconds }) => {
    const secs = Math.max(0, Math.min(120, Math.round(Number(seconds) || 0)));
    startTimer('fastmoney', secs, () => { push(); });
    push();
  });

  socket.on('fm:award', ({ teamId, playerId }) => {
    const fm = state.fastMoney;
    if (!fm) return;
    const total = fm.slots.flat().reduce((n, e) => n + (e && e.revealed ? e.points : 0), 0);
    const target = teamsOn() ? teams.get(teamId) : players.get(playerId);
    if (target) target.score += total;
    push();
  });

  socket.on('fm:exit', () => {
    stopTimer();
    state.fastMoney = null;
    state.phase = 'feud';
    push();
  });

  socket.on('feud:closeQuestion', () => {
    const q = feudQuestion();
    if (q) q.used = true;
    if (state.feud) state.feud = blankFeud();
    state.buzzer = blankBuzzer();
    stopTimer();
    push();
  });

  socket.on('host:archive', (_x, ack) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = (state.title || 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const file = `${stamp}_${slug}.json`;
    const record = {
      title: state.title,
      playedAt: new Date().toISOString(),
      durationMinutes: state.startedAt ? Math.round((Date.now() - state.startedAt) / 60000) : null,
      playedInTeams: teamsOn(),
      finalScores: teamsOn()
        ? [...teams.values()].sort((a, b) => b.score - a.score).map((t) => ({
            name: t.name, score: t.score,
            members: [...players.values()].filter((p) => p.teamId === t.id).map((p) => p.name),
          }))
        : [...players.values()].sort((a, b) => b.score - a.score).map(({ name, score }) => ({ name, score })),
      mode: state.mode || 'jeopardy',
      rounds: state.rounds,
      final: state.final,
    };
    fs.writeFileSync(path.join(ARCHIVE_DIR, file), JSON.stringify(record, null, 2));
    if (typeof ack === 'function') ack({ file });
  });

  socket.on('host:newGame', () => {
    stopTimer();
    state = blankState();
    players.forEach((p) => { p.score = 0; });
    teams.forEach((t) => { t.score = 0; });
    push();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Board (put this on the TV):  http://localhost:' + PORT);
  console.log('  Players join at:             ' + (PUBLIC_URL ? PUBLIC_URL + '/play' : LAN_URL));
  console.log('\n  Phones must be on the same WiFi as this computer.\n');
});
