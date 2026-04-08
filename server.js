const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// turnOrder stores SESSION KEYS (stable). socketMap is the lookup.
// On refresh: grace period of 8s. If they rejoin within 8s -> slot kept.
// If they don't rejoin within 8s -> removed from game.
// ─────────────────────────────────────────────────────────────

const sessions = {};   // sessionKey → { name, color, isSpectator, socketId, calledNums, graceTimer }
const socketMap = {};   // socketId   → sessionKey
const turnOrder = [];   // [ sessionKey, ... ] permanent stable slots
let currentTurnIndex = 0;

const selectedNumbers = [];
let gameStarted = false;

let turnTimer = null;
let turnStartedAt = null;
const TURN_TIMEOUT_MS = 60 * 1000;
const GRACE_PERIOD_MS = 8 * 1000;   // 8s to rejoin before being removed

// ── BOT ──
const BOT_KEY = '__bot__';
const BOT_NAME = '🤖 BingoBot';
const BOT_COLOR = '#8B5CF6';
let botActive = false;
let botTurnTimer = null;

const PLAYER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#FFE66D', '#A29BFE',
  '#FD79A8', '#6BCB77', '#FF9F43', '#54A0FF',
  '#5F27CD', '#00D2D3', '#FF6348', '#2ED573'
];
let colorIndex = 0;
function getNextColor() {
  return PLAYER_COLORS[(colorIndex++) % PLAYER_COLORS.length];
}

// ── HELPERS ──

function getCurrentTurnKey() {
  if (!turnOrder.length) return null;
  return turnOrder[currentTurnIndex % turnOrder.length];
}

function getSocket(key) {
  const s = sessions[key];
  if (!s || !s.socketId) return null;
  return io.sockets.sockets.get(s.socketId) || null;
}

function keyOf(socketId) { return socketMap[socketId] || null; }

function getTurnRemainingSeconds() {
  if (!turnStartedAt) return 60;
  return Math.max(0, 60 - Math.floor((Date.now() - turnStartedAt) / 1000));
}

// Non-bot active player count in turnOrder
function getRealPlayerCount() {
  return turnOrder.filter(k => k !== BOT_KEY).length;
}

function buildPlayerList() {
  const curKey = getCurrentTurnKey();
  return turnOrder.map(key => {
    if (key === BOT_KEY) {
      return {
        id: BOT_KEY, name: BOT_NAME, color: BOT_COLOR,
        isSpectator: false, isCurrentTurn: key === curKey, isBot: true
      };
    }
    const s = sessions[key];
    if (!s) return null;
    return {
      id: s.socketId || key, name: s.name, color: s.color,
      isSpectator: false, isCurrentTurn: key === curKey, isBot: false
    };
  }).filter(Boolean);
}

function buildSpectatorList() {
  return Object.entries(sessions)
    .filter(([k, s]) => s.isSpectator && s.socketId)
    .map(([k, s]) => ({
      id: s.socketId, name: s.name, color: s.color,
      isSpectator: true, isCurrentTurn: false, isBot: false
    }));
}

function broadcastState() {
  const active = buildPlayerList();
  const specs = buildSpectatorList();
  const all = [...active, ...specs];
  const actCount = active.length;

  let turnPlayerId = null;
  if (actCount >= 2) {
    const k = getCurrentTurnKey();
    if (k === BOT_KEY) turnPlayerId = BOT_KEY;
    else { const s = sessions[k]; turnPlayerId = s ? s.socketId : null; }
  }

  io.emit('state_update', {
    selectedNumbers,
    players: all,
    playerCount: all.filter(p => !p.isBot).length,
    activePlayerCount: actCount,
    currentTurnPlayerId: turnPlayerId,
    gameStarted,
    turnRemainingSeconds: getTurnRemainingSeconds(),
    botActive
  });
}

function makeSessionKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

// ── Check draw after every number ──
function checkDraw() {
  if (selectedNumbers.length < 25) return false;
  // All 25 called — game is a draw (server doesn't track cards, client detects winners)
  // We just signal the end; clients will have already detected their own bingo if any
  return true;
}

// ── BOT ──

