const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory state
const players = {};         // { socketId: { name, color, isSpectator, sessionKey } }
const selectedNumbers = []; // { number, playerName, playerColor, timestamp }
const turnOrder = [];       // [socketId, ...]
let currentTurnIndex = 0;
let gameStarted = false;

// Session store
const sessions = {};

// Turn timer
let turnTimer = null;
let turnStartedAt = null; // track when current turn started
const TURN_TIMEOUT_MS = 60 * 1000; // 1 minute

// ── BOT STATE ──
const BOT_ID = '__bot__';
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
  const color = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
  colorIndex++;
  return color;
}

function getCurrentTurnPlayer() {
  if (turnOrder.length === 0) return null;
  return turnOrder[currentTurnIndex % turnOrder.length];
}

function getTurnElapsedSeconds() {
  if (!turnStartedAt) return 0;
  return Math.floor((Date.now() - turnStartedAt) / 1000);
}

function getTurnRemainingSeconds() {
  const elapsed = getTurnElapsedSeconds();
  return Math.max(0, 60 - elapsed);
}

// ── BOT HELPERS ──
function getRealPlayerCount() {
  return Object.values(players).filter(p => !p.isSpectator).length;
}

function addBot() {
  if (botActive) return;
  botActive = true;
  players[BOT_ID] = { name: BOT_NAME, color: BOT_COLOR, isSpectator: false, sessionKey: BOT_ID };
  if (!turnOrder.includes(BOT_ID)) turnOrder.push(BOT_ID);
  console.log('🤖 Bot added to game');
}

function removeBot() {
  if (!botActive) return;
  botActive = false;
  cancelBotTurn();
  delete players[BOT_ID];
  const idx = turnOrder.indexOf(BOT_ID);
  if (idx !== -1) {
    turnOrder.splice(idx, 1);
    if (currentTurnIndex >= turnOrder.length && turnOrder.length > 0) {
      currentTurnIndex = currentTurnIndex % turnOrder.length;
    }
  }
  console.log('🤖 Bot removed from game');
}

function cancelBotTurn() {
  if (botTurnTimer) { clearTimeout(botTurnTimer); botTurnTimer = null; }
}

function scheduleBotTurn() {
  cancelBotTurn();
  if (!botActive) return;
  if (getCurrentTurnPlayer() !== BOT_ID) return;

  const delay = 2000 + Math.random() * 2000; // 2–4s delay for realism
  botTurnTimer = setTimeout(() => {
    if (!botActive) return;
    if (getCurrentTurnPlayer() !== BOT_ID) return;

    // Pick a random uncalled number
    const available = [];
    for (let n = 1; n <= 25; n++) {
      if (!selectedNumbers.some(s => s.number === n)) available.push(n);
    }
    if (available.length === 0) return;
    const num = available[Math.floor(Math.random() * available.length)];

    if (!gameStarted) gameStarted = true;

    const entry = {
      number: num,
      playerName: BOT_NAME,
      playerColor: BOT_COLOR,
      timestamp: Date.now(),
      isBot: true
    };
    selectedNumbers.push(entry);

    currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
    startTurnTimer();

    io.emit('number_called', { number: num, playerName: BOT_NAME, playerColor: BOT_COLOR, isBot: true });
    broadcastState();

    // If next turn is also bot, schedule again
    if (getCurrentTurnPlayer() === BOT_ID) scheduleBotTurn();
  }, delay);
}

function checkAndManageBot() {
  const realCount = getRealPlayerCount();
  if (realCount === 1 && !botActive) {
    addBot();
    broadcastState();
    // Start bot turn if it's its turn
    if (getCurrentTurnPlayer() === BOT_ID) scheduleBotTurn();
  } else if (realCount >= 2 && botActive) {
    removeBot();
    broadcastState();
  }
}

function broadcastState() {
  const playerList = Object.entries(players).map(([id, p]) => ({
    id,
    name: p.name,
    color: p.color,
    isSpectator: p.isSpectator,
    isCurrentTurn: !p.isSpectator && getCurrentTurnPlayer() === id,
    isBot: id === BOT_ID
  }));

  const activePlayerCount = playerList.filter(p => !p.isSpectator).length;

  io.emit('state_update', {
    selectedNumbers,
    players: playerList,
    playerCount: playerList.filter(p => !p.isBot).length, // don't count bot in online display
    activePlayerCount,
    currentTurnPlayerId: activePlayerCount >= 2 ? getCurrentTurnPlayer() : null,
    gameStarted,
    turnRemainingSeconds: getTurnRemainingSeconds(),
    botActive
  });
}

function makeSessionKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

// ── TURN TIMER: auto-reset if player is AFK for 1 min
function startTurnTimer() {
  clearTurnTimer();
  const currentId = getCurrentTurnPlayer();
  if (!currentId) return;
  const player = players[currentId];
  if (!player) return;

  // If it's the bot's turn, schedule bot move instead of timeout
  if (currentId === BOT_ID) {
    turnStartedAt = Date.now();
    scheduleBotTurn();
    return;
  }

  turnStartedAt = Date.now(); // record when this turn started

  turnTimer = setTimeout(() => {
    const afkPlayer = players[currentId];
    const afkName = afkPlayer ? afkPlayer.name : 'A player';

    console.log(`⏰ Turn timeout for ${afkName} — auto-resetting game`);

    // Notify all clients
    io.emit('turn_timeout', { playerName: afkName });

    // Reset game state
    selectedNumbers.length = 0;
    currentTurnIndex = 0;
    gameStarted = false;
    turnStartedAt = null;

    // Re-admit all spectators
    turnOrder.length = 0;
    Object.entries(players).forEach(([id, p]) => {
      if (id === BOT_ID) return;
      p.isSpectator = false;
      turnOrder.push(id);
    });

    // Re-add bot if only 1 real player
    if (botActive) {
      turnOrder.push(BOT_ID);
    }

    Object.values(sessions).forEach(s => {
      s.isSpectator = false;
      s.calledNumbers = [];
    });

    io.emit('game_reset', { by: `auto (${afkName} timed out)` });
    broadcastState();
  }, TURN_TIMEOUT_MS);
}

function clearTurnTimer() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  turnStartedAt = null;
}

