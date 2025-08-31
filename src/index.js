import express from 'express';
import http from 'http';
import { Server as socketIo } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import connectDB from './config/database.js';
import authRoutes from './routes/auth.js';
import roomRoutes from './routes/rooms.js';
import Room from './models/Room.js';
import User from './models/User.js';

dotenv.config();

connectDB();

const app = express();
const server = http.createServer(app);

const io = new socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);

const userSockets = new Map();

function addUserSocket(userId, socketId) {
  const set = userSockets.get(userId) || new Set();
  set.add(socketId);
  userSockets.set(userId, set);
}

function removeUserSocket(userId, socketId) {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) userSockets.delete(userId);
}

function getUserSocketIds(userId) {
  return userSockets.get(userId) || new Set();
}

function emitToUserInSameRoom(userId, roomId, event, payload) {
  const targetSocketIds = Array.from(getUserSocketIds(userId));
  if (targetSocketIds.length === 0) return 0;
  let count = 0;
  for (const sid of targetSocketIds) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.roomId === roomId) {
      s.emit(event, payload);
      count++;
    }
  }
  return count;
}

/**
 * Build canonical payloads used for room events
 */
function buildParticipantsPayload(room) {
  return room.participants.map((p) => ({
    user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
    joinedAt: p.joinedAt,
    isHost: p.isHost,
    isActive: p.isActive,
  }));
}

function buildRoomInfoPayload(room) {
  return {
    id: room._id,
    name: room.name,
    host: room.host ? { id: room.host._id, name: room.host.name, picture: room.host.picture } : null,
    movie: room.movie,
    videoFile: room.videoFile,
    status: room.status,
    playbackState: room.playbackState,
    settings: room.settings,
    participants: buildParticipantsPayload(room),
  };
}

