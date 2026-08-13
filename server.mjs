import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const rooms = new Map();
const clients = new Map();
const PORT = Number(process.env.PORT || 3000);

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let value = '';
    req.on('data', chunk => value += chunk);
    req.on('end', () => { try { resolve(JSON.parse(value || '{}')); } catch (error) { reject(error); } });
  });
}
function roomCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function publicRoom(room) { return { ...room, mines: room.status === 'playing' ? undefined : room.mines }; }
function broadcast(id) {
  const payload = `data: ${JSON.stringify(publicRoom(rooms.get(id)))}\n\n`;
  for (const response of clients.get(id) || []) response.write(payload);
}
function makeMines(seed) {
  const result = [];
  let round = 0;
  while (result.length < 40) {
    const bytes = crypto.createHash('sha256').update(seed + ':' + round++).digest();
    for (const byte of bytes) {
      const cell = byte % 256;
      if (!result.includes(cell)) result.push(cell);
      if (result.length === 40) break;
    }
  }
  return result;
}
function reveal(room, start) {
  if (room.mines.includes(start)) {
    room.opened.push(start);
    room.status = 'lost';
    room.endedAt = Date.now();
    return;
  }
  const pending = [start];
  const seen = new Set(room.opened);
  while (pending.length) {
    const cell = pending.pop();
    if (seen.has(cell) || room.flags.includes(cell)) continue;
    seen.add(cell);
    const row = Math.floor(cell / 16);
    const col = cell % 16;
    let count = 0;
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      const r = row + y, c = col + x;
      if (r >= 0 && r < 16 && c >= 0 && c < 16 && room.mines.includes(r * 16 + c)) count++;
    }
    if (!count) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      const r = row + y, c = col + x;
      if (r >= 0 && r < 16 && c >= 0 && c < 16) pending.push(r * 16 + c);
    }
  }
  room.opened = [...seen];
  if (room.opened.length === 216) {
    room.status = 'won';
    room.endedAt = Date.now();
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const input = await readBody(req);
    let id = roomCode();
    while (rooms.has(id)) id = roomCode();
    const player = { id: crypto.randomUUID(), name: (input.name || 'Player 1').slice(0, 16), color: '#6ee7b7' };
    rooms.set(id, { id, players: [player], mines: makeMines(id), opened: [], flags: [], status: 'waiting', createdAt: Date.now(), startedAt: null, endedAt: null, lastAction: 'Room created' });
    return sendJson(res, 200, { room: publicRoom(rooms.get(id)), playerId: player.id });
  }

  const match = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})(?:\/(join|action|events))?$/);
  if (match) {
    const room = rooms.get(match[1]);
    if (!room) return sendJson(res, 404, { error: 'Room not found' });
    if (req.method === 'GET' && match[2] === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(publicRoom(room))}\n\n`);
      if (!clients.has(room.id)) clients.set(room.id, new Set());
      clients.get(room.id).add(res);
      req.on('close', () => clients.get(room.id)?.delete(res));
      return;
    }
    if (req.method === 'GET' && !match[2]) return sendJson(res, 200, publicRoom(room));
    if (req.method === 'POST' && match[2] === 'join') {
      const input = await readBody(req);
      if (room.players.length >= 4) return sendJson(res, 409, { error: 'Room is full' });
      const player = { id: crypto.randomUUID(), name: (input.name || `Player ${room.players.length + 1}`).slice(0, 16), color: ['#60a5fa', '#fbbf24', '#f472b6'][room.players.length - 1] };
      room.players.push(player);
      room.lastAction = `${player.name} joined`;
      broadcast(room.id);
      return sendJson(res, 200, { room: publicRoom(room), playerId: player.id });
    }
    if (req.method === 'POST' && match[2] === 'action') {
      const input = await readBody(req);
      const player = room.players.find(item => item.id === input.playerId);
      if (!player) return sendJson(res, 403, { error: 'Invalid player' });
      if (input.type === 'start' && room.status === 'waiting') {
        room.status = 'playing'; room.startedAt = Date.now(); room.lastAction = `${player.name} started the game`;
      } else if (room.status === 'playing' && Number.isInteger(input.cell) && input.cell >= 0 && input.cell < 256) {
        if (input.type === 'flag' && !room.opened.includes(input.cell)) {
          room.flags = room.flags.includes(input.cell) ? room.flags.filter(cell => cell !== input.cell) : room.flags.length < 40 ? [...room.flags, input.cell] : room.flags;
          room.lastAction = `${player.name} updated a flag`;
        }
        if (input.type === 'open' && !room.flags.includes(input.cell) && !room.opened.includes(input.cell)) {
          reveal(room, input.cell); room.lastAction = `${player.name} opened a cell`;
        }
      }
      broadcast(room.id);
      return sendJson(res, 200, publicRoom(room));
    }
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const target = path.join(root, 'public', file);
  if (!target.startsWith(path.join(root, 'public')) || !fs.existsSync(target)) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(target);
  res.writeHead(200, { 'content-type': ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/html; charset=utf-8' });
  fs.createReadStream(target).pipe(res);
}).listen(PORT, '0.0.0.0', () => console.log(`Minesweeper server listening on port ${PORT}`));
