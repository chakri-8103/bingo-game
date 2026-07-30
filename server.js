const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// SESSIONS & STATE MANAGEMENT
// turnOrder stores SESSION KEYS (stable). socketMap is lookup.
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

    this.countdownActive = false;
    this.countdownTimer = null;
    this.countdownSec = 3;

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

    const globalPlayerCount = Object.values(sessions).filter(s => s.socketId && s.socketId !== BOT_KEY).length;
    const activeRoomsCount = Object.values(rooms).filter(r => r.gameStarted || r.countdownActive || r.getRealPlayerCount() > 0).length;

    io.to(this.id).emit('state_update', {
      selectedNumbers: this.selectedNumbers,
      players: all,
      playerCount: all.filter(p => !p.isBot).length,
      activePlayerCount: actCount,
      currentTurnPlayerId: turnPlayerId,
      gameStarted: this.gameStarted,
      countdownActive: this.countdownActive,
      countdownSec: this.countdownSec,
      turnRemainingSeconds: this.getTurnRemainingSeconds(),
      botActive: this.botActive,
      globalPlayerCount: globalPlayerCount,
      activeRoomsCount: activeRoomsCount
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

  // ── LOBBY AUTO-START COUNTDOWN (Triggered ONLY when 5th real player joins) ──
  startLobbyCountdown() {
    if (this.gameStarted || this.countdownActive) return;
    this.countdownActive = true;
    this.countdownSec = 3;

    console.log(`⏱ [${this.id}] Auto-start countdown (5th player): 3...`);
    io.to(this.id).emit('game_starting_countdown', { count: 3 });
    this.broadcastState();

    this.countdownTimer = setInterval(() => {
      this.countdownSec--;
      if (this.countdownSec > 0) {
        console.log(`⏱ [${this.id}] Countdown: ${this.countdownSec}...`);
        io.to(this.id).emit('game_starting_countdown', { count: this.countdownSec });
        this.broadcastState();
      } else {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.countdownActive = false;
        this.gameStarted = true;

        console.log(`🚀 [${this.id}] Game COMMITTED & STARTED!`);
        io.to(this.id).emit('game_starting_countdown', { count: 0 });
        this.broadcastState();
        if (this.getCurrentTurnKey() === BOT_KEY) this.scheduleBotTurn();
        else this.startTurnTimer();
        broadcastRoomsSummary();
      }
    }, 1000);
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
    // Rule 1 & 3: Add bot ONLY when real === 1 AND in non-started/non-counting-down lobby
    if (real === 1 && !this.botActive && !this.gameStarted && !this.countdownActive) {
      this.addBot();
    } else if (real >= 2 && this.botActive) {
      this.removeBot();
    }
  }

  reset() {
    this.clearTurnTimer();
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    this.countdownActive = false;
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

// ── REMOVE PLAYER (grace expired or AFK kick) ──
function removePlayerFromGame(key, reason) {
  const sess = sessions[key];
  if (!sess) return;

  const room = rooms[sess.roomId] || getOrCreatePrimaryRoom();
  const name = sess.name;

  if (sess.graceTimer) { clearTimeout(sess.graceTimer); sess.graceTimer = null; }
  if (sess.socketId && sess.socketId !== BOT_KEY) delete socketMap[sess.socketId];

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

  io.to(room.id).emit('player_left', { name, color: sess.color });
  console.log(`🗑 [${room.id}] ${name} removed (${reason})`);

  const real = room.getRealPlayerCount();

  if (real === 0) {
    room.reset();
    room.broadcastState();
    if (room.id !== 'room_1') {
      delete rooms[room.id];
      console.log(`🧹 [Cleanup] Room [${room.id}] deleted (empty)`);
    }
    broadcastRoomsSummary();
    evaluateMatchmaking();
    return;
  }

  room.checkAndManageBot();

  if (wasCurrentTurn && room.gameStarted) {
    room.clearTurnTimer();
    if (room.turnOrder.length >= 2) {
      if (room.getCurrentTurnKey() === BOT_KEY) room.scheduleBotTurn();
      else room.startTurnTimer();
    }
  }

  room.broadcastState();
  broadcastRoomsSummary();

  // Evaluate matchmaking to fill any vacated seat if in lobby mode
  if (!room.gameStarted && !room.countdownActive) {
    evaluateMatchmaking();
  }
}

function broadcastRoomsSummary() {
  const globalPlayerCount = Object.values(sessions).filter(s => s.socketId && s.socketId !== BOT_KEY).length;
  const activeRooms = Object.values(rooms).filter(r => r.gameStarted || r.countdownActive || r.getRealPlayerCount() > 0);

  const summary = activeRooms.map(r => ({
    id: r.id,
    name: `Room ${r.id.replace('room_', '')}`,
    status: r.gameStarted ? 'Running' : (r.countdownActive ? 'Starting' : (r.selectedNumbers.length > 0 ? 'Finished' : 'Lobby')),
    playerCount: r.getRealPlayerCount() + (r.botActive ? 1 : 0),
    maxPlayers: 5,
    botActive: r.botActive,
    isFull: r.getRealPlayerCount() >= 5
  }));

  io.emit('rooms_summary', {
    rooms: summary,
    waitingCount: waitingLobby.length,
    globalPlayerCount: globalPlayerCount,
    activeRoomsCount: activeRooms.length
  });
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

// ─────────────────────────────────────────────────────────────
// COMPREHENSIVE STRICT FIFO MATCHMAKING ENGINE
// Rules 1-6:
// 1. Fill available seats in ALL existing lobby rooms first in FIFO order.
// 2. Lock running/counting-down rooms (no entries).
// 3. Reuse finished rooms when they reset.
// 4. Create new rooms ONLY when waiting count exceeds total available lobby seats across all existing rooms (and not all rooms are running).
// ─────────────────────────────────────────────────────────────
function evaluateMatchmaking() {
  if (waitingLobby.length === 0) return;

  // Phase A: Fill available seats in ALL existing open Lobby rooms in deterministic order
  const openLobbyRooms = Object.values(rooms).filter(r => !r.gameStarted && !r.countdownActive && r.getRealPlayerCount() < 5);

  for (const targetRoom of openLobbyRooms) {
    if (waitingLobby.length === 0) break;
    const availableSeats = Math.max(0, 5 - targetRoom.getRealPlayerCount());
    if (availableSeats <= 0) continue;

    // Dequeue front players from waitingLobby in strict FIFO order
    const batch = waitingLobby.splice(0, Math.min(availableSeats, waitingLobby.length));

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

    // Auto-start 3-2-1 countdown if room reaches 5 real players
    if (targetRoom.getRealPlayerCount() >= 5 && !targetRoom.gameStarted && !targetRoom.countdownActive) {
      console.log(`🚀 [Auto-Start] 5th player joined [${targetRoom.id}] — Starting 3-2-1 countdown!`);
      targetRoom.startLobbyCountdown();
    }

    targetRoom.broadcastState();
    console.log(`🚀 [Matchmaking] Filled ${batch.length} player(s) into existing lobby [${targetRoom.id}] in FIFO order`);
  }

  broadcastLobbyState();
  broadcastRoomsSummary();

  // Phase B: Handle excess waiting players after ALL existing lobby seats are filled
  if (waitingLobby.length > 0) {
    const runningRoomFutureSeats = Object.values(rooms)
      .filter(r => r.gameStarted || r.countdownActive)
      .reduce((sum, r) => sum + Math.max(0, 5 - r.getRealPlayerCount()), 0);

    if (waitingLobby.length > runningRoomFutureSeats) {
      // Waiting queue exceeds what running rooms can absorb upon finishing.
      // Create a new room for the excess waiting players.
      roomCounter++;
      const newId = `room_${roomCounter}`;
      const newRoom = new GameRoom(newId);
      rooms[newId] = newRoom;

      const batch = waitingLobby.splice(0, Math.min(5, waitingLobby.length));
      batch.forEach(key => {
        const sess = sessions[key];
        if (sess) {
          sess.roomId = newRoom.id;
          sess.isSpectator = false;
          if (!newRoom.turnOrder.includes(key)) newRoom.turnOrder.push(key);
          const sock = getSocket(key);
          if (sock) {
            sock.leave('lobby');
            sock.join(newRoom.id);
            sock.emit('game_ready', {
              roomId: newRoom.id,
              roomName: `Room ${newRoom.id.replace('room_', '')}`
            });
          }
        }
      });

      newRoom.checkAndManageBot();

      if (newRoom.getRealPlayerCount() >= 5 && !newRoom.gameStarted && !newRoom.countdownActive) {
        newRoom.startLobbyCountdown();
      }

      newRoom.broadcastState();
      broadcastLobbyState();
      broadcastRoomsSummary();
      console.log(`🚀 [Matchmaking] Created new room [${newRoom.id}] for ${batch.length} excess waiting players`);

      if (waitingLobby.length > 0) {
        evaluateMatchmaking();
      }
    }
  }
}

// ── CONNECTION & EVENT HANDLING ──

io.on('connection', (socket) => {

  broadcastRoomsSummary();

  socket.on('join', ({ name, sessionKey }) => {
    const trimmed = name.trim().slice(0, 20) || 'Anonymous';
    const key = sessionKey || makeSessionKey(trimmed);
    const existing = sessions[key];
    let color, isSpectator, isRejoin = false;
    let room;

    if (existing && key !== BOT_KEY) {
      room = rooms[existing.roomId];

      if (room && (room.gameStarted || room.countdownActive || room.turnOrder.includes(key))) {
        // Rejoin active room (Rule 4)
        color = existing.color;
        isSpectator = existing.isSpectator;
        isRejoin = true;

        if (existing.graceTimer) {
          clearTimeout(existing.graceTimer);
          existing.graceTimer = null;
          console.log(`  ↳ Grace timer cancelled — ${trimmed} rejoined in time`);
        }

        if (existing.socketId && existing.socketId !== socket.id) {
          delete socketMap[existing.socketId];
        }
        existing.socketId = socket.id;
        socketMap[socket.id] = key;

        socket.join(room.id);
        console.log(`🔄 ${trimmed} REJOINED [${room.id}] — turn index=${room.currentTurnIndex}`);

        if (room.getCurrentTurnKey() === key && !room.turnTimer && room.gameStarted) {
          room.startTurnTimer();
        }

      } else {
        // Return after game ended (Rule 5): Clear old session, route to FIFO queue
        if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
        delete sessions[key];
        color = getNextColor();
        isSpectator = true;

        sessions[key] = {
          name: trimmed, color, isSpectator: true,
          socketId: socket.id, calledNums: [], graceTimer: null,
          roomId: 'lobby'
        };
        socketMap[socket.id] = key;
        if (!waitingLobby.includes(key)) waitingLobby.push(key);
        socket.join('lobby');
        evaluateMatchmaking();
        console.log(`⏳ ${trimmed} returned after game ended — routed to FIFO waitingLobby (pos ${waitingLobby.length})`);
        
        const assignedSess = sessions[key];
        room = rooms[assignedSess ? assignedSess.roomId : null] || getOrCreatePrimaryRoom();
      }

    } else {
      // ── NEW PLAYER ──
      // Enqueue in strict FIFO queue and process matchmaking
      color = getNextColor();
      const primary = getOrCreatePrimaryRoom();
      room = primary;
      sessions[key] = {
        name: trimmed, color, isSpectator: true,
        socketId: socket.id, calledNums: [], graceTimer: null,
        roomId: room.id
      };
      socketMap[socket.id] = key;
      if (!waitingLobby.includes(key)) waitingLobby.push(key);
      socket.join('lobby');

      evaluateMatchmaking();
      console.log(`⏳ ${trimmed} enqueued in FIFO waitingLobby & processed`);

      const assignedSess = sessions[key];
      if (assignedSess && assignedSess.roomId && rooms[assignedSess.roomId]) {
        room = rooms[assignedSess.roomId];
      }
    }

    room.checkAndManageBot();

    const inLobby = waitingLobby.includes(key);
    const qPos = inLobby ? waitingLobby.indexOf(key) + 1 : 0;

    socket.emit('joined', {
      playerId: socket.id, playerName: trimmed, playerColor: color,
      isSpectator: sessions[key] ? sessions[key].isSpectator : isSpectator,
      isRejoin, sessionKey: key,
      turnRemainingSeconds: room.getTurnRemainingSeconds(),
      inWaitingLobby: inLobby,
      queuePosition: qPos
    });

    io.to(room.id).emit('player_joined', { name: trimmed, color, isSpectator: sessions[key] ? sessions[key].isSpectator : isSpectator, isRejoin });

    room.broadcastState();
    broadcastLobbyState();
    broadcastRoomsSummary();
  });

  socket.on('spectate_room', ({ roomId }) => {
    const key = keyOf(socket.id);
    const sess = key ? sessions[key] : null;
    if (!sess) return;

    if (!sess.isSpectator) {
      socket.emit('error_msg', { message: '⚠ Active players cannot spectate other rooms!' });
      return;
    }

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

    // First click game start for 2-4 player lobbies
    if (!room.gameStarted) {
      room.gameStarted = true;
      console.log(`🎮 Game automatically started in [${room.id}] by ${sess.name} calling number ${num}`);
    }

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

    room.reset();

    Object.entries(sessions).forEach(([k, s]) => {
      if (k === BOT_KEY || s.roomId !== room.id) return;
      s.isSpectator = false;
      if (!room.turnOrder.includes(k)) room.turnOrder.push(k);
    });

    room.checkAndManageBot();
    io.to(room.id).emit('game_reset', { by: sess.name });
    room.broadcastState();

    if (waitingLobby.length > 0) {
      evaluateMatchmaking();
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

    if (!room.gameStarted && !room.countdownActive) {
      room.checkAndManageBot();
    }

    const wasMyTurn = room.getCurrentTurnKey() === key;
    if (wasMyTurn && room.gameStarted) {
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
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

const PORT = process.env.PORT || 9000;
server.listen(PORT, () => {
  console.log(`🎱 Bingo Blaster running on http://localhost:${PORT}`);
});