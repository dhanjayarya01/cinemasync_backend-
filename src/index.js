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
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  })
);
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);

/**
 * =============================
 * Socket helpers: user <-> sockets
 * =============================
 * Many apps try to route signaling by userId. That works only if you map
 * userId -> socket.id for the CURRENT connection(s). Users may have multiple
 * tabs (multiple sockets). We keep a Set of socket IDs per user.
 */
const userSockets = new Map(); // Map<userId:string, Set<socketId:string>>

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

/**
 * Optional: restrict signaling to same room to avoid cross-room leaks
 */
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

io.on('connection', (socket) => {
  console.log('_on connection__User connected :', socket.id);

  socket.userId = null;
  socket.user = null;
  socket.roomId = null;

  // Authenticate socket connection
  socket.on('authenticate', async (data) => {
    try {
      const { token } = data || {};
      if (!token) return socket.emit('auth-error', { error: 'Token required' });

      const jwt = await import('jsonwebtoken');
      const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
      console.log('Token decoded:', decoded);

      const user = await User.findById(decoded.id);
      console.log('User found:', user ? user.name : 'Not found');
      if (!user) return socket.emit('auth-error', { error: 'Invalid token' });

      socket.userId = user._id.toString();
      socket.user = { id: user._id, name: user.name, picture: user.picture };

      // Map user to this socket
      addUserSocket(socket.userId, socket.id);

      await user.updateOnlineStatus(true);

      socket.emit('authenticated', { user: socket.user });
      console.log(`User ${user.name} authenticated: ${socket.id}`);
    } catch (error) {
      console.error('Socket authentication error:', error);
      socket.emit('auth-error', { error: 'Authentication failed' });
    }
  });

  // Join room
  socket.on('join-room', async (data) => {
    try {
      const { roomId } = data || {};
      if (!socket.userId) return socket.emit('error', { error: 'Not authenticated' });

      let room = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');

      if (!room) return socket.emit('error', { error: 'Room not found' });

      const canJoin = room.canUserJoin(socket.userId);
      if (!canJoin.canJoin) return socket.emit('error', { error: canJoin.reason });

      socket.join(roomId);
      socket.roomId = roomId;

      // Avoid dup participants, but mark active
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

      room = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');

      console.log(`User ${socket.user.name} joined room ${roomId}`);

      // Send room info to the joining user
      socket.emit('room-joined', {
        room: {
          id: room._id,
          name: room.name,
          host: { id: room.host._id, name: room.host.name, picture: room.host.picture },
          movie: room.movie,
          videoFile: room.videoFile,
          status: room.status,
          playbackState: room.playbackState,
          settings: room.settings,
          participants: room.participants.map((p) => ({
            user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
            joinedAt: p.joinedAt,
            isHost: p.isHost,
            isActive: p.isActive,
          })),
        },
      });

      // Notify other users in the room
      socket.to(roomId).emit('user-joined', {
        user: socket.user,
        userId: socket.userId,
        participants: room.participants.map((p) => ({
          user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
          isHost: p.isHost,
          isActive: p.isActive,
        })),
      });

      // Notify for WebRTC peers
      socket.to(roomId).emit('peer-joined', { peerId: socket.userId, peerName: socket.user.name });
    } catch (error) {
      console.error('Join room error:', error);
      socket.emit('error', { error: 'Failed to join room' });
    }
  });

  // Leave room
  socket.on('leave-room', async () => {
    try {
      if (!socket.roomId || !socket.userId) return;

      const room = await Room.findById(socket.roomId);
      if (room) {
        await room.removeParticipant(socket.userId);
        const updatedRoom = await Room.findById(socket.roomId).populate('participants.user', 'name picture');

        socket.to(socket.roomId).emit('user-left', {
          user: socket.user,
          participants: updatedRoom.participants.map((p) => ({
            user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
            isHost: p.isHost,
            isActive: p.isActive,
          })),
        });

        socket.to(socket.roomId).emit('peer-left', { peerId: socket.userId, peerName: socket.user?.name });
      }

      socket.leave(socket.roomId);
      socket.roomId = null;

      console.log(`User ${socket.user?.name} left room`);
    } catch (error) {
      console.error('Leave room error:', error);
    }
  });

  // Video control events (host only)
  socket.on('video-play', async () => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;
      await room.updatePlaybackState({ isPlaying: true });
      socket.to(socket.roomId).emit('video-play', { currentTime: room.playbackState.currentTime });
    } catch (error) {
      console.error('Video play error:', error);
    }
  });

  socket.on('video-pause', async () => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;
      await room.updatePlaybackState({ isPlaying: false });
      socket.to(socket.roomId).emit('video-pause');
    } catch (error) {
      console.error('Video pause error:', error);
    }
  });

  socket.on('video-seek', async (data) => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;
      await room.updatePlaybackState({ currentTime: data.time });
      socket.to(socket.roomId).emit('video-seek', { time: data.time });
    } catch (error) {
      console.error('Video seek error:', error);
    }
  });

  // Video metadata (host only)
  socket.on('video-metadata', async (data) => {
    try {
      if (!socket.roomId || !socket.userId) return;
      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;

      room.videoFile = { name: data.name, size: data.size, type: data.type, url: data.url };
      await room.save();

      socket.to(socket.roomId).emit('video-metadata', { name: data.name, size: data.size, type: data.type, url: data.url });
    } catch (error) {
      console.error('Video metadata error:', error);
    }
  });

  // Chat messages
  socket.on('chat-message', (data) => {
    if (!socket.roomId || !socket.user) return;
    socket.to(socket.roomId).emit('chat-message', {
      ...data,
      user: socket.user,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * =============================
   * WebRTC signaling (userId -> socket.id mapping)
   * =============================
   * We accept { to: <targetUserId>, offer/answer/candidate } and deliver to
   * the current socket(s) of that user that are in the SAME room.
   */
  socket.on('offer', (data) => {
    if (!socket.userId || !socket.roomId) return;
    const delivered = emitToUserInSameRoom(data.to, socket.roomId, 'offer', {
      offer: data.offer,
      from: socket.userId,
    });
    if (delivered === 0) {
      console.log(`Target user ${data.to} not found for WebRTC offer (same room required).`);
    } else {
      console.log(`WebRTC offer sent from ${socket.userId} to ${data.to} (x${delivered}).`);
    }
  });

  socket.on('answer', (data) => {
    if (!socket.userId || !socket.roomId) return;
    const delivered = emitToUserInSameRoom(data.to, socket.roomId, 'answer', {
      answer: data.answer,
      from: socket.userId,
    });
    if (delivered === 0) {
      console.log(`Target user ${data.to} not found for WebRTC answer (same room required).`);
    } else {
      console.log(`WebRTC answer sent from ${socket.userId} to ${data.to} (x${delivered}).`);
    }
  });

  socket.on('ice-candidate', (data) => {
    if (!socket.userId || !socket.roomId) return;
    const delivered = emitToUserInSameRoom(data.to, socket.roomId, 'ice-candidate', {
      candidate: data.candidate,
      from: socket.userId,
    });
    if (delivered === 0) {
      console.log(`Target user ${data.to} not found for WebRTC ICE candidate (same room required).`);
    } else {
      console.log(`WebRTC ICE candidate sent from ${socket.userId} to ${data.to} (x${delivered}).`);
    }
  });

  // Disconnect handling
  socket.on('disconnect', async () => {
    try {
      console.log('User disconnected:', socket.id);

      if (socket.userId) {
        removeUserSocket(socket.userId, socket.id);
        await User.findByIdAndUpdate(socket.userId, { isOnline: false, lastSeen: new Date() });
      }

      if (socket.roomId && socket.userId) {
        const room = await Room.findById(socket.roomId);
        if (room) {
          await room.removeParticipant(socket.userId);
          const updatedRoom = await Room.findById(socket.roomId).populate('participants.user', 'name picture');

          socket.to(socket.roomId).emit('user-left', {
            user: socket.user,
            participants: updatedRoom.participants.map((p) => ({
              user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
              isHost: p.isHost,
              isActive: p.isActive,
            })),
          });

          socket.to(socket.roomId).emit('peer-left', { peerId: socket.userId, peerName: socket.user?.name });
        }
      }
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
