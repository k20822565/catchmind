/* ── 캐치마인드 클라이언트 ── */
const socket = io(window._socketOptions || {});

// 고정 캔버스 내부 해상도 (모든 클라이언트 동일)
const CANVAS_W = 1000;
const CANVAS_H = 600;

// ── 상태 ──
let myNick = '';
let myRoom = null;
let isHost = false;
let isDrawer = false;
let currentDrawerId = '';
let timerInterval = null;

// 드로잉
let currentColor = '#000000';
let currentSize = 2;
let drawing = false;

// 플레이어별 캔버스: socketId -> { canvas, ctx, history[] }
const playerCanvases = {};

// ── DOM 헬퍼 ──
const $ = id => document.getElementById(id);
const screens = { lobby: $('lobby'), waiting: $('waiting'), game: $('game'), result: $('result') };

function showScreen(name) {
  Object.keys(screens).forEach(k => {
    screens[k].style.display = k === name ? 'flex' : 'none';
  });
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

// ── 엑셀 헤더/행번호 ──
function renderExcelChrome() {
  const cols = $('col-cells');
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').slice(0, 22).forEach(c => {
    const div = document.createElement('div');
    div.className = 'col-cell';
    div.textContent = c;
    cols.appendChild(div);
  });
  const rows = $('row-numbers');
  for (let i = 1; i <= 60; i++) {
    const div = document.createElement('div');
    div.className = 'row-num';
    div.textContent = i;
    rows.appendChild(div);
  }
}

// ── 초기화 ──
window.addEventListener('DOMContentLoaded', () => {
  renderExcelChrome();
  initColorPalette();
  initBrushSizes();
  bindLobby();
  bindWaiting();
  bindGame();
  bindSocket();
  showScreen('lobby');
});

// ── 로비 ──
function bindLobby() {
  $('btn-create').addEventListener('click', () => {
    const nick = $('nick-input').value.trim();
    if (!nick) return toast('닉네임을 입력해주세요.');
    myNick = nick;
    socket.emit('room:create', { nick }, ({ room }) => {
      myRoom = room; isHost = true; enterWaiting(room);
    });
  });
  $('nick-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create').click(); });

  $('btn-join').addEventListener('click', () => {
    const nick = $('nick-input2').value.trim();
    const code = $('code-input').value.trim().toUpperCase();
    if (!nick) return toast('닉네임을 입력해주세요.');
    if (code.length !== 4) return toast('4자리 코드를 입력해주세요.');
    myNick = nick;
    socket.emit('room:join', { code, nick }, ({ error, room }) => {
      if (error) return toast(error);
      myRoom = room; isHost = room.hostId === socket.id; enterWaiting(room);
    });
  });
  $('code-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });
}

// ── 대기실 ──
function enterWaiting(room) {
  myRoom = room; isHost = room.hostId === socket.id;
  updateWaiting(room);
  showScreen('waiting');
  $('room-code-display').style.display = '';
  $('toolbar-code').textContent = room.code;
}

function updateWaiting(room) {
  myRoom = room; isHost = room.hostId === socket.id;
  $('waiting-code').textContent = room.code;
  $('toolbar-code').textContent = room.code;

  const tbody = $('waiting-players');
  tbody.innerHTML = '';
  room.players.forEach((p, i) => {
    const tr = document.createElement('tr');
    const badge = p.id === room.hostId ? '<span class="host-badge">[방장]</span>' : '';
    tr.innerHTML = `<td>${i + 1}</td><td>${esc(p.nick)}${badge}</td><td style="color:var(--correct)">대기중</td>`;
    tbody.appendChild(tr);
  });

  $('sel-rounds').disabled = !isHost;
  $('sel-time').disabled = !isHost;
  $('btn-start').disabled = !isHost || room.players.length < 2;
  if (room.settings) {
    $('sel-rounds').value = room.settings.rounds;
    $('sel-time').value = room.settings.timeLimit;
  }
}

function bindWaiting() {
  $('btn-copy-code').addEventListener('click', copyCode);
  $('btn-copy-toolbar').addEventListener('click', copyCode);
  $('btn-start').addEventListener('click', () => socket.emit('game:start', { code: myRoom.code }));
  $('btn-leave-waiting').addEventListener('click', () => location.reload());
  $('sel-rounds').addEventListener('change', sendSettings);
  $('sel-time').addEventListener('change', sendSettings);
}

function copyCode() {
  navigator.clipboard.writeText(myRoom.code).then(() => toast('코드가 복사되었습니다.'));
}

function sendSettings() {
  if (!isHost) return;
  socket.emit('room:settings', {
    code: myRoom.code,
    rounds: parseInt($('sel-rounds').value),
    timeLimit: parseInt($('sel-time').value),
  });
}

