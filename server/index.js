const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createRoom, joinRoom, leaveRoom, startGame, checkAnswer, skipTurn, getRoom } = require('./gameManager');

// room 객체에서 timer(Node.js Timeout 객체) 등 직렬화 불가 필드 제거
function sr(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    players: room.players.map(p => ({ id: p.id, nick: p.nick, score: p.score })),
    settings: { rounds: room.settings.rounds, timeLimit: room.settings.timeLimit },
  };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  cors: { origin: '*' },
});

const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// 모든 경로에 index.html 제공 (404 방지)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

io.on('connection', (socket) => {

  socket.on('room:create', ({ nick }, callback) => {
    const room = createRoom(socket.id, nick);
    socket.join(room.code);
    callback({ room: sr(room) });
  });

  socket.on('room:join', ({ code, nick }, callback) => {
    const result = joinRoom(code.toUpperCase(), socket.id, nick);
    if (result.error) return callback({ error: result.error });
    socket.join(code.toUpperCase());
    io.to(code.toUpperCase()).emit('room:update', { room: sr(result.room) });
    callback({ room: sr(result.room) });
  });

  socket.on('room:settings', ({ code, rounds, timeLimit }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    room.settings.rounds = rounds;
    room.settings.timeLimit = timeLimit;
    io.to(code).emit('room:update', { room: sr(room) });
  });

  socket.on('game:start', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return;
    startGame(code, io);
  });

  socket.on('draw:data', ({ code, data }) => {
    socket.to(code).emit('draw:data', { ...data, drawerId: socket.id });
  });

  socket.on('draw:clear', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    const drawer = room.players[room.currentDrawerIndex];
    if (drawer && drawer.id === socket.id) {
      io.to(code).emit('draw:clear', { drawerId: socket.id });
    }
  });

  socket.on('draw:undo', ({ code, imageData }) => {
    socket.to(code).emit('draw:undo', { drawerId: socket.id, imageData });
  });

  socket.on('answer:submit', ({ code, answer }) => {
    checkAnswer(code, socket.id, answer, io);
  });

  socket.on('turn:skip', ({ code }) => {
    skipTurn(code, socket.id, io);
  });

  socket.on('chat:message', ({ code, nick, message }) => {
    io.to(code).emit('chat:message', { nick, message });
  });

  socket.on('game:restart', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    room.state = 'waiting';
    room.currentRound = 0;
    room.currentDrawerIndex = 0;
    room.players.forEach(p => p.score = 0);
    io.to(code).emit('room:restart', { room: sr(room) });
  });

  socket.on('disconnect', () => {
    const result = leaveRoom(socket.id);
    if (!result || result.deleted) return;
    io.to(result.code).emit('room:update', { room: sr(result.room) });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