function cancelBotTurn() {
  if (botTurnTimer) { clearTimeout(botTurnTimer); botTurnTimer = null; }
}

function scheduleBotTurn() {
  cancelBotTurn();
  if (!botActive || getCurrentTurnKey() !== BOT_KEY) return;
  const delay = 2000 + Math.random() * 2000;
  botTurnTimer = setTimeout(() => {
    if (!botActive || getCurrentTurnKey() !== BOT_KEY) return;
    const available = [];
    for (let n = 1; n <= 25; n++) {
      if (!selectedNumbers.some(s => s.number === n)) available.push(n);
    }
    if (!available.length) return;
    const num = available[Math.floor(Math.random() * available.length)];
    if (!gameStarted) gameStarted = true;
    selectedNumbers.push({
      number: num, playerName: BOT_NAME,
      playerColor: BOT_COLOR, timestamp: Date.now(), isBot: true
    });
    currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
    startTurnTimer();
    io.emit('number_called', {
      number: num, playerName: BOT_NAME,
      playerColor: BOT_COLOR, isBot: true
    });
    // Check draw
    if (checkDraw()) {
      clearTurnTimer(); cancelBotTurn();
      io.emit('game_draw', {});
      return;
    }
    broadcastState();
    if (getCurrentTurnKey() === BOT_KEY) scheduleBotTurn();
  }, delay);
}

function addBot() {
  if (botActive) return;
  botActive = true;
  sessions[BOT_KEY] = {
    name: BOT_NAME, color: BOT_COLOR,
    isSpectator: false, socketId: BOT_KEY
  };
  if (!turnOrder.includes(BOT_KEY)) turnOrder.push(BOT_KEY);
  console.log('🤖 Bot added');
}

function removeBot() {
  if (!botActive) return;
  botActive = false;
  cancelBotTurn();
  delete sessions[BOT_KEY];
  const idx = turnOrder.indexOf(BOT_KEY);
  if (idx !== -1) {
    turnOrder.splice(idx, 1);
    if (turnOrder.length > 0) {
      if (idx < currentTurnIndex) currentTurnIndex--;
      currentTurnIndex = Math.max(0, currentTurnIndex % Math.max(turnOrder.length, 1));
    } else currentTurnIndex = 0;
  }
  console.log('🤖 Bot removed');
}

function checkAndManageBot() {
  const real = getRealPlayerCount();
  if (real === 1 && !botActive) {
    addBot();
    if (getCurrentTurnKey() === BOT_KEY) scheduleBotTurn();
  } else if (real >= 2 && botActive) {
    removeBot();
  }
}

// ── REMOVE PLAYER (grace expired or AFK kick) ──
function removePlayerFromGame(key, reason) {
  const sess = sessions[key];
  if (!sess) return;

  const name = sess.name;
  const color = sess.color;

  // Cancel any pending grace timer
  if (sess.graceTimer) { clearTimeout(sess.graceTimer); sess.graceTimer = null; }

  // Remove socket mapping
  if (sess.socketId && sess.socketId !== BOT_KEY) delete socketMap[sess.socketId];

  // Remove from turnOrder
  const idx = turnOrder.indexOf(key);
  const wasCurrentTurn = idx !== -1 && (currentTurnIndex % Math.max(turnOrder.length, 1)) === idx;

  if (idx !== -1) {
    turnOrder.splice(idx, 1);
    if (turnOrder.length > 0) {
      if (idx < currentTurnIndex) currentTurnIndex--;
      else if (idx === currentTurnIndex) currentTurnIndex = currentTurnIndex % turnOrder.length;
      currentTurnIndex = Math.max(0, currentTurnIndex % Math.max(turnOrder.length, 1));
    } else currentTurnIndex = 0;
  }

  delete sessions[key];

  io.emit('player_left', { name, color });
  console.log(`🗑 ${name} removed (${reason})`);

  const real = getRealPlayerCount();

  if (real === 0) {
    selectedNumbers.length = 0; currentTurnIndex = 0; gameStarted = false;
    turnOrder.length = 0; if (botActive) removeBot();
    broadcastState(); return;
  }

  if (real === 1 && gameStarted) {
    // Only 1 real player left mid-game — reset
    selectedNumbers.length = 0; currentTurnIndex = 0; gameStarted = false;
    Object.values(sessions).forEach(s => { s.isSpectator = false; });
    io.emit('game_reset', { by: `auto (${name} left)` });
    checkAndManageBot(); broadcastState(); return;
  }

  checkAndManageBot();

  if (wasCurrentTurn) {
    clearTurnTimer();
    if (turnOrder.length >= 2) {
      if (getCurrentTurnKey() === BOT_KEY) scheduleBotTurn();
      else startTurnTimer();
    }
  }

  broadcastState();
}

