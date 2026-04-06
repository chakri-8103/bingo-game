const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// CORE IDEA: turnOrder stores SESSION KEYS (stable identifiers),
// NOT socket IDs. Socket IDs are just a lookup: socketMap[socketId] = sessionKey.
// This makes reconnect trivial — the slot never moves, no race conditions.
// ─────────────────────────────────────────────────────────────

const sessions   = {};   // sessionKey → { name, color, isSpectator, socketId, calledNums }
const socketMap  = {};   // socketId   → sessionKey
const turnOrder  = [];   // [ sessionKey, ... ]  — permanent, never shuffled
let currentTurnIndex = 0;

const selectedNumbers = [];  // { number, playerName, playerColor, timestamp, isBot? }
let gameStarted = false;

// Turn timer
let turnTimer    = null;
let turnStartedAt = null;
const TURN_TIMEOUT_MS = 60 * 1000;

// ── BOT ──
const BOT_KEY   = '__bot__';
const BOT_NAME  = '🤖 BingoBot';
const BOT_COLOR = '#8B5CF6';
let botActive    = false;
let botTurnTimer = null;

const PLAYER_COLORS = [
  '#FF6B6B','#4ECDC4','#FFE66D','#A29BFE',
  '#FD79A8','#6BCB77','#FF9F43','#54A0FF',
  '#5F27CD','#00D2D3','#FF6348','#2ED573'
];
let colorIndex = 0;
function getNextColor() {
  return PLAYER_COLORS[(colorIndex++) % PLAYER_COLORS.length];
}

// ── HELPERS ──────────────────────────────────────────────────

function getCurrentTurnKey() {
  if (turnOrder.length === 0) return null;
  return turnOrder[currentTurnIndex % turnOrder.length];
}

// Get the socket for a session key (null if offline)
function getSocket(key) {
  const sess = sessions[key];
  if (!sess || !sess.socketId) return null;
  return io.sockets.sockets.get(sess.socketId) || null;
}

// socketId → sessionKey
function keyOf(socketId) {
  return socketMap[socketId] || null;
}

function getTurnRemainingSeconds() {
  if (!turnStartedAt) return 60;
  return Math.max(0, 60 - Math.floor((Date.now() - turnStartedAt) / 1000));
}

// Real (non-bot) non-spectator count in turnOrder
function getRealPlayerCount() {
  return turnOrder.filter(k => k !== BOT_KEY).length;
}

// Build player list for broadcast
function buildPlayerList() {
  const currentKey = getCurrentTurnKey();
  return turnOrder.map(key => {
    if (key === BOT_KEY) {
      return { id: BOT_KEY, name: BOT_NAME, color: BOT_COLOR,
               isSpectator: false, isCurrentTurn: key === currentKey, isBot: true };
    }
    const s = sessions[key];
    if (!s) return null;
    // Use socketId as the "id" the client knows (for isMyTurn check)
    return { id: s.socketId || key, name: s.name, color: s.color,
             isSpectator: false, isCurrentTurn: key === currentKey, isBot: false };
  }).filter(Boolean);
}

// Spectators — connected but not in turnOrder
function buildSpectatorList() {
  return Object.entries(sessions)
    .filter(([k, s]) => s.isSpectator && s.socketId)
    .map(([k, s]) => ({
      id: s.socketId, name: s.name, color: s.color,
      isSpectator: true, isCurrentTurn: false, isBot: false
    }));
}

function broadcastState() {
  const activePlayers = buildPlayerList();
  const spectators    = buildSpectatorList();
  const allPlayers    = [...activePlayers, ...spectators];
  const activeCount   = activePlayers.length;

  io.emit('state_update', {
    selectedNumbers,
    players: allPlayers,
    playerCount: allPlayers.filter(p => !p.isBot).length,
    activePlayerCount: activeCount,
    currentTurnPlayerId: activeCount >= 2 ? (() => {
      const key = getCurrentTurnKey();
      if (key === BOT_KEY) return BOT_KEY;
      const s = sessions[key];
      return s ? s.socketId : null;
    })() : null,
    gameStarted,
    turnRemainingSeconds: getTurnRemainingSeconds(),
    botActive
  });
}

function makeSessionKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

// ── BOT ──────────────────────────────────────────────────────

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
    if (available.length === 0) return;
    const num = available[Math.floor(Math.random() * available.length)];

    if (!gameStarted) gameStarted = true;
    selectedNumbers.push({ number: num, playerName: BOT_NAME,
                           playerColor: BOT_COLOR, timestamp: Date.now(), isBot: true });

    currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
    startTurnTimer();

    io.emit('number_called', { number: num, playerName: BOT_NAME,
                               playerColor: BOT_COLOR, isBot: true });
    broadcastState();

    if (getCurrentTurnKey() === BOT_KEY) scheduleBotTurn();
  }, delay);
}

