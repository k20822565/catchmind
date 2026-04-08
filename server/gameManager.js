const { getRandomWord } = require('./words');

const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateCode() : code;
}

function createRoom(hostId, hostNick) {
  const code = generateCode();
  rooms[code] = {
    code,
    hostId,
    players: [{ id: hostId, nick: hostNick, score: 0 }],
    settings: { rounds: 3, timeLimit: 60 },
    state: 'waiting',
    currentRound: 0,
    currentDrawerIndex: 0,
    currentWord: null,
    correctPlayers: [],
    timer: null,
    turnEnding: false, // 이중 턴 종료 방지
  };
  return rooms[code];
}

function joinRoom(code, playerId, nick) {
  const room = rooms[code];
  if (!room) return { error: '존재하지 않는 방 코드입니다.' };
  if (room.state !== 'waiting') return { error: '이미 게임이 진행 중입니다.' };
  if (room.players.length >= 6) return { error: '방이 가득 찼습니다.' };
  if (room.players.find(p => p.nick === nick)) return { error: '이미 사용 중인 닉네임입니다.' };
  room.players.push({ id: playerId, score: 0, nick });
  return { room };
}

function leaveRoom(playerId) {
  for (const code in rooms) {
    const room = rooms[code];
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx === -1) continue;
    room.players.splice(idx, 1);
    if (room.players.length === 0) {
      clearTimeout(room.timer);
      delete rooms[code];
      return { code, deleted: true };
    }
    if (room.hostId === playerId) {
      room.hostId = room.players[0].id;
    }
    return { code, room, deleted: false };
  }
  return null;
}

function startGame(code, io) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'playing';
  room.currentRound = 1;
  room.currentDrawerIndex = 0;
  room.players.forEach(p => p.score = 0);
  startTurn(code, io);
}

function startTurn(code, io) {
  const room = rooms[code];
  if (!room || room.state !== 'playing') return;

  room.correctPlayers = [];
  room.turnEnding = false;
  room.currentWord = getRandomWord();

  const drawer = room.players[room.currentDrawerIndex];
  const timeLimit = room.settings.timeLimit;

  io.to(code).emit('turn:start', {
    drawerNick: drawer.nick,
    drawerId: drawer.id,
    round: room.currentRound,
    totalRounds: room.settings.rounds,
    timeLimit,
    players: room.players.map(p => ({ nick: p.nick, score: p.score, id: p.id })),
  });

  io.to(drawer.id).emit('word:assign', { word: room.currentWord });

  room.timer = setTimeout(() => {
    endTurn(code, io, false);
  }, timeLimit * 1000);
}

function checkAnswer(code, playerId, answer, io) {
  const room = rooms[code];
  if (!room || room.state !== 'playing' || room.turnEnding) return false;

  const drawer = room.players[room.currentDrawerIndex];
  if (playerId === drawer.id) return false;
  if (room.correctPlayers.includes(playerId)) return false;

  const normalized = answer.trim().replace(/\s/g, '');
  if (normalized !== room.currentWord) return false;

  const player = room.players.find(p => p.id === playerId);
  if (!player) return false;

  room.correctPlayers.push(playerId);

  const bonus = Math.max(1, 3 - room.correctPlayers.length + 1);
  player.score += bonus;

  if (room.correctPlayers.length === 1) {
    drawer.score += 1;
  }

  io.to(code).emit('answer:correct', {
    nick: player.nick,
    word: room.currentWord,
    players: room.players.map(p => ({ nick: p.nick, score: p.score, id: p.id })),
  });

  const nonDrawers = room.players.filter(p => p.id !== drawer.id);
  if (nonDrawers.length > 0 && room.correctPlayers.length >= nonDrawers.length) {
    clearTimeout(room.timer);
    setTimeout(() => endTurn(code, io, true), 1500);
  }

  return true;
}

function endTurn(code, io, allCorrect) {
  const room = rooms[code];
  if (!room || room.state !== 'playing' || room.turnEnding) return;
  room.turnEnding = true;
  clearTimeout(room.timer);

  io.to(code).emit('turn:end', {
    word: room.currentWord,
    players: room.players.map(p => ({ nick: p.nick, score: p.score, id: p.id })),
    allCorrect,
  });

  room.currentDrawerIndex++;
  if (room.currentDrawerIndex >= room.players.length) {
    room.currentDrawerIndex = 0;
    room.currentRound++;
  }

  if (room.currentRound > room.settings.rounds) {
    setTimeout(() => endGame(code, io), 3000);
  } else {
    setTimeout(() => startTurn(code, io), 3000);
  }
}

function endGame(code, io) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'result';
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  io.to(code).emit('game:end', { players: sorted });
}

function skipTurn(code, playerId, io) {
  const room = rooms[code];
  if (!room || room.state !== 'playing' || room.turnEnding) return false;
  const drawer = room.players[room.currentDrawerIndex];
  if (!drawer || drawer.id !== playerId) return false;
  clearTimeout(room.timer);
  endTurn(code, io, false);
  return true;
}

function getRoom(code) {
  return rooms[code] || null;
}

module.exports = { createRoom, joinRoom, leaveRoom, startGame, checkAnswer, skipTurn, getRoom };
