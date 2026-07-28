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

const sessions = {};   // sessionKey → { name, color, isSpectator, socketId, calledNums, graceTimer, roomId }
const socketMap = {};   // socketId   → sessionKey
const waitingLobby = []; // FIFO Queue of sessionKeys waiting for a game room

const TURN_TIMEOUT_SECONDS = 30;
const TURN_TIMEOUT_MS = TURN_TIMEOUT_SECONDS * 1000;
const GRACE_PERIOD_MS = 8 * 1000;   // 8s to rejoin before being removed

// ── BOT CONSTANTS ──
const BOT_KEY = '__bot__';
const BOT_NAME = '🤖 BingoBot';
const BOT_COLOR = '#8B5CF6';

const PLAYER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#FFE66D', '#A29BFE',
  '#FD79A8', '#6BCB77', '#FF9F43', '#54A0FF',
  '#5F27CD', '#00D2D3', '#FF6348', '#2ED573'
];
let colorIndex = 0;
function getNextColor() {
  return PLAYER_COLORS[(colorIndex++) % PLAYER_COLORS.length];
}

function makeSessionKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

function getSocket(key) {
  const s = sessions[key];
  if (!s || !s.socketId) return null;
  return io.sockets.sockets.get(s.socketId) || null;
}

function keyOf(socketId) { return socketMap[socketId] || null; }

// ─────────────────────────────────────────────────────────────
// GAME ROOM CLASS
// ─────────────────────────────────────────────────────────────

class GameRoom {
  constructor(id) {
    this.id = id;
    this.turnOrder = [];
    this.currentTurnIndex = 0;
    this.selectedNumbers = [];
    this.gameStarted = false;
    this.turnTimer = null;
    this.turnStartedAt = null;

    this.botActive = false;
    this.botTurnTimer = null;
    this.botBingoTimer = null;
    this.botCard = [];
  }

  getCurrentTurnKey() {
    if (!this.turnOrder.length) return null;
    return this.turnOrder[this.currentTurnIndex % this.turnOrder.length];
  }

  getTurnRemainingSeconds() {
    if (!this.turnStartedAt) return TURN_TIMEOUT_SECONDS;
    return Math.max(0, TURN_TIMEOUT_SECONDS - Math.floor((Date.now() - this.turnStartedAt) / 1000));
  }

  getRealPlayerCount() {
    return this.turnOrder.filter(k => k !== BOT_KEY).length;
  }

