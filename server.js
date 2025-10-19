const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = process.env.PORT || 3050;

// Serve static files
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store active rooms and users
// rooms: Map<string, { users: Set<string>, activeSharer: string | null }>
const rooms = new Map();
const ROOM_ID_REGEX = /^[A-Za-z0-9_-]{3,32}$/;

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      users: new Set(),
      activeSharer: null
    };
    rooms.set(roomId, room);
  }
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room
  socket.on('join-room', (roomId) => {
    if (typeof roomId !== 'string') {
      socket.emit('room-error', 'Room ID must be a string.');
      return;
    }

    const trimmedRoomId = roomId.trim();

    if (!ROOM_ID_REGEX.test(trimmedRoomId)) {
      socket.emit('room-error', 'Invalid room ID. Use 3-32 letters, numbers, hyphen or underscore.');
      return;
    }

    socket.join(trimmedRoomId);

    const room = getOrCreateRoom(trimmedRoomId);
    room.users.add(socket.id);

    // Notify others in the room
    socket.to(trimmedRoomId).emit('user-joined', socket.id);

    // Send list of existing users to the new user
    const existingUsers = Array.from(room.users).filter(id => id !== socket.id);
    socket.emit('existing-users', existingUsers);
    socket.emit('room-joined', trimmedRoomId);
    if (room.activeSharer && room.activeSharer !== socket.id) {
      socket.emit('current-sharer', room.activeSharer);
    }

    console.log(`User ${socket.id} joined room ${trimmedRoomId}`);
  });

  socket.on('request-share', (payload, callback) => {
    if (!payload || typeof payload !== 'object') {
      if (typeof callback === 'function') {
        callback({ ok: false, reason: 'Invalid payload.' });
      }
      return;
    }

    const { roomId } = payload;

    if (typeof roomId !== 'string') {
      if (typeof callback === 'function') {
        callback({ ok: false, reason: 'Room ID must be a string.' });
      }
      return;
    }

    const trimmedRoomId = roomId.trim();
    if (!ROOM_ID_REGEX.test(trimmedRoomId)) {
      if (typeof callback === 'function') {
        callback({ ok: false, reason: 'Invalid room ID.' });
      }
      return;
    }

    const room = getRoom(trimmedRoomId);

    if (!room || !room.users.has(socket.id)) {
      if (typeof callback === 'function') {
        callback({ ok: false, reason: 'Join the room before sharing.' });
      }
      return;
    }

    if (room.activeSharer && room.activeSharer !== socket.id) {
      if (typeof callback === 'function') {
        callback({ ok: false, reason: 'Another user is currently sharing.' });
      }
      return;
    }

    room.activeSharer = socket.id;
    socket.to(trimmedRoomId).emit('user-started-sharing', socket.id);

    if (typeof callback === 'function') {
      callback({ ok: true });
    }
  });

  socket.on('cancel-share', (roomId) => {
    if (typeof roomId !== 'string') {
      return;
    }

    const trimmedRoomId = roomId.trim();
    if (!ROOM_ID_REGEX.test(trimmedRoomId)) {
      return;
    }

    const room = getRoom(trimmedRoomId);
    if (!room || !room.users.has(socket.id)) {
      return;
    }

    if (room.activeSharer === socket.id) {
      room.activeSharer = null;
      socket.to(trimmedRoomId).emit('user-stopped-sharing', socket.id);
    }
  });

  socket.on('stop-sharing', (roomId) => {
    if (typeof roomId !== 'string') {
      return;
    }

    const trimmedRoomId = roomId.trim();
    if (!ROOM_ID_REGEX.test(trimmedRoomId)) {
      return;
    }

    const room = getRoom(trimmedRoomId);

    if (!room || room.activeSharer !== socket.id) {
      return;
    }

    room.activeSharer = null;
    socket.to(trimmedRoomId).emit('user-stopped-sharing', socket.id);
  });

  socket.on('offer', (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const { roomId, targetId, description } = payload;
    if (typeof roomId !== 'string' || typeof targetId !== 'string' || !description) {
      return;
    }

    const trimmedRoomId = roomId.trim();
    if (!ROOM_ID_REGEX.test(trimmedRoomId)) {
      return;
    }

    const room = getRoom(trimmedRoomId);
    if (!room || room.activeSharer !== socket.id || !room.users.has(targetId)) {
      return;
    }

    socket.to(targetId).emit('offer', {
      userId: socket.id,
      description
    });
  });

  socket.on('answer', (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const { roomId, targetId, description } = payload;
    if (typeof roomId !== 'string' || typeof targetId !== 'string' || !description) {
      return;
    }

    const trimmedRoomId = roomId.trim();
    if (!ROOM_ID_REGEX.test(trimmedRoomId)) {
      return;
    }

    const room = getRoom(trimmedRoomId);
    if (!room || !room.users.has(socket.id) || !room.users.has(targetId)) {
      return;
    }

    socket.to(targetId).emit('answer', {
      userId: socket.id,
      description
    });
  });

  socket.on('ice-candidate', (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const { roomId, targetId, candidate } = payload;
    if (typeof roomId !== 'string' || typeof targetId !== 'string' || !candidate) {
      return;
    }

    const trimmedRoomId = roomId.trim();
    if (!ROOM_ID_REGEX.test(trimmedRoomId)) {
      return;
    }

    const room = getRoom(trimmedRoomId);
    if (!room || !room.users.has(socket.id) || !room.users.has(targetId)) {
      return;
    }

    socket.to(targetId).emit('ice-candidate', {
      userId: socket.id,
      candidate
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    // Remove user from all rooms
    rooms.forEach((room, roomId) => {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        socket.to(roomId).emit('user-left', socket.id);

        if (room.activeSharer === socket.id) {
          room.activeSharer = null;
          socket.to(roomId).emit('user-stopped-sharing', socket.id);
        }

        // Clean up empty rooms
        if (room.users.size === 0) {
          rooms.delete(roomId);
        }
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`\nTo use with cloudflared tunnel, run:`);
  console.log(`cloudflared tunnel --url http://localhost:${PORT}`);
});