// ── 게임 진입 ──
function enterGame(players) {
  showScreen('game');
  $('chat-messages').innerHTML = '';
  buildPanelsGrid(players);
}

// ── 패널 그리드 구성 ──
function buildPanelsGrid(players) {
  // 기존 정리
  Object.keys(playerCanvases).forEach(k => delete playerCanvases[k]);

  const grid = $('panels-grid');
  grid.innerHTML = '';

  const cols = players.length <= 2 ? players.length : 2;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  players.forEach(player => {
    // 패널 컨테이너
    const panel = document.createElement('div');
    panel.className = 'player-panel';
    panel.id = `panel-${player.id}`;

    // 헤더
    const header = document.createElement('div');
    header.className = 'panel-header';
    header.id = `panelh-${player.id}`;
    header.innerHTML = `
      <span class="ph-nick">${esc(player.nick)}</span>
      <span class="ph-score" id="phscore-${player.id}">0점</span>
    `;

    // 캔버스 래퍼 (flex-grow를 캔버스에 직접 주면 canvas 크기가 이상해지므로 div로 감쌈)
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';

    const canvas = document.createElement('canvas');
    canvas.id = `cv-${player.id}`;
    canvas.className = 'player-canvas readonly';
    // 고정 내부 해상도
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    canvas.style.cssText = 'display:block;width:100%;height:100%;background:#fff;cursor:crosshair;';

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    wrap.appendChild(canvas);
    panel.appendChild(header);
    panel.appendChild(wrap);
    grid.appendChild(panel);

    playerCanvases[player.id] = { canvas, ctx, history: [] };
  });

  // 내 캔버스에 이벤트 바인딩
  setTimeout(() => bindMyCanvas(), 50);
}

function bindMyCanvas() {
  const pc = playerCanvases[socket.id];
  if (!pc) return;
  const { canvas } = pc;
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseUp);
}

// ── 게임 이벤트 ──
function bindGame() {
  $('btn-answer').addEventListener('click', submitAnswer);
  $('answer-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitAnswer(); });

  $('btn-chat').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  $('btn-undo').addEventListener('click', doUndo);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && isDrawer) { e.preventDefault(); doUndo(); }
  });

  $('btn-clear').addEventListener('click', () => {
    if (!isDrawer) return;
    saveHistory(socket.id);
    clearCanvasById(socket.id);
    socket.emit('draw:clear', { code: myRoom.code });
  });

  $('btn-restart').addEventListener('click', () => socket.emit('game:restart', { code: myRoom.code }));
  $('btn-leave-result').addEventListener('click', () => location.reload());
}

function submitAnswer() {
  if (isDrawer) return;
  const answer = $('answer-input').value.trim();
  if (!answer) return;
  socket.emit('answer:submit', { code: myRoom.code, answer });
  $('answer-input').value = '';
}

function sendChat() {
  const msg = $('chat-input').value.trim();
  if (!msg) return;
  socket.emit('chat:message', { code: myRoom.code, nick: myNick, message: msg });
  $('chat-input').value = '';
}

