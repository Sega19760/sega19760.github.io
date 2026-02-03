import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3000);

const rooms = new Map(); // roomCode -> { code, host, hostInfo, clients: Map, counter, meta }

function normalizeCapacity(value){
  const num = Number.parseInt(value, 10);
  if(Number.isFinite(num)){
    return Math.min(16, Math.max(1, num));
  }
  return 10;
}

function sanitizeLobbyName(value, fallback){
  if(typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, 60);
  return trimmed || fallback;
}

function getRoom(code){
  if(!rooms.has(code)){
    rooms.set(code, { code, host: null, hostInfo: null, clients: new Map(), counter: 1, meta: { name: code, capacity: 10 } });
  }
  return rooms.get(code);
}

function send(ws, data){
  if(!ws || ws.readyState !== WebSocket.OPEN) return;
  try{
    ws.send(JSON.stringify(data));
  }catch(err){
    console.error('Failed to send message', err);
  }
}

function cleanupConnection(ws){
  const meta = ws.meta;
  if(!meta) return;
  const room = rooms.get(meta.room);
  if(!room) return;

  if(meta.role === 'host'){
    room.host = null;
    room.hostInfo = null;
    const clientEntries = Array.from(room.clients.entries());
    if(clientEntries.length === 0){
      room.meta = { name: room.code, capacity: room.meta?.capacity || 10 };
    } else {
      clientEntries.sort((a, b)=>{
        const aOrder = a[1].joinOrder ?? Number.MAX_SAFE_INTEGER;
        const bOrder = b[1].joinOrder ?? Number.MAX_SAFE_INTEGER;
        if(aOrder !== bOrder) return aOrder - bOrder;
        return a[0].localeCompare(b[0]);
      });
      const [nextId, nextClient] = clientEntries.shift();
      room.clients.delete(nextId);
      room.host = nextClient.socket;
      room.hostInfo = { name: nextClient.name || 'Host', playerId: nextClient.playerId || 'host' };
      if(room.host){
        room.host.meta = {
          room: meta.room,
          role: 'host',
          peerId: 'host',
          name: room.hostInfo.name,
          playerId: room.hostInfo.playerId,
          joinOrder: nextClient.joinOrder
        };
        send(room.host, {
          type: 'host-transfer',
          becomeHost: true,
          playerId: room.hostInfo.playerId,
          name: room.hostInfo.name,
          lobbyName: room.meta?.name,
          options: room.meta?.options || null,
          meta: room.meta
        });
        clientEntries.forEach(([peerId, client])=>{
          send(client.socket, {
            type: 'host-transfer',
            playerId: room.hostInfo.playerId,
            name: room.hostInfo.name,
            lobbyName: room.meta?.name,
            options: room.meta?.options || null
          });
          if(room.host){
            send(room.host, {
              type: 'join-request',
              peerId,
              name: client.name,
              playerId: client.playerId
            });
          }
        });
      }
      return;
    }
  } else if(meta.role === 'join'){
    room.clients.delete(meta.peerId);
    if(room.host){
      send(room.host, { type:'peer-left', peerId: meta.peerId });
    }
  }

  if(!room.host && room.clients.size === 0){
    rooms.delete(meta.room);
  }
}

function buildRoomSummary(room){
  const players = [];
  if(room.hostInfo){
    players.push({ id: room.hostInfo.playerId || 'host', name: room.hostInfo.name || 'Host' });
  }
  room.clients.forEach((client, id)=>{
    players.push({ id: client.playerId || id, name: client.name || id });
  });
  return {
    code: room.code,
    name: room.meta?.name || room.code,
    capacity: room.meta?.capacity || 10,
    players
  };
}

const server = createServer((req, res)=>{
  // Allow the ws upgrade handshake to be handled exclusively by the ws server.
  const isWebSocketUpgrade = req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket';
  if(isWebSocketUpgrade){
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){
    res.writeHead(204);
    res.end();
    return;
  }
  if(req.method === 'GET'){
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if(parts[0] === 'rooms'){
      if(parts.length === 1){
        const payload = Array.from(rooms.values()).map(buildRoomSummary);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rooms: payload }));
        return;
      }
      if(parts.length === 2){
        const room = rooms.get(parts[1]);
        if(!room){
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Room not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ room: buildRoomSummary(room) }));
        return;
      }
    }
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocketServer({ server });
console.log(`Signaling server listening on ws://0.0.0.0:${PORT}`);

