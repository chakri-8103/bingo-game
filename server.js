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
let turnBased = false;
let gameStarted = false;

// Session store — persists across disconnects
// { sessionKey: { name, color, isSpectator, calledNumbers[] } }
const sessions = {};

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
  if (!turnBased || turnOrder.length === 0) return null;
  return turnOrder[currentTurnIndex % turnOrder.length];
}

function broadcastState() {
  const playerList = Object.entries(players).map(([id, p]) => ({
    id,
    name: p.name,
    color: p.color,
    isSpectator: p.isSpectator,
    isCurrentTurn: turnBased && !p.isSpectator && getCurrentTurnPlayer() === id
  }));

  io.emit('state_update', {
    selectedNumbers,
    players: playerList,
    playerCount: playerList.length,
    turnBased,
    currentTurnPlayerId: turnBased ? getCurrentTurnPlayer() : null,
    gameStarted
  });
}

// ── Build a unique session key from name (lowercased, trimmed)
function makeSessionKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

io.on('connection', (socket) => {

  // ── CHECK: does a session exist for this name? (called before join)
  socket.on('check_session', ({ name, sessionKey }) => {
    const key = sessionKey || makeSessionKey(name);
    const session = sessions[key];
    if (session) {
      // Session exists — tell client they can rejoin
      socket.emit('session_found', {
        name: session.name,
        color: session.color,
        isSpectator: session.isSpectator,
        sessionKey: key,
        calledNumbers: session.calledNumbers || []
      });
    } else {
      socket.emit('session_not_found', { name });
    }
  });

  // ── JOIN (new player or rejoin)
  socket.on('join', ({ name, sessionKey }) => {
    const trimmed = name.trim().slice(0, 20) || 'Anonymous';
    const key = sessionKey || makeSessionKey(trimmed);
    const existingSession = sessions[key];

    let color, isSpectator, isRejoin = false;

    if (existingSession) {
      // ── REJOIN: restore their previous session
      color = existingSession.color;
      isSpectator = existingSession.isSpectator;
      isRejoin = true;
      console.log(`🔄 ${trimmed} REJOINED (session restored)`);
    } else {
      // ── NEW PLAYER
      color = getNextColor();
      isSpectator = gameStarted; // spectator if game already in progress
      console.log(`✅ ${trimmed} joined${isSpectator ? ' (spectator)' : ''}`);
    }

    // Register in active players
    players[socket.id] = { name: trimmed, color, isSpectator, sessionKey: key };

    // Add to turn order only if active player and not already present
    if (!isSpectator && !turnOrder.includes(socket.id)) {
      turnOrder.push(socket.id);
    }

    // Save / update session
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
    if (turnBased && getCurrentTurnPlayer() !== socket.id) {
      socket.emit('error_msg', { message: "⏳ It's not your turn yet!" });
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

    // Track called numbers per session
    if (player.sessionKey && sessions[player.sessionKey]) {
      sessions[player.sessionKey].calledNumbers =
        sessions[player.sessionKey].calledNumbers || [];
      sessions[player.sessionKey].calledNumbers.push(num);
    }

    if (turnBased) {
      currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
    }

    io.emit('number_called', {
      number: num,
      playerName: player.name,
      playerColor: player.color
    });

    broadcastState();
  });

  // ── TOGGLE TURN-BASED
  socket.on('toggle_turn_based', () => {
    turnBased = !turnBased;
    currentTurnIndex = 0;
    io.emit('turn_mode_changed', { turnBased });
    broadcastState();
  });

  // ── BINGO CLAIMED
  socket.on('bingo_claimed', ({ playerName }) => {
    const player = players[socket.id];
    if (!player) return;
    io.emit('bingo_announced', { playerName: player.name, playerColor: player.color });
  });

  // ── RESET GAME
  socket.on('reset_game', () => {
    const player = players[socket.id];
    if (!player) return;

    selectedNumbers.length = 0;
    currentTurnIndex = 0;
    gameStarted = false;

    // Re-admit all spectators as full players
    turnOrder.length = 0;
    Object.entries(players).forEach(([id, p]) => {
      p.isSpectator = false;
      turnOrder.push(id);
    });

    // Clear calledNumbers from all sessions
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

      // Keep session alive for rejoin — just remove from active players
      if (player.sessionKey && sessions[player.sessionKey]) {
        sessions[player.sessionKey].socketId = null;
        // Auto-cleanup session after 30 minutes of inactivity
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
          currentTurnIndex = 0;
        }
      }

      const activePlayers = Object.values(players).filter(p => !p.isSpectator);
      if (activePlayers.length === 0) gameStarted = false;

      broadcastState();
      console.log(`👋 ${player.name} disconnected (session kept for 30min)`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎱 Bingo Blaster running on http://localhost:${PORT}`);
});