function addChat(html) {
  const el = $('chat-messages');
  const div = document.createElement('div');
  div.innerHTML = html;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ── 점수판 ──
function updateScoreBoard(players) {
  const tbody = $('score-body');
  tbody.innerHTML = '';
  players.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(p.nick)}${p.id === myRoom.hostId ? '<span class="host-badge">[방장]</span>' : ''}</td><td>${p.score}</td>`;
    tbody.appendChild(tr);
    const scoreEl = $(`phscore-${p.id}`);
    if (scoreEl) scoreEl.textContent = `${p.score}점`;
  });
}

// ── 타이머 ──
function startTimer(seconds) {
  clearInterval(timerInterval);
  let t = seconds;
  const el = $('st-timer');
  const tick = () => {
    const m = String(Math.floor(t / 60)).padStart(2, '0');
    const s = String(Math.max(0, t % 60)).padStart(2, '0');
    el.textContent = `${m}:${s}`;
    el.classList.toggle('timer-danger', t <= 10);
    if (t > 0) t--;
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

// ── 드로잉 도구 ──
const COLORS = ['#000000','#ffffff','#c00000','#e36c09','#ffff00','#00b050','#1f5c99','#7030a0','#595959','#ff69b4'];

function initColorPalette() {
  const palette = $('color-palette');
  COLORS.forEach(c => {
    const div = document.createElement('div');
    div.className = 'color-swatch' + (c === currentColor ? ' active' : '');
    div.style.background = c;
    div.addEventListener('click', () => {
      if (!isDrawer) return;
      currentColor = c;
      palette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      div.classList.add('active');
    });
    palette.appendChild(div);
  });
}

function initBrushSizes() {
  document.querySelectorAll('.brush-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!isDrawer) return;
      currentSize = parseInt(btn.dataset.size);
      document.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

function setDrawerTools(on) {
  document.querySelectorAll('.color-swatch').forEach(el => el.classList.toggle('disabled', !on));
  document.querySelectorAll('.brush-btn').forEach(el => el.classList.toggle('disabled', !on));
  $('btn-undo').disabled = !on;
  $('btn-clear').disabled = !on;
  $('answer-input').disabled = on;
  $('btn-answer').disabled = on;
}

// ── 좌표 변환 (CSS 픽셀 → 내부 캔버스 좌표) ──
// canvas.width = CANVAS_W 고정이므로 CSS 표시 크기와 비율로 변환
function getCanvasPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (CANVAS_W / rect.width),
    y: (e.clientY - rect.top)  * (CANVAS_H / rect.height),
  };
}

// ── 드로잉 이벤트 ──
function onMouseDown(e) {
  if (!isDrawer) return;
  const pc = playerCanvases[socket.id];
  if (!pc) return;
  saveHistory(socket.id);
  drawing = true;
  const pos = getCanvasPos(e, pc.canvas);
  pc.ctx.beginPath();
  pc.ctx.moveTo(pos.x, pos.y);
  socket.emit('draw:data', {
    code: myRoom.code,
    data: { type: 'start', x: pos.x, y: pos.y, color: currentColor, size: currentSize },
  });
}

function onMouseMove(e) {
  if (!isDrawer || !drawing) return;
  const pc = playerCanvases[socket.id];
  if (!pc) return;
  const pos = getCanvasPos(e, pc.canvas);
  applyStroke(pc.ctx, pos.x, pos.y, currentColor, currentSize);
  socket.emit('draw:data', {
    code: myRoom.code,
    data: { type: 'move', x: pos.x, y: pos.y, color: currentColor, size: currentSize },
  });
}

function onMouseUp() {
  if (!drawing) return;
  drawing = false;
  const pc = playerCanvases[socket.id];
  if (pc) pc.ctx.beginPath();
  socket.emit('draw:data', { code: myRoom.code, data: { type: 'end' } });
}

function applyStroke(ctx, x, y, color, size) {
  ctx.lineTo(x, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// ── 원격 드로잉 수신 ──
// 서버가 drawerId를 붙여 브로드캐스트함
// x, y 는 이미 CANVAS_W×CANVAS_H 좌표 → 그대로 사용
const remoteCtx = {}; // drawerId -> { started: bool }

socket.on('draw:data', ({ type, x, y, color, size, drawerId }) => {
  const pc = playerCanvases[drawerId];
  if (!pc) return;

  if (!remoteCtx[drawerId]) remoteCtx[drawerId] = { started: false };
  const rs = remoteCtx[drawerId];

  if (type === 'start') {
    pc.ctx.beginPath();
    pc.ctx.moveTo(x, y);
    rs.started = true;
  } else if (type === 'move' && rs.started) {
    applyStroke(pc.ctx, x, y, color, size);
  } else if (type === 'end') {
    pc.ctx.beginPath();
    rs.started = false;
  }
});

// ── Undo ──
function saveHistory(playerId) {
  const pc = playerCanvases[playerId];
  if (!pc) return;
  if (pc.history.length >= 20) pc.history.shift();
  pc.history.push(pc.ctx.getImageData(0, 0, CANVAS_W, CANVAS_H));
}

function doUndo() {
  if (!isDrawer) return;
  const pc = playerCanvases[socket.id];
  if (!pc || pc.history.length === 0) return;
  pc.ctx.putImageData(pc.history.pop(), 0, 0);
  socket.emit('draw:undo', { code: myRoom.code, imageData: pc.canvas.toDataURL() });
}

socket.on('draw:undo', ({ drawerId, imageData }) => {
  const pc = playerCanvases[drawerId];
  if (!pc) return;
  const img = new Image();
  img.onload = () => { pc.ctx.clearRect(0, 0, CANVAS_W, CANVAS_H); pc.ctx.drawImage(img, 0, 0); };
  img.src = imageData;
});

// ── 캔버스 지우기 ──
function clearCanvasById(playerId) {
  const pc = playerCanvases[playerId];
  if (!pc) return;
  pc.ctx.fillStyle = '#ffffff';
  pc.ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

socket.on('draw:clear', ({ drawerId }) => clearCanvasById(drawerId));

// ── 패널 상태 배지 ──
function setPanelStatus(playerId, text, cls) {
  const header = $(`panelh-${playerId}`);
  if (!header) return;
  header.querySelectorAll('.ph-status').forEach(el => el.remove());
  if (text) {
    const span = document.createElement('span');
    span.className = `ph-status ${cls || ''}`;
    span.textContent = text;
    header.querySelector('.ph-nick').after(span);
  }
}

// ── 소켓 이벤트 ──
function bindSocket() {

  socket.on('room:update', ({ room }) => {
    myRoom = room;
    isHost = room.hostId === socket.id;
    if (screens.waiting.style.display !== 'none') updateWaiting(room);
  });

  socket.on('room:restart', ({ room }) => {
    myRoom = room; isHost = room.hostId === socket.id;
    clearInterval(timerInterval);
    Object.keys(playerCanvases).forEach(k => delete playerCanvases[k]);
    enterWaiting(room);
  });

  socket.on('turn:start', ({ drawerNick, drawerId, round, totalRounds, timeLimit, players }) => {
    currentDrawerId = drawerId;
    isDrawer = (drawerId === socket.id);

    if (screens.game.style.display === 'none') {
      // 첫 진입
      enterGame(players);
    } else {
      // 다음 턴: 드로어 캔버스만 초기화
      clearCanvasById(drawerId);
      if (playerCanvases[drawerId]) playerCanvases[drawerId].history = [];
    }

    // 상태바
    $('st-round').textContent = `${round} / ${totalRounds}`;
    $('st-drawer').textContent = drawerNick;
    updateScoreBoard(players);

    // 단어 배지
    const badge = $('word-badge');
    badge.textContent = '???';
    badge.className = 'word-badge hidden';

    // 도구 활성화
    setDrawerTools(isDrawer);

    // 내 캔버스 커서
    const myPc = playerCanvases[socket.id];
    if (myPc) myPc.canvas.style.cursor = isDrawer ? 'crosshair' : 'default';

    // 패널 강조
    document.querySelectorAll('.player-panel').forEach(p => p.classList.remove('active-drawer'));
    const dp = $(`panel-${drawerId}`);
    if (dp) dp.classList.add('active-drawer');

    // 패널 상태 초기화
    players.forEach(p => setPanelStatus(p.id, null));
    setPanelStatus(drawerId, '그리는 중', 'drawing');

    startTimer(timeLimit);
    showOverlay(isDrawer ? '당신 차례입니다!' : `${drawerNick}님이 그립니다`, '3초 후 시작');
  });

  socket.on('word:assign', ({ word }) => {
    const badge = $('word-badge');
    badge.textContent = `단어: ${word}`;
    badge.className = 'word-badge';
  });

  socket.on('answer:correct', ({ nick, word, players }) => {
    addChat(`<span class="msg-correct">✔ ${esc(nick)}님 정답! [${esc(word)}]</span>`);
    updateScoreBoard(players);
    // 정답자 패널 표시
    const p = players.find(pl => pl.nick === nick);
    if (p) setPanelStatus(p.id, '정답!', 'correct');
    // 내가 정답 맞춘 경우
    if (nick === myNick) {
      $('answer-input').disabled = true;
      $('btn-answer').disabled = true;
    }
  });

  socket.on('turn:end', ({ word, players, allCorrect }) => {
    clearInterval(timerInterval);
    updateScoreBoard(players);
    const badge = $('word-badge');
    badge.textContent = `정답: ${word}`;
    badge.className = 'word-badge';
    addChat(`<span class="msg-system">--- 정답: ${esc(word)} ---</span>`);
    showOverlay(allCorrect ? '모두 정답!' : '시간 종료', `정답: ${word}`);
  });

  socket.on('game:end', ({ players }) => {
    clearInterval(timerInterval);
    showResult(players);
  });

  socket.on('chat:message', ({ nick, message }) => {
    addChat(`<span class="msg-nick">${esc(nick)}</span>: ${esc(message)}`);
  });
}

// ── 오버레이 ──
function showOverlay(msg, sub) {
  $('turn-msg').textContent = msg;
  $('turn-sub').textContent = sub;
  $('turn-overlay').classList.add('show');
  setTimeout(() => $('turn-overlay').classList.remove('show'), 2500);
}

// ── 결과 화면 ──
function showResult(players) {
  showScreen('result');
  const tbody = $('result-body');
  tbody.innerHTML = '';
  players.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}위</td><td>${esc(p.nick)}</td><td>${p.score}점</td>`;
    tbody.appendChild(tr);
  });
  $('btn-restart').style.display = isHost ? '' : 'none';
}

// ── XSS 방지 ──
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