wss.on('connection', ws=>{
  ws.meta = null;
  ws.isAlive = true;

  ws.on('pong', ()=>{
    ws.isAlive = true;
  });

  ws.on('message', raw=>{
    let msg;
    try{
      msg = JSON.parse(raw.toString());
    }catch(err){
      send(ws, { type:'error', message:'Invalid JSON' });
      return;
    }

    if(msg.type === 'ping'){
      ws.isAlive = true;
      send(ws, { type: 'pong', now: Date.now() });
      return;
    }

    if(msg.type === 'hello'){
      const roomCode = String(msg.room || 'default');
      const role = msg.role === 'host' ? 'host' : 'join';
      const room = getRoom(roomCode);

      if(role === 'host'){
        if(room.host && room.host !== ws){
          send(ws, { type:'error', message:'Host already connected for this room.' });
          return;
        }
        room.host = ws;
        room.hostInfo = { name: msg.name || 'Host', playerId: msg.playerId || 'host' };
        room.meta = {
          name: sanitizeLobbyName(msg.lobbyName, room.meta?.name || room.code),
          capacity: normalizeCapacity(msg.capacity ?? room.meta?.capacity ?? 10)
        };
        ws.meta = { room: roomCode, role:'host', peerId:'host', name: room.hostInfo.name, playerId: room.hostInfo.playerId };
        send(ws, { type:'welcome', id:'host', meta: room.meta });
        return;
      }

      if(!room.host){
        send(ws, { type:'error', message:'No host present in this room.' });
        return;
      }

      const joinOrder = room.counter++;
      const peerId = `peer-${joinOrder}`;
      ws.meta = {
        room: roomCode,
        role:'join',
        peerId,
        name: msg.name || peerId,
        playerId: msg.playerId || peerId,
        joinOrder
      };
      room.clients.set(peerId, { socket: ws, name: ws.meta.name, playerId: ws.meta.playerId, joinOrder });
      send(ws, { type:'welcome', id: peerId, meta: room.meta });
      send(room.host, { type:'join-request', peerId, name: ws.meta.name, playerId: ws.meta.playerId });
      return;
    }

    const meta = ws.meta;
    if(!meta){
      send(ws, { type:'error', message:'Identify with a hello message first.' });
      return;
    }

    const room = rooms.get(meta.room);
    if(!room){
      send(ws, { type:'error', message:'Room no longer exists.' });
      return;
    }

    if(msg.type === 'offer' && meta.role === 'host'){
      const target = room.clients.get(msg.target);
      if(!target){
        send(ws, { type:'error', message:`Peer ${msg.target} not found.` });
        return;
      }
      send(target.socket, { type:'offer', peerId:'host', name: room.hostInfo?.name, playerId: room.hostInfo?.playerId, sdp: msg.sdp });
      return;
    }

    if(msg.type === 'answer' && meta.role === 'join'){
      if(room.host){
        send(room.host, { type:'answer', peerId: meta.peerId, sdp: msg.sdp });
      }
      return;
    }

    if(msg.type === 'ice'){
      if(meta.role === 'host'){
        const target = room.clients.get(msg.target);
        if(target){
          send(target.socket, { type:'ice', peerId:'host', candidate: msg.candidate });
        }
      } else if(meta.role === 'join' && room.host){
        send(room.host, { type:'ice', peerId: meta.peerId, candidate: msg.candidate });
      }
      return;
    }

    if(msg.type === 'peer-left' && meta.role === 'join'){
      cleanupConnection(ws);
      return;
    }

    send(ws, { type:'error', message:`Unhandled message type: ${msg.type}` });
  });

  ws.on('close', ()=>{
    cleanupConnection(ws);
  });

  ws.on('error', err=>{
    console.error('WebSocket error', err);
    cleanupConnection(ws);
  });
});

server.listen(PORT, ()=>{
  console.log(`HTTP lobby listing available at http://0.0.0.0:${PORT}/rooms`);
});

const heartbeatInterval = setInterval(()=>{
  wss.clients.forEach(client=>{
    if(client.isAlive === false){
      try{ client.terminate(); }
      catch(e){ console.error('Failed to terminate stale client', e); }
      return;
    }
    client.isAlive = false;
    try{ client.ping(); }
    catch(e){
      try{ client.terminate(); }
      catch(inner){ console.error('Failed to terminate client after ping error', inner); }
    }
  });
}, 15000);

wss.on('close', ()=> clearInterval(heartbeatInterval));
