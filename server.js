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
const TURN_TIMEOUT_MS = 60 * 1000; // 1 minute

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

function broadcastState() {
  const playerList = Object.entries(players).map(([id, p]) => ({
    id,
    name: p.name,
    color: p.color,
    isSpectator: p.isSpectator,
    isCurrentTurn: !p.isSpectator && getCurrentTurnPlayer() === id
  }));

  const activePlayerCount = playerList.filter(p => !p.isSpectator).length;

  io.emit('state_update', {
    selectedNumbers,
    players: playerList,
    playerCount: playerList.length,
    activePlayerCount,
    currentTurnPlayerId: activePlayerCount >= 2 ? getCurrentTurnPlayer() : null,
    gameStarted
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

    // Re-admit all spectators
    turnOrder.length = 0;
    Object.entries(players).forEach(([id, p]) => {
      p.isSpectator = false;
      turnOrder.push(id);
    });

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
      console.log(`🔄 ${trimmed} REJOINED`);
    } else {
      color = getNextColor();
      isSpectator = gameStarted;
      console.log(`✅ ${trimmed} joined${isSpectator ? ' (spectator)' : ''}`);
    }

    players[socket.id] = { name: trimmed, color, isSpectator, sessionKey: key };

    if (!isSpectator && !turnOrder.includes(socket.id)) {
      turnOrder.push(socket.id);
    }

    sessions[key] = {
      name: trimmed,
      color,
      isSpectator,
      calledNumbers: existingSession ? existingSession.calledNumbers : [],
      socketId: socket.id
    };

    socket.emit('joined', {
      playerId: socket.id,
      playerName: trimmed,
      playerColor: color,
      isSpectator,
      isRejoin,
      sessionKey: key
    });

    io.emit('player_joined', { name: trimmed, color, isSpectator, isRejoin });
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
  });

  // ── BINGO CLAIMED
  socket.on('bingo_claimed', ({ playerName }) => {
    const player = players[socket.id];
    if (!player) return;
    clearTurnTimer();
    io.emit('bingo_announced', { playerName: player.name, playerColor: player.color });
  });

  // ── RESET GAME
  socket.on('reset_game', () => {
    const player = players[socket.id];
    if (!player) return;

    clearTurnTimer();
    selectedNumbers.length = 0;
    currentTurnIndex = 0;
    gameStarted = false;

    turnOrder.length = 0;
    Object.entries(players).forEach(([id, p]) => {
      p.isSpectator = false;
      turnOrder.push(id);
    });

    Object.values(sessions).forEach(s => {
      s.isSpectator = false;
      s.calledNumbers = [];
    });

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

      const activePlayers = Object.values(players).filter(p => !p.isSpectator);
      if (activePlayers.length === 0) {
        gameStarted = false;
        clearTurnTimer();
      } else if (activePlayers.length < 2) {
        // Not enough players to continue — stop timer, don't start new one
        clearTurnTimer();
        broadcastState();
      } else if (wasCurrentTurn) {
        // Disconnected player had the turn — restart timer for next player
        startTurnTimer();
        broadcastState();
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