io.on('connection', (socket) => {

  // ── JOIN
  socket.on('join', ({ name, sessionKey }) => {
    const trimmed = name.trim().slice(0, 20) || 'Anonymous';
    const key = sessionKey || makeSessionKey(trimmed);
    const existingSession = sessions[key];

    let color, isSpectator, isRejoin = false;

    if (existingSession) {
      color = existingSession.color;
      isSpectator = existingSession.isSpectator;
      isRejoin = true;
      console.log(`🔄 ${trimmed} REJOINED (spectator: ${isSpectator})`);
    } else {
      color = getNextColor();
      isSpectator = gameStarted && getRealPlayerCount() >= 2; // only spectate if 2+ real players already playing
      console.log(`✅ ${trimmed} joined${isSpectator ? ' (spectator)' : ''}`);
    }

    players[socket.id] = { name: trimmed, color, isSpectator, sessionKey: key };

    if (!isSpectator && !turnOrder.includes(socket.id)) {
      // If bot is in turn order and we now have 2 real players, remove bot first
      turnOrder.push(socket.id);
    }

    sessions[key] = {
      name: trimmed,
      color,
      isSpectator,
      calledNumbers: existingSession ? existingSession.calledNumbers : [],
      socketId: socket.id
    };

    // Send turn remaining seconds so client can sync countdown on rejoin
    const turnRemaining = getTurnRemainingSeconds();

    socket.emit('joined', {
      playerId: socket.id,
      playerName: trimmed,
      playerColor: color,
      isSpectator,
      isRejoin,
      sessionKey: key,
      turnRemainingSeconds: turnRemaining
    });

    io.emit('player_joined', { name: trimmed, color, isSpectator, isRejoin });

    // Check bot after player joins
    checkAndManageBot();

    // If bot was active and now 2 real players exist, start turn timer properly
    if (!botActive && getCurrentTurnPlayer() && getCurrentTurnPlayer() !== BOT_ID) {
      if (gameStarted) startTurnTimer();
    }

    broadcastState();
  });

  // ── SUBMIT NUMBER
  socket.on('submit_number', ({ number }) => {
    const player = players[socket.id];
    if (!player) return;

    if (player.isSpectator) {
      socket.emit('error_msg', { message: '👀 You joined mid-game — spectator only!' });
      return;
    }

    const num = parseInt(number, 10);
    if (isNaN(num) || num < 1 || num > 25) {
      socket.emit('error_msg', { message: '⚠ Number must be between 1 and 25!' });
      return;
    }
    if (selectedNumbers.some(n => n.number === num)) {
      socket.emit('error_msg', { message: `⚠ Number ${num} is already called!` });
      return;
    }
    if (getCurrentTurnPlayer() !== socket.id) {
      socket.emit('error_msg', { message: "⏳ It's not your turn yet!" });
      return;
    }

    const activeCount = Object.values(players).filter(p => !p.isSpectator).length;
    if (activeCount < 2) {
      socket.emit('error_msg', { message: '⏳ Waiting for another player to join!' });
      return;
    }

    if (!gameStarted) gameStarted = true;

    const entry = {
      number: num,
      playerName: player.name,
      playerColor: player.color,
      timestamp: Date.now()
    };
    selectedNumbers.push(entry);

    if (player.sessionKey && sessions[player.sessionKey]) {
      sessions[player.sessionKey].calledNumbers =
        sessions[player.sessionKey].calledNumbers || [];
      sessions[player.sessionKey].calledNumbers.push(num);
    }

    // Advance turn
    currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;

    // Restart timer for the next player's turn
    startTurnTimer();

    io.emit('number_called', {
      number: num,
      playerName: player.name,
      playerColor: player.color
    });

    broadcastState();

    // If next turn is bot, schedule bot move
    if (getCurrentTurnPlayer() === BOT_ID) scheduleBotTurn();
  });

  // ── BINGO CLAIMED
  socket.on('bingo_claimed', ({ playerName }) => {
    const player = players[socket.id];
    if (!player) return;
    clearTurnTimer();
    cancelBotTurn();
    io.emit('bingo_announced', { playerName: player.name, playerColor: player.color });
  });

  // ── RESET GAME
  socket.on('reset_game', () => {
    const player = players[socket.id];
    if (!player) return;

    clearTurnTimer();
    cancelBotTurn();
    selectedNumbers.length = 0;
    currentTurnIndex = 0;
    gameStarted = false;

    turnOrder.length = 0;
    Object.entries(players).forEach(([id, p]) => {
      if (id === BOT_ID) return; // skip bot — re-add below if needed
      p.isSpectator = false;
      turnOrder.push(id);
    });

    Object.values(sessions).forEach(s => {
      s.isSpectator = false;
      s.calledNumbers = [];
    });

    // Re-check bot after reset
    const realCount = getRealPlayerCount();
    if (realCount === 1) {
      if (!botActive) {
        botActive = true;
        players[BOT_ID] = { name: BOT_NAME, color: BOT_COLOR, isSpectator: false, sessionKey: BOT_ID };
      }
      if (!turnOrder.includes(BOT_ID)) turnOrder.push(BOT_ID);
    } else {
      if (botActive) {
        botActive = false;
        delete players[BOT_ID];
      }
    }

    io.emit('game_reset', { by: player.name });
    broadcastState();
    console.log(`🔄 Game reset by ${player.name}`);
  });

  // ── DISCONNECT
  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (player) {
      io.emit('player_left', { name: player.name, color: player.color });

      const wasCurrentTurn = getCurrentTurnPlayer() === socket.id;

      if (player.sessionKey && sessions[player.sessionKey]) {
        sessions[player.sessionKey].socketId = null;
        setTimeout(() => {
          const s = sessions[player.sessionKey];
          if (s && s.socketId === null) {
            delete sessions[player.sessionKey];
            console.log(`🗑 Session expired for ${player.name}`);
          }
        }, 30 * 60 * 1000);
      }

      delete players[socket.id];
      const idx = turnOrder.indexOf(socket.id);
      if (idx !== -1) {
        turnOrder.splice(idx, 1);
        if (currentTurnIndex >= turnOrder.length && turnOrder.length > 0) {
          currentTurnIndex = currentTurnIndex % turnOrder.length;
        }
      }

      const activePlayers = Object.values(players).filter(p => !p.isSpectator && p !== players[BOT_ID]);
      if (activePlayers.length === 0) {
        gameStarted = false;
        clearTurnTimer();
        cancelBotTurn();
        removeBot();
      } else {
        // Check if we need to add/remove bot
        checkAndManageBot();

        if (wasCurrentTurn) {
          if (getCurrentTurnPlayer() === BOT_ID) {
            scheduleBotTurn();
          } else {
            startTurnTimer();
          }
          broadcastState();
        }
      }

      broadcastState();
      console.log(`👋 ${player.name} disconnected`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎱 Bingo Blaster running on http://localhost:${PORT}`);
});