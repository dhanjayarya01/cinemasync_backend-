
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
      console.log('[DEBUG] Authentication error:', error.message);
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
      
      console.log('[DEBUG] Room found:', { roomId, isPrivate: room.isPrivate, hostId: room.host._id });
      const canJoin = room.canUserJoin(socket.userId);
      console.log('[DEBUG] Can join check:', canJoin);
      if (!canJoin.canJoin) {
        console.log('[DEBUG] Join room failed: Cannot join -', canJoin.reason);
        return socket.emit('error', { error: canJoin.reason });
      }
      
      console.log('[DEBUG] Joining socket room and updating database...');
      socket.join(roomId);
      socket.roomId = roomId;
      
      // Use atomic operations to prevent race conditions
      const existingParticipant = room.participants.find(p => p.user._id.toString() === socket.userId);
      
      if (!existingParticipant) {
        // Add new participant atomically
        await Room.updateOne(
          { _id: roomId },
          {
            $addToSet: {
              participants: {
                user: socket.userId,
                joinedAt: new Date(),
                isHost: false,
                isActive: true,
                lastSeen: new Date(),
              },
            }
          }
        );
      } else {
        // Update existing participant
        await Room.updateOne(
          { _id: roomId, 'participants.user': socket.userId },
          { 
            $set: { 
              'participants.$.isActive': true, 
              'participants.$.lastSeen': new Date() 
            }
          }
        );
      }
      
      // Get updated room data and recalculate participants count
      room = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');
      
      const activeParticipants = room.participants.filter(p => p.isActive);
      
      // Update current participants count atomically
      await Room.updateOne(
        { _id: roomId },
        { $set: { currentParticipants: activeParticipants.length } }
      );
      
      console.log('[DEBUG] Emitting room-joined event...');
      
      const roomData = {
        id: room._id,
        name: room.name,
        host: { id: room.host._id, name: room.host.name, picture: room.host.picture },
        movie: room.movie,
        videoFile: room.videoFile,
        status: room.status,
        playbackState: room.playbackState,
        settings: room.settings,
        participants: activeParticipants.map((p) => ({
          user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
          joinedAt: p.joinedAt,
          isHost: p.isHost,
          isActive: p.isActive,
        })),
      };
      
      // Send to joining user first
      socket.emit('room-joined', { room: roomData });
      
      // Immediate broadcast to all users in room with updated participant count
      io.to(roomId).emit('participants-updated', {
        participants: roomData.participants,
        currentParticipants: activeParticipants.length,
        roomId: roomId
      });
      
      // Notify others about new user with complete room data
      socket.to(roomId).emit('user-joined', {
        user: socket.user,
        userId: socket.userId,
        participants: roomData.participants,
        currentParticipants: activeParticipants.length
      });
      
      // Force room sync to all clients after join
      setTimeout(() => {
        io.to(roomId).emit('room-sync', { room: roomData });
      }, 200);
      
      // WebRTC peer notification with delay to ensure socket room is ready
      setTimeout(() => {
        socket.to(roomId).emit('peer-joined', { peerId: socket.userId, peerName: socket.user.name });
      }, 500);
      
    } catch (error) {
      console.error('[DEBUG] Join room error:', error);
      socket.emit('error', { error: 'Failed to join room' });
    }
  });

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
    } catch (error) {
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
    }
  });

  // NEW: Live voice streaming handler
  socket.on('live-voice-stream', (data) => {
    if (!socket.roomId || !socket.user) return;
    
    try {
      // Relay live voice stream to all other participants in the room
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
    }
  });

  socket.on('answer', (data) => {
    if (!socket.userId || !socket.roomId) return;
    const delivered = emitToUserInSameRoom(data.to, socket.roomId, 'answer', {
      answer: data.answer,
      from: socket.userId,
    });
    if (delivered === 0) {
    }
  });

  socket.on('ice-candidate', (data) => {
    if (!socket.userId || !socket.roomId) return;
    const delivered = emitToUserInSameRoom(data.to, socket.roomId, 'ice-candidate', {
      candidate: data.candidate,
      from: socket.userId,
    });
    if (delivered === 0) {
    }
  });

  // Handle room sync requests
  socket.on('request-room-sync', async (data) => {
    try {
      const { roomId } = data || {};
      if (!socket.userId || !roomId) return;
      
      const room = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');
        
      if (!room) return;
      
      const activeParticipants = room.participants.filter(p => p.isActive);
      
      // Update participant count to ensure consistency
      await Room.updateOne(
        { _id: roomId },
        { $set: { currentParticipants: activeParticipants.length } }
      );
      
      const roomData = {
        id: room._id,
        name: room.name,
        host: { id: room.host._id, name: room.host.name, picture: room.host.picture },
        movie: room.movie,
        videoFile: room.videoFile,
        status: room.status,
        playbackState: room.playbackState,
        settings: room.settings,
        participants: activeParticipants.map((p) => ({
          user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
          joinedAt: p.joinedAt,
          isHost: p.isHost,
          isActive: p.isActive,
        })),
      };
      
      socket.emit('room-sync', { room: roomData });
      
      // Also broadcast updated participant count to all room members
      io.to(roomId).emit('participants-updated', {
        participants: roomData.participants,
        currentParticipants: activeParticipants.length,
        roomId: roomId
      });
    } catch (error) {
      console.error('[DEBUG] Room sync error:', error);
    }
  });

  // Periodic room health check for hosts
  socket.on('host-room-check', async (data) => {
    try {
      const { roomId } = data || {};
      if (!socket.userId || !roomId) return;
      
      const room = await Room.findById(roomId);
      if (!room || room.host.toString() !== socket.userId) return;
      
      // Broadcast room sync to all participants
      const updatedRoom = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');
        
      if (updatedRoom) {
        const activeParticipants = updatedRoom.participants.filter(p => p.isActive);
        
        // Update participant count
        await Room.updateOne(
          { _id: roomId },
          { $set: { currentParticipants: activeParticipants.length } }
        );
        
        const roomData = {
          id: updatedRoom._id,
          name: updatedRoom.name,
          host: { id: updatedRoom.host._id, name: updatedRoom.host.name, picture: updatedRoom.host.picture },
          movie: updatedRoom.movie,
          videoFile: updatedRoom.videoFile,
          status: updatedRoom.status,
          playbackState: updatedRoom.playbackState,
          settings: updatedRoom.settings,
          participants: activeParticipants.map((p) => ({
            user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
            joinedAt: p.joinedAt,
            isHost: p.isHost,
            isActive: p.isActive,
          })),
        };
        
        io.to(roomId).emit('room-sync', { room: roomData });
        io.to(roomId).emit('participants-updated', {
          participants: roomData.participants,
          currentParticipants: activeParticipants.length,
          roomId: roomId
        });
      }
    } catch (error) {
      console.error('[DEBUG] Host room check error:', error);
    }
  });

  // Add periodic room cleanup and sync
  socket.on('force-room-sync', async (data) => {
    try {
      const { roomId } = data || {};
      if (!socket.userId || !roomId) return;
      
      const room = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');
        
      if (!room) return;
      
      const activeParticipants = room.participants.filter(p => p.isActive);
      
      // Force update participant count
      await Room.updateOne(
        { _id: roomId },
        { $set: { currentParticipants: activeParticipants.length } }
      );
      
      const roomData = {
        id: room._id,
        name: room.name,
        host: { id: room.host._id, name: room.host.name, picture: room.host.picture },
        movie: room.movie,
        videoFile: room.videoFile,
        status: room.status,
        playbackState: room.playbackState,
        settings: room.settings,
        participants: activeParticipants.map((p) => ({
          user: { id: p.user._id, name: p.user.name, picture: p.user.picture },
          joinedAt: p.joinedAt,
          isHost: p.isHost,
          isActive: p.isActive,
        })),
      };
      
      // Force sync to all room members
      io.to(roomId).emit('room-sync', { room: roomData });
      io.to(roomId).emit('participants-updated', {
        participants: roomData.participants,
        currentParticipants: activeParticipants.length,
        roomId: roomId
      });
    } catch (error) {
      console.error('[DEBUG] Force room sync error:', error);
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
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
