const { WebSocketServer } = require('ws');

let hostSocket = null;
const controllers = new Set();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToControllers(msg) {
  for (const ctrl of controllers) {
    send(ctrl, msg);
  }
}

/**
 * Attach WebSocket remote control to an existing HTTP server.
 * @param {import('http').Server} server
 */
function attachRemoteControl(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/remote')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    const role = new URL(req.url, 'http://localhost').searchParams.get('role') || 'controller';

    if (role === 'host') {
      // Only one host allowed at a time
      if (hostSocket && hostSocket.readyState === hostSocket.OPEN) {
        hostSocket.close(4000, 'replaced by new host');
      }
      hostSocket = ws;
      console.log('[remote] host connected');

      // Send current controller count to host
      send(ws, { type: 'info', payload: { controllers: controllers.size } });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          // host sends state_update → forward to all controllers
          if (msg.type === 'state_update') {
            broadcastToControllers(msg);
          }
        } catch (e) { /* ignore malformed */ }
      });

      ws.on('close', () => {
        if (hostSocket === ws) hostSocket = null;
        console.log('[remote] host disconnected');
        broadcastToControllers({ type: 'host_disconnected' });
      });

    } else {
      // controller
      controllers.add(ws);
      console.log(`[remote] controller connected (total: ${controllers.size})`);

      // If host is connected, ask it to send current state
      if (hostSocket && hostSocket.readyState === hostSocket.OPEN) {
        send(hostSocket, { type: 'request_state' });
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          // Forward control commands to host
          const controlTypes = ['play', 'pause', 'next', 'prev', 'seek', 'volume', 'play_song'];
          if (controlTypes.includes(msg.type) && hostSocket && hostSocket.readyState === hostSocket.OPEN) {
            send(hostSocket, msg);
          }
        } catch (e) { /* ignore malformed */ }
      });

      ws.on('close', () => {
        controllers.delete(ws);
        console.log(`[remote] controller disconnected (total: ${controllers.size})`);
      });
    }
  });

  console.log('[remote] WebSocket remote control ready at ws://.../remote');
}

module.exports = { attachRemoteControl };