function addBot() {
  if (botActive) return;
  botActive = true;
  sessions[BOT_KEY] = { name: BOT_NAME, color: BOT_COLOR,
                        isSpectator: false, socketId: BOT_KEY };
  if (!turnOrder.includes(BOT_KEY)) turnOrder.push(BOT_KEY);
  console.log('🤖 Bot added, turnOrder:', turnOrder);
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
    } else {
      currentTurnIndex = 0;
    }
  }
  console.log('🤖 Bot removed, turnOrder:', turnOrder);
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

// ── TURN TIMER ────────────────────────────────────────────────

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

  turnStartedAt = Date.now();

  turnTimer = setTimeout(() => {
    const s = sessions[key];
    if (!s) return; // already removed

    const afkName  = s.name;
    const afkColor = s.color;
    console.log(`⏰ Timeout for ${afkName}`);

    io.emit('turn_timeout', { playerName: afkName });

    // Kick their socket
    const sock = getSocket(key);
    if (sock) {
      sock.emit('force_logout', { reason: 'You were removed for not playing within 60 seconds.' });
      sock.disconnect(true);
    }

    // Remove from turnOrder and sessions
    const idx = turnOrder.indexOf(key);
    if (idx !== -1) {
      turnOrder.splice(idx, 1);
      if (turnOrder.length > 0) {
        currentTurnIndex = idx % turnOrder.length;
      } else {
        currentTurnIndex = 0;
      }
    }
    if (s.socketId) delete socketMap[s.socketId];
    delete sessions[key];

    io.emit('player_left', { name: afkName, color: afkColor });

    const real = getRealPlayerCount();
    if (real === 0) {
      selectedNumbers.length = 0; currentTurnIndex = 0; gameStarted = false;
      turnOrder.length = 0; if (botActive) removeBot();
      broadcastState(); return;
    }
    if (real === 1) {
      selectedNumbers.length = 0; currentTurnIndex = 0; gameStarted = false;
      Object.values(sessions).forEach(s => { s.isSpectator = false; });
      io.emit('game_reset', { by: `auto (${afkName} timed out)` });
      checkAndManageBot(); broadcastState(); return;
    }
    if (getCurrentTurnKey() === BOT_KEY) scheduleBotTurn();
    else startTurnTimer();
    broadcastState();
  }, TURN_TIMEOUT_MS);
}