  buildPlayerList() {
    const curKey = this.getCurrentTurnKey();
    return this.turnOrder.map(key => {
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

  buildSpectatorList() {
    return Object.entries(sessions)
      .filter(([k, s]) => s.roomId === this.id && s.isSpectator && s.socketId)
      .map(([k, s]) => ({
        id: s.socketId, name: s.name, color: s.color,
        isSpectator: true, isCurrentTurn: false, isBot: false
      }));
  }

  broadcastState() {
    const active = this.buildPlayerList();
    const specs = this.buildSpectatorList();
    const all = [...active, ...specs];
    const actCount = active.length;

    let turnPlayerId = null;
    if (actCount >= 2) {
      const k = this.getCurrentTurnKey();
      if (k === BOT_KEY) turnPlayerId = BOT_KEY;
      else { const s = sessions[k]; turnPlayerId = s ? s.socketId : null; }
    }

    io.to(this.id).emit('state_update', {
      selectedNumbers: this.selectedNumbers,
      players: all,
      playerCount: all.filter(p => !p.isBot).length,
      activePlayerCount: actCount,
      currentTurnPlayerId: turnPlayerId,
      gameStarted: this.gameStarted,
      turnRemainingSeconds: this.getTurnRemainingSeconds(),
      botActive: this.botActive
    });
  }

  checkDraw() {
    return this.selectedNumbers.length >= 25;
  }

  clearTurnTimer() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    this.turnStartedAt = null;
  }

  startTurnTimer() {
    this.clearTurnTimer();
    const key = this.getCurrentTurnKey();
    if (!key) return;

    if (key === BOT_KEY) {
      this.turnStartedAt = Date.now();
      this.scheduleBotTurn();
      return;
    }

    const sess = sessions[key];
    if (!sess) return;

    if (!sess.socketId) {
      console.log(`  [${this.id}] Turn paused — ${sess.name} is offline (grace period)`);
      return;
    }

    this.turnStartedAt = Date.now();

    this.turnTimer = setTimeout(() => {
      const s = sessions[key];
      if (!s) return;
      const afkName = s.name;
      console.log(`⏰ [${this.id}] AFK timeout: ${afkName}`);
      io.to(this.id).emit('turn_timeout', { playerName: afkName });
      const sock = getSocket(key);
      if (sock) {
        sock.emit('force_logout', { reason: `You were removed for not playing within ${TURN_TIMEOUT_SECONDS} seconds.` });
        sock.disconnect(true);
      }
      removePlayerFromGame(key, 'AFK timeout');
    }, TURN_TIMEOUT_MS);
  }

  cancelBotBingoTimer() {
    if (this.botBingoTimer) { clearTimeout(this.botBingoTimer); this.botBingoTimer = null; }
  }

  cancelBotTurn() {
    if (this.botTurnTimer) { clearTimeout(this.botTurnTimer); this.botTurnTimer = null; }
    this.cancelBotBingoTimer();
  }

  scheduleBotTurn() {
    this.cancelBotTurn();
    if (!this.botActive || this.getCurrentTurnKey() !== BOT_KEY) return;
    const delay = 2000 + Math.random() * 2000;
    this.botTurnTimer = setTimeout(() => {
      if (!this.botActive || this.getCurrentTurnKey() !== BOT_KEY) return;
      const available = [];
      for (let n = 1; n <= 25; n++) {
        if (!this.selectedNumbers.some(s => s.number === n)) available.push(n);
      }
      if (!available.length) return;
      const num = available[Math.floor(Math.random() * available.length)];
      if (!this.gameStarted) this.gameStarted = true;

      if (this.checkBotBingo()) {
        this.clearTurnTimer(); this.cancelBotTurn();
        this.botBingoTimer = setTimeout(() => {
          this.botBingoTimer = null;
          io.to(this.id).emit('bingo_announced', { winners: [{ name: BOT_NAME, color: BOT_COLOR }] });
        }, 400);
        return;
      }

      this.selectedNumbers.push({
        number: num, playerName: BOT_NAME,
        playerColor: BOT_COLOR, timestamp: Date.now(), isBot: true
      });
      this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;
      this.startTurnTimer();
      io.to(this.id).emit('number_called', {
        number: num, playerName: BOT_NAME,
        playerColor: BOT_COLOR, isBot: true
      });

      if (this.checkDraw()) {
        this.clearTurnTimer(); this.cancelBotTurn();
        io.to(this.id).emit('game_draw', {});
        return;
      }
      this.broadcastState();
      if (this.getCurrentTurnKey() === BOT_KEY) this.scheduleBotTurn();
    }, delay);
  }

  generateBotCard() {
    const nums = Array.from({ length: 25 }, (_, i) => i + 1);
    for (let i = nums.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nums[i], nums[j]] = [nums[j], nums[i]];
    }
    return nums;
  }

  checkBotBingo() {
    if (!this.botActive || !this.botCard.length) return false;
    const called = new Set(this.selectedNumbers.map(s => s.number));
    const LINES = [
      [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
      [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
      [0,6,12,18,24],[4,8,12,16,20]
    ];
    let struck = 0;
    for (const line of LINES) {
      if (line.every(idx => called.has(this.botCard[idx]))) struck++;
    }
    return struck >= 5;
  }

  addBot() {
    if (this.botActive) return;
    this.botActive = true;
    this.botCard = this.generateBotCard();
    sessions[BOT_KEY] = {
      name: BOT_NAME, color: BOT_COLOR,
      isSpectator: false, socketId: BOT_KEY, roomId: this.id
    };
    if (!this.turnOrder.includes(BOT_KEY)) this.turnOrder.push(BOT_KEY);
    console.log(`🤖 Bot added to [${this.id}] with fresh card`);
  }

  removeBot() {
    if (!this.botActive) return;
    this.botActive = false;
    this.botCard = [];
    this.cancelBotTurn();
    delete sessions[BOT_KEY];
    const idx = this.turnOrder.indexOf(BOT_KEY);
    if (idx !== -1) {
      this.turnOrder.splice(idx, 1);
      if (this.turnOrder.length > 0) {
        if (idx < this.currentTurnIndex) this.currentTurnIndex--;
        this.currentTurnIndex = Math.max(0, this.currentTurnIndex % Math.max(this.turnOrder.length, 1));
      } else this.currentTurnIndex = 0;
    }
    console.log(`🤖 Bot removed from [${this.id}]`);
  }

  checkAndManageBot() {
    const real = this.getRealPlayerCount();
    if (real === 1 && !this.botActive) {
      this.addBot();
      if (this.getCurrentTurnKey() === BOT_KEY) this.scheduleBotTurn();
    } else if (real >= 2 && this.botActive) {
      this.removeBot();
    }
  }

  reset() {
    this.clearTurnTimer();
    this.cancelBotTurn();
    this.selectedNumbers = [];
    this.currentTurnIndex = 0;
    this.gameStarted = false;
    if (this.botActive) this.removeBot();
  }
}

// ── ROOM REGISTRY ──
const rooms = {};
let roomCounter = 1;

function getOrCreatePrimaryRoom() {
  if (!rooms['room_1']) {
    rooms['room_1'] = new GameRoom('room_1');
  }
  return rooms['room_1'];
}

function getRoomForSession(key) {
  const sess = sessions[key];
  if (!sess || !sess.roomId) return getOrCreatePrimaryRoom();
  return rooms[sess.roomId] || getOrCreatePrimaryRoom();
}

// ── REMOVE PLAYER (grace expired or AFK kick) ──
function removePlayerFromGame(key, reason) {
  const sess = sessions[key];
  if (!sess) return;

  const room = rooms[sess.roomId] || getOrCreatePrimaryRoom();
  const name = sess.name;
  const color = sess.color;

  // Cancel any pending grace timer
  if (sess.graceTimer) { clearTimeout(sess.graceTimer); sess.graceTimer = null; }

  // Remove socket mapping
  if (sess.socketId && sess.socketId !== BOT_KEY) delete socketMap[sess.socketId];

  // Remove from turnOrder
  const idx = room.turnOrder.indexOf(key);
  const wasCurrentTurn = idx !== -1 && (room.currentTurnIndex % Math.max(room.turnOrder.length, 1)) === idx;

  if (idx !== -1) {
    room.turnOrder.splice(idx, 1);
    if (room.turnOrder.length > 0) {
      if (idx < room.currentTurnIndex) room.currentTurnIndex--;
      else if (idx === room.currentTurnIndex) room.currentTurnIndex = room.currentTurnIndex % room.turnOrder.length;
      room.currentTurnIndex = Math.max(0, room.currentTurnIndex % Math.max(room.turnOrder.length, 1));
    } else room.currentTurnIndex = 0;
  }

  delete sessions[key];

  io.to(room.id).emit('player_left', { name, color });
  console.log(`🗑 [${room.id}] ${name} removed (${reason})`);

  const real = room.getRealPlayerCount();

  if (real === 0) {
    room.selectedNumbers.length = 0; room.currentTurnIndex = 0; room.gameStarted = false;
    room.turnOrder.length = 0; if (room.botActive) room.removeBot();
    room.broadcastState();
    if (room.id !== 'room_1') {
      delete rooms[room.id];
      console.log(`🧹 [Cleanup] Room [${room.id}] deleted (empty)`);
      broadcastRoomsSummary();
    }
    return;
  }

  if (real === 1 && room.gameStarted) {
    // Only 1 real player left mid-game — reset
    room.selectedNumbers.length = 0; room.currentTurnIndex = 0; room.gameStarted = false;
    Object.values(sessions).filter(s => s.roomId === room.id).forEach(s => { s.isSpectator = false; });
    io.to(room.id).emit('game_reset', { by: `auto (${name} left)` });
    room.checkAndManageBot(); room.broadcastState(); return;
  }

  room.checkAndManageBot();

  if (wasCurrentTurn) {
    room.clearTurnTimer();
    if (room.turnOrder.length >= 2) {
      if (room.getCurrentTurnKey() === BOT_KEY) room.scheduleBotTurn();
      else room.startTurnTimer();
    }
  }

  room.broadcastState();
}

function broadcastRoomsSummary() {
  const summary = Object.values(rooms).map(r => ({
    id: r.id,
    name: `Room ${r.id.replace('room_', '')}`,
    status: r.gameStarted ? 'Running' : (r.selectedNumbers.length > 0 ? 'Finished' : 'Lobby'),
    playerCount: r.getRealPlayerCount() + (r.botActive ? 1 : 0),
    maxPlayers: 5,
    botActive: r.botActive,
    isFull: r.getRealPlayerCount() >= 5
  }));
  io.emit('rooms_summary', { rooms: summary, waitingCount: waitingLobby.length });
}

function broadcastLobbyState() {
  waitingLobby.forEach((key, idx) => {
    const sock = getSocket(key);
    if (sock) {
      sock.emit('lobby_update', {
        inWaitingLobby: true,
        queuePosition: idx + 1,
        totalWaiting: waitingLobby.length
      });
    }
  });
}

function evaluateMatchmaking() {
  // Find running room or primary room
  const primary = getOrCreatePrimaryRoom();
  const runningRoom = Object.values(rooms).find(r => r.gameStarted) || primary;

  const activeCount = runningRoom.getRealPlayerCount();
  const availableSeats = Math.max(0, 5 - activeCount);

  // Dynamic Rule: If waitingLobby.length > availableSeats, move front 5 into a new game
  if (waitingLobby.length > availableSeats && waitingLobby.length > 0) {
    // Find an idle/finished room to reuse OR create a new room
    let targetRoom = Object.values(rooms).find(r => !r.gameStarted && r.turnOrder.length === 0);
    if (!targetRoom) {
      roomCounter++;
      const newId = `room_${roomCounter}`;
      targetRoom = new GameRoom(newId);
      rooms[newId] = targetRoom;
    }

    // Extract up to 5 players from FRONT of FIFO queue
    const batch = waitingLobby.splice(0, Math.min(5, waitingLobby.length));

    batch.forEach(key => {
      const sess = sessions[key];
      if (sess) {
        sess.roomId = targetRoom.id;
        sess.isSpectator = false;
        if (!targetRoom.turnOrder.includes(key)) targetRoom.turnOrder.push(key);
        const sock = getSocket(key);
        if (sock) {
          sock.leave('lobby');
          sock.join(targetRoom.id);
          sock.emit('game_ready', {
            roomId: targetRoom.id,
            roomName: `Room ${targetRoom.id.replace('room_', '')}`
          });
        }
      }
    });

    targetRoom.checkAndManageBot();
    targetRoom.broadcastState();
    broadcastLobbyState();
    broadcastRoomsSummary();
    console.log(`🚀 [Matchmaking] Created/Reused [${targetRoom.id}] with ${batch.length} players from FIFO queue`);
  }
}

function reuseRoomWithWaitingPlayers(room) {
  if (waitingLobby.length === 0) return false;

  room.reset();
  const batch = waitingLobby.splice(0, Math.min(5, waitingLobby.length));

  batch.forEach(key => {
    const sess = sessions[key];
    if (sess) {
      sess.roomId = room.id;
      sess.isSpectator = false;
      if (!room.turnOrder.includes(key)) room.turnOrder.push(key);
      const sock = getSocket(key);
      if (sock) {
        sock.leave('lobby');
        sock.join(room.id);
        sock.emit('game_ready', {
          roomId: room.id,
          roomName: `Room ${room.id.replace('room_', '')}`
        });
      }
    }
  });

  room.checkAndManageBot();
  room.broadcastState();
  broadcastLobbyState();
  broadcastRoomsSummary();
  console.log(`🔄 [Room Reuse] Reused [${room.id}] for ${batch.length} FIFO waiting players`);
  return true;
}

// ── TURN TIMER HELPER ──
function clearTurnTimer() {}
function startTurnTimer() {}

// ── CONNECTION ──

io.on('connection', (socket) => {

  // Emit current room summary to newly connected socket immediately
  broadcastRoomsSummary();

  socket.on('join', ({ name, sessionKey }) => {
    const trimmed = name.trim().slice(0, 20) || 'Anonymous';
    const key = sessionKey || makeSessionKey(trimmed);
    const existing = sessions[key];
    let color, isSpectator, isRejoin = false;
    let room;

    if (existing && key !== BOT_KEY) {
      // ── REJOIN ──
      color = existing.color;
      isSpectator = existing.isSpectator;
      isRejoin = true;
      room = rooms[existing.roomId] || getOrCreatePrimaryRoom();

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

      socket.join(room.id);

      console.log(`🔄 ${trimmed} REJOINED [${room.id}] — slot [${room.turnOrder.indexOf(key)}] idx=${room.currentTurnIndex} cur=${room.getCurrentTurnKey()}`);

      if (room.getCurrentTurnKey() === key && !room.turnTimer && room.gameStarted) {
        console.log(`  ↳ Resuming their turn timer`);
        room.startTurnTimer();
      }

    } else {
      // ── NEW PLAYER ──
      color = getNextColor();
      const primary = getOrCreatePrimaryRoom();

      if (primary.gameStarted || primary.getRealPlayerCount() >= 5) {
        // Game running or primary full — enter FIFO waitingLobby
        isSpectator = true;
        room = primary;
        sessions[key] = {
          name: trimmed, color, isSpectator: true,
          socketId: socket.id, calledNums: [], graceTimer: null,
          roomId: room.id
        };
        socketMap[socket.id] = key;
        if (!waitingLobby.includes(key)) waitingLobby.push(key);
        socket.join('lobby');
        socket.join(room.id); // Join room to spectate
        evaluateMatchmaking();
        console.log(`⏳ ${trimmed} added to FIFO waitingLobby (pos ${waitingLobby.length})`);
      } else {
        isSpectator = false;
        room = primary;
        sessions[key] = {
          name: trimmed, color, isSpectator: false,
          socketId: socket.id, calledNums: [], graceTimer: null,
          roomId: room.id
        };
        socketMap[socket.id] = key;
        socket.join(room.id);
        if (!room.turnOrder.includes(key)) room.turnOrder.push(key);
        console.log(`✅ ${trimmed} joined [${room.id}] turnOrder:`, room.turnOrder);
      }
    }

    room.checkAndManageBot();

    const inLobby = waitingLobby.includes(key);
    const qPos = inLobby ? waitingLobby.indexOf(key) + 1 : 0;

    socket.emit('joined', {
      playerId: socket.id, playerName: trimmed, playerColor: color,
      isSpectator, isRejoin, sessionKey: key,
      turnRemainingSeconds: room.getTurnRemainingSeconds(),
      inWaitingLobby: inLobby,
      queuePosition: qPos
    });

    io.to(room.id).emit('player_joined', { name: trimmed, color, isSpectator, isRejoin });

    const curKey = room.getCurrentTurnKey();
    if (room.gameStarted && curKey && curKey !== BOT_KEY && !room.turnTimer) room.startTurnTimer();
    if (room.botActive && curKey === BOT_KEY && !room.botTurnTimer) room.scheduleBotTurn();

    room.broadcastState();
    broadcastLobbyState();
    broadcastRoomsSummary();
  });

  socket.on('spectate_room', ({ roomId }) => {
    const key = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess) return;
    const target = rooms[roomId];
    if (!target) return;

    Object.keys(rooms).forEach(rid => {
      if (rid !== sess.roomId) socket.leave(rid);
    });
    socket.join(target.id);
    target.broadcastState();
  });

  socket.on('submit_number', ({ number }) => {
    const key = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess || sess.isSpectator) {
      socket.emit('error_msg', { message: '👀 Spectator only!' }); return;
    }
    const room = rooms[sess.roomId] || getOrCreatePrimaryRoom();
    const num = parseInt(number, 10);
    if (isNaN(num) || num < 1 || num > 25) {
      socket.emit('error_msg', { message: '⚠ Number must be 1-25!' }); return;
    }
    if (room.selectedNumbers.some(n => n.number === num)) {
      socket.emit('error_msg', { message: `⚠ ${num} already called!` }); return;
    }
    if (room.getCurrentTurnKey() !== key) {
      socket.emit('error_msg', { message: "⏳ Not your turn!" }); return;
    }
    if (room.buildPlayerList().length < 2) {
      socket.emit('error_msg', { message: '⏳ Need another player!' }); return;
    }
    if (!room.gameStarted) room.gameStarted = true;

    room.selectedNumbers.push({
      number: num, playerName: sess.name,
      playerColor: sess.color, timestamp: Date.now()
    });
    (sess.calledNums = sess.calledNums || []).push(num);

    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
    room.startTurnTimer();

    io.to(room.id).emit('number_called', { number: num, playerName: sess.name, playerColor: sess.color });

    if (room.checkDraw()) {
      room.clearTurnTimer(); room.cancelBotTurn();
      io.to(room.id).emit('game_draw', {});
      broadcastRoomsSummary();
      return;
    }

    room.broadcastState();
    if (room.getCurrentTurnKey() === BOT_KEY) room.scheduleBotTurn();
    console.log(`  [${room.id}] [${sess.name} called ${num}] next: ${room.getCurrentTurnKey()} idx=${room.currentTurnIndex}`);
  });

  socket.on('bingo_claimed', ({ winners }) => {
    const key = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess) return;
    const room = rooms[sess.roomId] || getOrCreatePrimaryRoom();
    room.clearTurnTimer(); room.cancelBotTurn(); room.cancelBotBingoTimer();
    let finalWinners = winners || [{ name: sess.name, color: sess.color }];
    if (room.checkBotBingo() && !finalWinners.some(w => w.name === BOT_NAME)) {
      finalWinners.push({ name: BOT_NAME, color: BOT_COLOR });
    }
    io.to(room.id).emit('bingo_announced', { winners: finalWinners });
    broadcastRoomsSummary();
  });

  socket.on('reset_game', () => {
    const key = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess) return;
    const room = rooms[sess.roomId] || getOrCreatePrimaryRoom();

    if (waitingLobby.length > 0) {
      reuseRoomWithWaitingPlayers(room);
    } else {
      room.clearTurnTimer(); room.cancelBotTurn();
      room.selectedNumbers.length = 0; room.currentTurnIndex = 0; room.gameStarted = false;

      Object.entries(sessions).forEach(([k, s]) => {
        if (k === BOT_KEY || s.roomId !== room.id) return;
        s.isSpectator = false;
        if (!room.turnOrder.includes(k)) room.turnOrder.push(k);
      });

      if (room.botActive) room.removeBot();
      room.checkAndManageBot();

      io.to(room.id).emit('game_reset', { by: sess.name });
      room.broadcastState();
    }
    broadcastRoomsSummary();
  });