// ── TURN TIMER ──

function clearTurnTimer() {
  if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
  turnStartedAt = null;
}

function startTurnTimer() {
  clearTurnTimer();
  const key = getCurrentTurnKey();
  if (!key) return;

  if (key === BOT_KEY) {
    turnStartedAt = Date.now();
    scheduleBotTurn();
    return;
  }

  const sess = sessions[key];
  if (!sess) return;

  // If player is currently offline (in grace period), pause — they'll resume on rejoin
  if (!sess.socketId) {
    console.log(`  Turn paused — ${sess.name} is offline (grace period)`);
    return;
  }

  turnStartedAt = Date.now();

  turnTimer = setTimeout(() => {
    const s = sessions[key];
    if (!s) return;
    const afkName = s.name;
    console.log(`⏰ AFK timeout: ${afkName}`);
    io.emit('turn_timeout', { playerName: afkName });
    const sock = getSocket(key);
    if (sock) {
      sock.emit('force_logout', { reason: 'You were removed for not playing within 60 seconds.' });
      sock.disconnect(true);
    }
    removePlayerFromGame(key, 'AFK timeout');
  }, TURN_TIMEOUT_MS);
}

// ── CONNECTION ──

io.on('connection', (socket) => {

  socket.on('join', ({ name, sessionKey }) => {
    const trimmed = name.trim().slice(0, 20) || 'Anonymous';
    const key = sessionKey || makeSessionKey(trimmed);
    const existing = sessions[key];
    let color, isSpectator, isRejoin = false;

    if (existing && key !== BOT_KEY) {
      // ── REJOIN ──
      color = existing.color;
      isSpectator = existing.isSpectator;
      isRejoin = true;

      // Cancel grace timer — they made it back in time
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
        console.log(`  ↳ Grace timer cancelled — ${trimmed} rejoined in time`);
      }

      // Unmap old socket
      if (existing.socketId && existing.socketId !== socket.id) {
        delete socketMap[existing.socketId];
      }
      existing.socketId = socket.id;
      socketMap[socket.id] = key;

      console.log(`🔄 ${trimmed} REJOINED — slot [${turnOrder.indexOf(key)}] idx=${currentTurnIndex} cur=${getCurrentTurnKey()}`);

      // If it was their turn and timer was paused (they were offline), restart it
      if (getCurrentTurnKey() === key && !turnTimer && gameStarted) {
        console.log(`  ↳ Resuming their turn timer`);
        startTurnTimer();
      }

    } else {
      // ── NEW PLAYER ──
      color = getNextColor();
      // Spectator if: game already in progress (bot game OR 2-player game)
      isSpectator = gameStarted;
      sessions[key] = {
        name: trimmed, color, isSpectator,
        socketId: socket.id, calledNums: [], graceTimer: null
      };
      socketMap[socket.id] = key;
      if (!isSpectator && !turnOrder.includes(key)) turnOrder.push(key);
      console.log(`✅ ${trimmed} joined${isSpectator ? ' (spectator)' : ''} turnOrder:`, turnOrder);
    }

    checkAndManageBot();

    socket.emit('joined', {
      playerId: socket.id, playerName: trimmed, playerColor: color,
      isSpectator, isRejoin, sessionKey: key,
      turnRemainingSeconds: getTurnRemainingSeconds()
    });

    io.emit('player_joined', { name: trimmed, color, isSpectator, isRejoin });

    const curKey = getCurrentTurnKey();
    if (gameStarted && curKey && curKey !== BOT_KEY && !turnTimer) startTurnTimer();
    if (botActive && curKey === BOT_KEY && !botTurnTimer) scheduleBotTurn();

    broadcastState();
  });

  socket.on('submit_number', ({ number }) => {
    const key = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess || sess.isSpectator) {
      socket.emit('error_msg', { message: '👀 Spectator only!' }); return;
    }
    const num = parseInt(number, 10);
    if (isNaN(num) || num < 1 || num > 25) {
      socket.emit('error_msg', { message: '⚠ Number must be 1-25!' }); return;
    }
    if (selectedNumbers.some(n => n.number === num)) {
      socket.emit('error_msg', { message: `⚠ ${num} already called!` }); return;
    }
    if (getCurrentTurnKey() !== key) {
      socket.emit('error_msg', { message: "⏳ Not your turn!" }); return;
    }
    if (buildPlayerList().length < 2) {
      socket.emit('error_msg', { message: '⏳ Need another player!' }); return;
    }
    if (!gameStarted) gameStarted = true;

    selectedNumbers.push({
      number: num, playerName: sess.name,
      playerColor: sess.color, timestamp: Date.now()
    });
    (sess.calledNums = sess.calledNums || []).push(num);

    currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
    startTurnTimer();

    io.emit('number_called', { number: num, playerName: sess.name, playerColor: sess.color });

    // Check draw after all 25 numbers called
    if (checkDraw()) {
      clearTurnTimer(); cancelBotTurn();
      io.emit('game_draw', {});
      return;
    }

    broadcastState();
    if (getCurrentTurnKey() === BOT_KEY) scheduleBotTurn();
    console.log(`  [${sess.name} called ${num}] next: ${getCurrentTurnKey()} idx=${currentTurnIndex}`);
  });

  socket.on('bingo_claimed', ({ winners }) => {
    const key = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess) return;
    clearTurnTimer(); cancelBotTurn();
    // winners is an array of { name, color } from client
    io.emit('bingo_announced', { winners: winners || [{ name: sess.name, color: sess.color }] });
  });

  socket.on('reset_game', () => {
    const key = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess) return;

    clearTurnTimer(); cancelBotTurn();
    selectedNumbers.length = 0; currentTurnIndex = 0; gameStarted = false;

    // Move all spectators back into turnOrder
    Object.entries(sessions).forEach(([k, s]) => {
      if (k === BOT_KEY) return;
      s.isSpectator = false;
      if (!turnOrder.includes(k)) turnOrder.push(k);
    });

    if (botActive) removeBot();
    checkAndManageBot();

    io.emit('game_reset', { by: sess.name });
    broadcastState();
    console.log(`🔄 Reset by ${sess.name} turnOrder:`, turnOrder);
  });

  socket.on('disconnect', () => {
    const key = keyOf(socket.id);
    if (!key || key === BOT_KEY) return;

    const sess = sessions[key];
    if (!sess) { delete socketMap[socket.id]; return; }

    console.log(`👋 ${sess.name} disconnected (${socket.id})`);
    io.emit('player_left', { name: sess.name, color: sess.color });

    // Mark offline
    sess.socketId = null;
    delete socketMap[socket.id];

    // If it was their turn, pause the turn timer (don't advance yet — give grace period)
    const wasMyTurn = getCurrentTurnKey() === key;
    if (wasMyTurn) {
      clearTurnTimer();
      cancelBotTurn();
      console.log(`  Turn paused — waiting ${GRACE_PERIOD_MS / 1000}s grace period for ${sess.name}`);
    }

    // Start grace period — if they don't rejoin within GRACE_PERIOD_MS, remove them
    sess.graceTimer = setTimeout(() => {
      const s = sessions[key];
      if (s && !s.socketId) {
        console.log(`  Grace expired for ${s.name} — removing from game`);
        removePlayerFromGame(key, 'grace period expired (left game)');
      }
    }, GRACE_PERIOD_MS);

    broadcastState();
    console.log(`  [disconnect] turnOrder: [${turnOrder.join(',')}] idx: ${currentTurnIndex} cur: ${getCurrentTurnKey()}`);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎱 Bingo Blaster running on ${PORT}`);
});