// ── CONNECTION HANDLER ────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('join', ({ name, sessionKey }) => {
    const trimmed = name.trim().slice(0, 20) || 'Anonymous';
    const key     = sessionKey || makeSessionKey(trimmed);

    const existing = sessions[key];
    let color, isSpectator, isRejoin = false;

    if (existing && key !== BOT_KEY) {
      // ── REJOIN ──────────────────────────────────────────────
      // The slot in turnOrder never moves — it's already there with the session key.
      // All we do is update the socket mapping.
      color       = existing.color;
      isSpectator = existing.isSpectator;
      isRejoin    = true;

      // Unmap old socket
      if (existing.socketId && existing.socketId !== socket.id) {
        delete socketMap[existing.socketId];
      }

      // Map new socket → key
      existing.socketId = socket.id;
      socketMap[socket.id] = key;

      console.log(`🔄 ${trimmed} REJOINED — slot preserved at [${turnOrder.indexOf(key)}], currentTurnIndex=${currentTurnIndex}, currentTurn=${getCurrentTurnKey()}`);

    } else {
      // ── NEW PLAYER ──────────────────────────────────────────
      color       = getNextColor();
      isSpectator = gameStarted && getRealPlayerCount() >= 2;

      sessions[key] = { name: trimmed, color, isSpectator,
                        socketId: socket.id, calledNums: [] };
      socketMap[socket.id] = key;

      if (!isSpectator && !turnOrder.includes(key)) {
        turnOrder.push(key);
      }

      console.log(`✅ ${trimmed} joined${isSpectator ? ' (spectator)' : ''}, turnOrder:`, turnOrder);
    }

    checkAndManageBot();

    socket.emit('joined', {
      playerId:             socket.id,
      playerName:           trimmed,
      playerColor:          color,
      isSpectator,
      isRejoin,
      sessionKey:           key,
      turnRemainingSeconds: getTurnRemainingSeconds()
    });

    io.emit('player_joined', { name: trimmed, color, isSpectator, isRejoin });

    // Ensure timer/bot is running if needed
    const curKey = getCurrentTurnKey();
    if (gameStarted && curKey && curKey !== BOT_KEY && !turnTimer) {
      startTurnTimer();
    }
    if (botActive && curKey === BOT_KEY && !botTurnTimer) {
      scheduleBotTurn();
    }

    broadcastState();
  });

  socket.on('submit_number', ({ number }) => {
    const key = keyOf(socket.id);
    if (!key) return;
    const sess = sessions[key];
    if (!sess || sess.isSpectator) {
      socket.emit('error_msg', { message: '👀 You joined mid-game — spectator only!' });
      return;
    }

    const num = parseInt(number, 10);
    if (isNaN(num) || num < 1 || num > 25) {
      socket.emit('error_msg', { message: '⚠ Number must be between 1 and 25!' }); return;
    }
    if (selectedNumbers.some(n => n.number === num)) {
      socket.emit('error_msg', { message: `⚠ ${num} already called!` }); return;
    }
    if (getCurrentTurnKey() !== key) {
      socket.emit('error_msg', { message: "⏳ Not your turn!" }); return;
    }
    if (buildPlayerList().length < 2) {
      socket.emit('error_msg', { message: '⏳ Waiting for another player!' }); return;
    }

    if (!gameStarted) gameStarted = true;

    selectedNumbers.push({ number: num, playerName: sess.name,
                           playerColor: sess.color, timestamp: Date.now() });
    (sess.calledNums = sess.calledNums || []).push(num);

    currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
    startTurnTimer();

    io.emit('number_called', { number: num, playerName: sess.name, playerColor: sess.color });
    broadcastState();

    if (getCurrentTurnKey() === BOT_KEY) scheduleBotTurn();

    console.log(`  [submit by ${sess.name}] next: ${getCurrentTurnKey()} (idx ${currentTurnIndex})`);
  });

  socket.on('bingo_claimed', () => {
    const key  = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess) return;
    clearTurnTimer(); cancelBotTurn();
    io.emit('bingo_announced', { playerName: sess.name, playerColor: sess.color });
  });

  socket.on('reset_game', () => {
    const key  = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess) return;

    clearTurnTimer(); cancelBotTurn();
    selectedNumbers.length = 0;
    currentTurnIndex = 0;
    gameStarted = false;

    // Move all spectators into turnOrder
    Object.entries(sessions).forEach(([k, s]) => {
      if (k === BOT_KEY) return;
      s.isSpectator = false;
      if (!turnOrder.includes(k)) turnOrder.push(k);
    });

    if (botActive) { removeBot(); }
    checkAndManageBot();

    io.emit('game_reset', { by: sess.name });
    broadcastState();
    console.log(`🔄 Reset by ${sess.name}, turnOrder:`, turnOrder);
  });

  socket.on('disconnect', () => {
    const key = keyOf(socket.id);
    if (!key || key === BOT_KEY) return;

    const sess = sessions[key];
    if (!sess) { delete socketMap[socket.id]; return; }

    console.log(`👋 ${sess.name} disconnected (${socket.id})`);
    io.emit('player_left', { name: sess.name, color: sess.color });

    // Mark offline — but KEEP the session and KEEP the slot in turnOrder
    sess.socketId = null;
    delete socketMap[socket.id];

    // Session expires after 30 min if they don't come back
    setTimeout(() => {
      const s = sessions[key];
      if (s && !s.socketId) {
        // Remove from turnOrder too
        const idx = turnOrder.indexOf(key);
        if (idx !== -1) {
          turnOrder.splice(idx, 1);
          if (turnOrder.length > 0) {
            if (idx < currentTurnIndex) currentTurnIndex--;
            currentTurnIndex = Math.max(0, currentTurnIndex % Math.max(turnOrder.length, 1));
          } else {
            currentTurnIndex = 0;
          }
        }
        delete sessions[key];
        console.log(`🗑 Session expired: ${s.name}`);
        checkAndManageBot();
        broadcastState();
      }
    }, 30 * 60 * 1000);

    // Turn handling on disconnect:
    // - If it was THEIR turn: DON'T advance. Just pause the timer.
    //   They are likely refreshing and will reconnect in seconds.
    //   Their slot stays at currentTurnIndex — they get their turn back on rejoin.
    // - If it was ANOTHER player's turn: advance past this slot IF we happen to
    //   land on this offline slot later (handled in advancePastOffline).
    const wasMyTurn = getCurrentTurnKey() === key;
    if (wasMyTurn) {
      // Pause turn — don't advance, don't start timer for next player.
      // Rejoin will resume from the same slot.
      clearTurnTimer();
      cancelBotTurn();
    } else {
      // It's another player's turn — if that player is online, timer keeps running.
      // No action needed; timer is already running for them.
      // But if somehow we need to skip this slot later, advancePastOffline handles it.
    }

    checkAndManageBot();
    broadcastState();
    console.log(`  turnOrder: [${turnOrder.join(', ')}]  idx: ${currentTurnIndex}  currentTurn: ${getCurrentTurnKey()}`);
  });
});

// Skip past any offline players whose socket is null
// Called when current turn player goes offline mid-turn
function advancePastOffline() {
  if (turnOrder.length === 0) return;

  // Try each slot once to find an online player
  let attempts = 0;
  while (attempts < turnOrder.length) {
    const key = getCurrentTurnKey();
    if (!key) break;

    // Bot is always "online"
    if (key === BOT_KEY) {
      startTurnTimer(); // will call scheduleBotTurn
      return;
    }

    const sess = sessions[key];
    if (sess && sess.socketId) {
      // This player is online — their turn
      startTurnTimer();
      return;
    }

    // Offline — skip
    currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
    attempts++;
  }

  // All players offline (shouldn't happen normally)
  console.log('  All players offline, pausing turns');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎱 Bingo Blaster running on http://localhost:${PORT}`);
});