io.on('connection', (socket) => {
  console.log('[DEBUG] New socket connection:', socket.id);
  socket.userId = null;
  socket.user = null;
  socket.roomId = null;

  socket.on('authenticate', async (data) => {
    try {
      console.log('[DEBUG] Authentication request received:', { hasToken: !!(data?.token), socketId: socket.id });
      const { token } = data || {};
      if (!token) {
        console.log('[DEBUG] Authentication failed: No token provided');
        return socket.emit('auth-error', { error: 'Token required' });
      }
      const jwt = await import('jsonwebtoken');
      const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (!user) {
        console.log('[DEBUG] Authentication failed: User not found');
        return socket.emit('auth-error', { error: 'Invalid token' });
      }
      socket.userId = user._id.toString();
      socket.user = { id: user._id, name: user.name, picture: user.picture };
      addUserSocket(socket.userId, socket.id);
      await user.updateOnlineStatus(true);
      console.log('[DEBUG] Authentication successful:', { userId: socket.userId, userName: user.name });
      socket.emit('authenticated', { user: socket.user });
    } catch (error) {
      console.log('[DEBUG] Authentication error:', error?.message || error);
      socket.emit('auth-error', { error: 'Authentication failed' });
    }
  });

  socket.on('join-room', async (data) => {
    try {
      console.log('[DEBUG] Join room request:', { roomId: data?.roomId, userId: socket.userId, socketId: socket.id });
      const { roomId } = data || {};
      if (!socket.userId) {
        console.log('[DEBUG] Join room failed: Not authenticated');
        return socket.emit('error', { error: 'Not authenticated' });
      }

      let room = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');

      if (!room) {
        console.log('[DEBUG] Join room failed: Room not found', roomId);
        return socket.emit('error', { error: 'Room not found' });
      }

      console.log('[DEBUG] Room found:', { roomId, isPrivate: room.isPrivate, hostId: room.host?._id });
      const canJoin = room.canUserJoin(socket.userId);
      console.log('[DEBUG] Can join check:', canJoin);
      if (!canJoin.canJoin) {
        console.log('[DEBUG] Join room failed: Cannot join -', canJoin.reason);
        return socket.emit('error', { error: canJoin.reason });
      }

      console.log('[DEBUG] Joining socket.io room and updating DB...');
      socket.join(roomId);
      socket.roomId = roomId;

      await Room.updateOne(
        { _id: roomId, 'participants.user': { $ne: socket.userId } },
        {
          $addToSet: {
            participants: {
              user: socket.userId,
              joinedAt: new Date(),
              isHost: false,
              isActive: true,
              lastSeen: new Date(),
            },
          },
        }
      );
      await Room.updateOne(
        { _id: roomId, 'participants.user': socket.userId },
        { $set: { 'participants.$.isActive': true, 'participants.$.lastSeen': new Date() } }
      );

      // re-fetch canonical room
      room = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');

      console.log('[DEBUG] Emitting room-joined event to joiner...');
      socket.emit('room-joined', { room: buildRoomInfoPayload(room) });

      // notify others (exclude joiner) about the join
      socket.to(roomId).emit('user-joined', {
        user: socket.user,
        userId: socket.userId,
        participants: buildParticipantsPayload(room),
      });
      socket.to(roomId).emit('peer-joined', { peerId: socket.userId, peerName: socket.user.name });

      // Debug: list sockets currently in the room
      try {
        const roomSockets = io.sockets.adapter.rooms.get(roomId);
        console.log('[DEBUG] Sockets in room', roomId, roomSockets ? Array.from(roomSockets) : []);
      } catch (err) {
        // ignore
      }

      // --- NEW: broadcast canonical participants + full room info to everyone (including host) ---
      console.log('[DEBUG] Broadcasting canonical participants & room-info to room:', roomId);
      io.in(roomId).emit('participants-updated', { participants: buildParticipantsPayload(room) });
      io.in(roomId).emit('room-info', buildRoomInfoPayload(room));
      // --------------------------------------------------------------------------------------------

    } catch (error) {
      console.error('[DEBUG] Join room error:', error);
      socket.emit('error', { error: 'Failed to join room' });
    }
  });

  socket.on('leave-room', async () => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const roomId = socket.roomId;
      const room = await Room.findById(roomId);
      if (room) {
        await room.removeParticipant(socket.userId);
        const updatedRoom = await Room.findById(roomId).populate('participants.user', 'name picture');

        // notify others (exclude leaver)
        socket.to(roomId).emit('user-left', {
          user: socket.user,
          participants: updatedRoom.participants.map((p) => ({
            user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
            isHost: p.isHost,
            isActive: p.isActive,
          })),
        });
        socket.to(roomId).emit('peer-left', { peerId: socket.userId, peerName: socket.user?.name });

        // broadcast canonical updates to everyone (including host)
        io.in(roomId).emit('participants-updated', { participants: buildParticipantsPayload(updatedRoom) });
        io.in(roomId).emit('room-info', buildRoomInfoPayload(updatedRoom));
      }
      socket.leave(roomId);
      socket.roomId = null;
    } catch (error) {
      console.error('[DEBUG] leave-room error:', error);
    }
  });

  socket.on('video-play', async (data) => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;
      const currentTime = (data && typeof data.currentTime === 'number') ? data.currentTime : room.playbackState?.currentTime || 0;
      await room.updatePlaybackState({ isPlaying: true, currentTime });
      socket.to(socket.roomId).emit('video-play', { currentTime });
    } catch (error) {
      console.error('[DEBUG] video-play error:', error);
    }
  });

  socket.on('video-pause', async (data) => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;
      await room.updatePlaybackState({ isPlaying: false });
      socket.to(socket.roomId).emit('video-pause');
    } catch (error) {
      console.error('[DEBUG] video-pause error:', error);
    }
  });

  socket.on('video-seek', async (data) => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;
      const time = data && typeof data.time === 'number' ? data.time : 0;
      await room.updatePlaybackState({ currentTime: time });
      socket.to(socket.roomId).emit('video-seek', { time });
    } catch (error) {
      console.error('[DEBUG] video-seek error:', error);
    }
  });

  socket.on('video-metadata', async (data) => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;
      room.videoFile = { name: data.name, size: data.size, type: data.type, url: data.url };
      await room.save();
      socket.to(socket.roomId).emit('video-metadata', { name: data.name, size: data.size, type: data.type, url: data.url });
    } catch (error) {
      console.error('[DEBUG] video-metadata error:', error);
    }
  });

  socket.on('chat-message', (data) => {
    if (!socket.roomId || !socket.user) return;
    socket.to(socket.roomId).emit('chat-message', {
      ...data,
      user: socket.user,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on('voice-message', (data, callback) => {
    if (!socket.roomId || !socket.user) {
      if (callback) callback({ success: false, error: 'Not in room' });
      return;
    }
    try {
      socket.to(socket.roomId).emit('voice-message', {
        message: {
          ...data.message,
          user: socket.user,
          timestamp: new Date().toISOString(),
        }
      });
      if (callback) callback({ success: true, message: 'Voice message sent' });
    } catch (error) {
      if (callback) callback({ success: false, error: error.message });
      console.error('[DEBUG] voice-message error:', error);
    }
  });

  // NEW: Live voice streaming handler
  socket.on('live-voice-stream', (data) => {
    if (!socket.roomId || !socket.user) return;
    
    try {
      socket.to(socket.roomId).emit('live-voice-stream', {
        audioData: data.audioData,
        userId: socket.user.id,
        userName: socket.user.name,
        timestamp: data.timestamp || Date.now()
      });
    } catch (error) {
      console.error('Live voice stream error:', error);
    }
  });

  socket.on('video-state-request', (data) => {
    if (!socket.roomId || !socket.user) return;
    socket.to(socket.roomId).emit('video-state-request', {
      from: socket.user.id,
      roomId: socket.roomId
    });
  });

  socket.on('host-video-state-request', async (data) => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const roomDoc = await Room.findById(socket.roomId);
      if (!roomDoc) return;
      if (roomDoc.host && roomDoc.host.toString() === socket.userId) {
        socket.to(socket.roomId).emit('host-video-state-request', {
          from: socket.userId,
          roomId: socket.roomId
        });
      }
    } catch (err) {
      console.error('[DEBUG] host-video-state-request error:', err);
    }
  });

  socket.on('video-state-sync', (data) => {
    if (!socket.roomId || !socket.user) return;
    socket.to(socket.roomId).emit('video-state-sync', {
      videoState: data.videoState || data,
      from: socket.user.id,
      roomId: socket.roomId
    });
  });

  socket.on('offer', (data) => {
    if (!socket.userId || !socket.roomId) return;
    const delivered = emitToUserInSameRoom(data.to, socket.roomId, 'offer', {
      offer: data.offer,
      from: socket.userId,
    });
    if (delivered === 0) {
      // optionally queue or handle missing recipient
    }
  });

  socket.on('answer', (data) => {
    if (!socket.userId || !socket.roomId) return;
    const delivered = emitToUserInSameRoom(data.to, socket.roomId, 'answer', {
      answer: data.answer,
      from: socket.userId,
    });
    if (delivered === 0) {
      // optionally queue or handle missing recipient
    }
  });

  socket.on('ice-candidate', (data) => {
    if (!socket.userId || !socket.roomId) return;
    const delivered = emitToUserInSameRoom(data.to, socket.roomId, 'ice-candidate', {
      candidate: data.candidate,
      from: socket.userId,
    });
    if (delivered === 0) {
      // optionally queue or handle missing recipient
    }
  });

  socket.on('disconnect', async () => {
    try {
      if (socket.userId) {
        removeUserSocket(socket.userId, socket.id);
        const remaining = getUserSocketIds(socket.userId);
        if (!remaining || remaining.size === 0) {
          await User.findByIdAndUpdate(socket.userId, { isOnline: false, lastSeen: new Date() });
        }
      }

      if (socket.roomId && socket.userId) {
        const roomId = socket.roomId;
        const room = await Room.findById(roomId);
        if (room) {
          await room.removeParticipant(socket.userId);
          const updatedRoom = await Room.findById(roomId).populate('participants.user', 'name picture');

          // notify others (exclude disconnected socket)
          socket.to(roomId).emit('user-left', {
            user: socket.user,
            participants: updatedRoom.participants.map((p) => ({
              user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
              isHost: p.isHost,
              isActive: p.isActive,
            })),
          });
          socket.to(roomId).emit('peer-left', { peerId: socket.userId, peerName: socket.user?.name });

          // broadcast canonical participants + room-info to everyone (including host)
          io.in(roomId).emit('participants-updated', { participants: buildParticipantsPayload(updatedRoom) });
          io.in(roomId).emit('room-info', buildRoomInfoPayload(updatedRoom));
        }
      }
    } catch (error) {
      console.error('[DEBUG] disconnect handler error:', error);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
