import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const WIDTH=100,HEIGHT=50,MINE_COUNT=750,CELL_COUNT=WIDTH*HEIGHT;
const rooms=new Map(),clients=new Map();
const PORT=Number(process.env.PORT||3000);
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))};
const read=req=>new Promise((resolve,reject)=>{let value='';req.on('data',c=>value+=c);req.on('end',()=>{try{resolve(JSON.parse(value||'{}'))}catch(e){reject(e)}})});
const roomCode=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
const clientIp=req=>String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();

function makeMines(seed){const result=new Set();let round=0;while(result.size<MINE_COUNT){const bytes=crypto.createHash('sha256').update(`${seed}:${round++}`).digest();for(let i=0;i<bytes.length-1&&result.size<MINE_COUNT;i+=2)result.add(((bytes[i]<<8)|bytes[i+1])%CELL_COUNT)}return [...result]}
function makeCounts(mines){const mineSet=new Set(mines),counts=new Uint8Array(CELL_COUNT);for(let cell=0;cell<CELL_COUNT;cell++){if(mineSet.has(cell))continue;const row=Math.floor(cell/WIDTH),col=cell%WIDTH;for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){const r=row+y,c=col+x;if(r>=0&&r<HEIGHT&&c>=0&&c<WIDTH&&mineSet.has(r*WIDTH+c))counts[cell]++}}return [...counts]}
function reset(room){room.round=(room.round||0)+1;room.mines=makeMines(`${room.id}:${room.round}`);room.mineSet=new Set(room.mines);room.counts=makeCounts(room.mines);room.opened=[];room.openSet=new Set();room.flags=[];room.flagSet=new Set();room.status='waiting';room.startedAt=null;room.endedAt=null;room.lastAction='新一局已准备好'}
function snapshot(room){return{type:'snapshot',id:room.id,players:room.players,round:room.round,opened:room.opened,flags:room.flags,status:room.status,startedAt:room.startedAt,endedAt:room.endedAt,lastAction:room.lastAction,counts:room.status==='waiting'?undefined:room.counts,width:WIDTH,height:HEIGHT,mineCount:MINE_COUNT}}
function emit(id,message){const data=`data: ${JSON.stringify(message)}\n\n`;for(const res of clients.get(id)||[])res.write(data)}
function reveal(room,start){const added=[];if(room.mineSet.has(start)){room.opened.push(start);room.openSet.add(start);added.push(start);room.status='lost';room.endedAt=Date.now();return added}const pending=[start],queued=new Set([start]);while(pending.length){const cell=pending.pop();if(room.openSet.has(cell)||room.flagSet.has(cell))continue;room.openSet.add(cell);room.opened.push(cell);added.push(cell);if(room.counts[cell]===0){const row=Math.floor(cell/WIDTH),col=cell%WIDTH;for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){const r=row+y,c=col+x,next=r*WIDTH+c;if(r>=0&&r<HEIGHT&&c>=0&&c<WIDTH&&!queued.has(next)){queued.add(next);pending.push(next)}}}}if(room.opened.length===CELL_COUNT-MINE_COUNT){room.status='won';room.endedAt=Date.now()}return added}

http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='POST'&&url.pathname==='/api/rooms'){const input=await read(req);let id=roomCode();while(rooms.has(id))id=roomCode();const player={id:crypto.randomUUID(),name:(input.name||'Player 1').slice(0,16),color:'#6ee7b7'},room={id,players:[player],playerIps:[clientIp(req)],round:0};reset(room);rooms.set(id,room);return send(res,200,{room:snapshot(room),playerId:player.id})}
 const match=url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})(?:\/(join|action|events))?$/);
 if(match){const room=rooms.get(match[1]);if(!room)return send(res,404,{error:'房间不存在'});
  if(req.method==='GET'&&match[2]==='events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive','x-accel-buffering':'no'});res.write(`data: ${JSON.stringify(snapshot(room))}\n\n`);if(!clients.has(room.id))clients.set(room.id,new Set());clients.get(room.id).add(res);const keep=setInterval(()=>res.write(': keepalive\n\n'),20000);req.on('close',()=>{clearInterval(keep);clients.get(room.id)?.delete(res)});return}
  if(req.method==='POST'&&match[2]==='join'){const input=await read(req),ip=clientIp(req);if(room.playerIps.includes(ip))return send(res,409,{error:'同一网络地址在一个房间中只能加入一名玩家'});if(room.players.length>=4)return send(res,409,{error:'房间已满'});const player={id:crypto.randomUUID(),name:(input.name||`Player ${room.players.length+1}`).slice(0,16),color:['#60a5fa','#fbbf24','#f472b6'][room.players.length-1]};room.players.push(player);room.playerIps.push(ip);room.lastAction=`${player.name} 加入了房间`;emit(room.id,{type:'patch',players:room.players,lastAction:room.lastAction});return send(res,200,{room:snapshot(room),playerId:player.id})}
  if(req.method==='POST'&&match[2]==='action'){const input=await read(req),player=room.players.find(p=>p.id===input.playerId);if(!player)return send(res,403,{error:'玩家身份无效'});let patch={type:'patch'};
   if(input.type==='reset'&&(room.status==='won'||room.status==='lost')){reset(room);room.lastAction=`${player.name} 开始了新一局`;const snap=snapshot(room);emit(room.id,snap);return send(res,200,snap)}
   if(input.type==='start'&&room.status==='waiting'){room.status='playing';room.startedAt=Date.now();room.lastAction=`${player.name} 开始了游戏`;patch={type:'patch',status:room.status,startedAt:room.startedAt,counts:room.counts,lastAction:room.lastAction}}
   else if(room.status==='playing'&&Number.isInteger(input.cell)&&input.cell>=0&&input.cell<CELL_COUNT){
    if(input.type==='flag'&&!room.openSet.has(input.cell)){const flagged=!room.flagSet.has(input.cell);if(flagged&&room.flags.length>=MINE_COUNT)return send(res,200,{type:'patch'});if(flagged){room.flagSet.add(input.cell);room.flags.push(input.cell)}else{room.flagSet.delete(input.cell);room.flags=room.flags.filter(c=>c!==input.cell)}room.lastAction=`${player.name} 更新了标记`;patch={type:'patch',flagCell:input.cell,flagged,flagsLeft:MINE_COUNT-room.flags.length,lastAction:room.lastAction}}
    else if(input.type==='open'&&!room.flagSet.has(input.cell)&&!room.openSet.has(input.cell)){const openedAdded=reveal(room,input.cell);room.lastAction=`${player.name} 打开了格子`;patch={type:'patch',openedAdded,status:room.status,endedAt:room.endedAt,lastAction:room.lastAction}}
   }
   emit(room.id,patch);return send(res,200,patch)
  }
 }
 const file=url.pathname==='/'?'index.html':url.pathname.slice(1),target=path.join(root,'public',file);if(!target.startsWith(path.join(root,'public'))||!fs.existsSync(target)){res.writeHead(404);return res.end('Not found')}const ext=path.extname(target);res.writeHead(200,{'content-type':ext==='.css'?'text/css; charset=utf-8':ext==='.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':ext==='.html'?'no-cache':'public, max-age=300'});fs.createReadStream(target).pipe(res)
}).listen(PORT,'0.0.0.0',()=>console.log(`Minesweeper listening on ${PORT}`));