  socket.on('disconnect', () => {
    const key = keyOf(socket.id);
    if (!key || key === BOT_KEY) return;

    const sess = sessions[key];
    if (!sess) { delete socketMap[socket.id]; return; }

    const lobbyIdx = waitingLobby.indexOf(key);
    if (lobbyIdx !== -1) {
      waitingLobby.splice(lobbyIdx, 1);
      broadcastLobbyState();
      broadcastRoomsSummary();
    }

    const room = rooms[sess.roomId] || getOrCreatePrimaryRoom();

    console.log(`👋 ${sess.name} disconnected (${socket.id}) from [${room.id}]`);
    io.to(room.id).emit('player_left', { name: sess.name, color: sess.color });

    sess.socketId = null;
    delete socketMap[socket.id];

    const wasMyTurn = room.getCurrentTurnKey() === key;
    if (wasMyTurn) {
      room.clearTurnTimer();
      room.cancelBotTurn();
      console.log(`  [${room.id}] Turn paused — waiting ${GRACE_PERIOD_MS / 1000}s grace period for ${sess.name}`);
    }

    sess.graceTimer = setTimeout(() => {
      const s = sessions[key];
      if (s && !s.socketId) {
        console.log(`  Grace expired for ${s.name} — removing from game`);
        removePlayerFromGame(key, 'grace period expired (left game)');
      }
    }, GRACE_PERIOD_MS);

    room.broadcastState();
    broadcastRoomsSummary();
  });
});

app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain')
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'))
})

app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml')
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'))
})

const PORT = process.env.PORT || 9000;
server.listen(PORT, () => {
  console.log(`🎱 Bingo Blaster running on http://localhost:${PORT}`);
});