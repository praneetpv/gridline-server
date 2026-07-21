// WebSocket layer (spec §3). One-way by design: the server broadcasts "this happened" events;
// it never accepts commands over the socket (every mutation goes through REST — see the route
// files). This keeps the concurrency/versioning model simple, since there's only ever one path
// a write can take.
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: (process.env.CORS_ORIGIN || '*').split(','), credentials: true },
  });

  // Every socket must present the same JWT used for REST auth (as an auth token on connect).
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('missing auth token'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = payload;
      next();
    } catch (err) {
      next(new Error('invalid auth token'));
    }
  });

  io.on('connection', (socket) => {
    // Everyone joins the shared "network" room for this scaffold — a control-center dashboard
    // and a field technician both currently see every event. To shard by section/feeder as the
    // deployment grows (so a technician's phone isn't receiving updates for districts they don't
    // work in), join `network:section:<id>` rooms here based on socket.user.assignedSectionIds
    // and have broadcastEvent() below target the relevant room(s) instead of the global one.
    socket.join('network');

    socket.on('disconnect', () => {
      // Nothing to clean up beyond socket.io's own room bookkeeping — sockets carry no other
      // server-side state since all state mutation happens over REST, not the socket.
    });
  });

  return io;
}

/** Sends one realtime event (see utils/audit.js toEventPayload) to every subscribed client. */
function broadcastEvent(payload) {
  if (!io) return;
  io.to('network').emit('network:event', payload);
}

module.exports = { initSocket, broadcastEvent };
