let room, playerId, events;
const $ = selector => document.querySelector(selector);
const api = (url, options = {}) => fetch(url, { headers: { 'content-type': 'application/json' }, ...options }).then(async response => {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
});
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').className = 'show';
  setTimeout(() => $('#toast').className = '', 1800);
}
function enter(data) {
  room = data.room;
  playerId = data.playerId;
  history.replaceState(null, '', `?room=${room.id}`);
  $('#lobby').hidden = true;
  $('#game').hidden = false;
  events?.close();
  events = new EventSource(`/api/rooms/${room.id}/events`);
  events.onmessage = event => { room = JSON.parse(event.data); render(); };
  render();
}
function adjacentMines(cell) {
  let total = 0;
  const row = Math.floor(cell / 16), col = cell % 16;
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    const r = row + y, c = col + x;
    if (r >= 0 && r < 16 && c >= 0 && c < 16 && room.mines?.includes(r * 16 + c)) total++;
  }
  return total;
}
function render() {
  $('#code').textContent = room.id;
  $('#left').textContent = 40 - room.flags.length;
  $('#players').innerHTML = room.players.map(player =>
    `<div class="player"><i style="background:${player.color}"></i><b>${player.name}</b><span>${player.id === playerId ? '你' : '在线'}</span></div>`
  ).join('');
  $('#activity').textContent = room.lastAction;
  $('#start').hidden = room.status !== 'waiting';
  $('#start').disabled = room.players.length < 2;
  $('#start').textContent = room.players.length < 2 ? '等待队友加入' : '开始游戏';
  $('#status').textContent = { waiting: '等待队友', playing: '雷区进行中', won: '任务成功！', lost: '踩雷了，任务失败' }[room.status];
  let cells = '';
  for (let cell = 0; cell < 256; cell++) {
    const open = room.opened.includes(cell), mine = room.mines?.includes(cell), flag = room.flags.includes(cell);
    const value = open ? (mine ? '✹' : adjacentMines(cell) || '') : flag ? '⚑' : (room.status !== 'playing' && room.status !== 'waiting' && mine ? '✹' : '');
    cells += `<button class="cell ${open ? 'open' : ''} ${mine && open ? 'boom' : ''} n${value}" data-k="${cell}" aria-label="格子 ${cell + 1}">${value}</button>`;
  }
  $('#board').innerHTML = cells;
}
async function act(type, cell) {
  try {
    room = await api(`/api/rooms/${room.id}/action`, { method: 'POST', body: JSON.stringify({ playerId, type, cell }) });
    render();
  } catch (error) { toast(error.message); }
}
$('#create').onclick = async () => {
  try { enter(await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: $('#name').value }) })); }
  catch (error) { toast(error.message); }
};
$('#join').onclick = async () => {
  const id = $('#roomCode').value.trim().toUpperCase();
  try { enter(await api(`/api/rooms/${id}/join`, { method: 'POST', body: JSON.stringify({ name: $('#name').value }) })); }
  catch (error) { toast(error.message); }
};
$('#start').onclick = () => act('start');
$('#copy').onclick = () => navigator.clipboard.writeText(location.href).then(() => toast('邀请链接已复制'));
$('#board').onclick = event => { const cell = event.target.closest('.cell'); if (cell) act('open', Number(cell.dataset.k)); };
$('#board').oncontextmenu = event => { event.preventDefault(); const cell = event.target.closest('.cell'); if (cell) act('flag', Number(cell.dataset.k)); };
setInterval(() => {
  if (!room) return;
  const seconds = room.startedAt ? Math.floor(((room.endedAt || Date.now()) - room.startedAt) / 1000) : 0;
  $('#timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}, 500);
const invitedRoom = new URLSearchParams(location.search).get('room')?.toUpperCase();
if (invitedRoom) {
  $('#roomCode').value = invitedRoom;
  toast('输入昵称后加入好友房间');
}
