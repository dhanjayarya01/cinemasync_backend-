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

// Load environment variables
dotenv.config();

// Connect to database
connectDB();

const app = express();
const server = http.createServer(app);

const io = new socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000", 
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Store user info in socket
  socket.userId = null;
  socket.roomId = null;

  // Authenticate socket connection
  socket.on('authenticate', async (data) => {
    try {
      const { token } = data;
      
      if (!token) {
        socket.emit('auth-error', { error: 'Token required' });
        return;
      }

      // Verify token and get user
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);

      if (!user) {
        socket.emit('auth-error', { error: 'Invalid token' });
        return;
      }

      socket.userId = user._id;
      socket.user = {
        id: user._id,
        name: user.name,
        picture: user.picture
      };

      // Update user online status
      await user.updateOnlineStatus(true);

      socket.emit('authenticated', {
        user: socket.user
      });

      console.log(`User ${user.name} authenticated: ${socket.id}`);
    } catch (error) {
      console.error('Socket authentication error:', error);
      socket.emit('auth-error', { error: 'Authentication failed' });
    }
  });

  // Join room
  socket.on('join-room', async (data) => {
    try {
      const { roomId } = data;
      
      if (!socket.userId) {
        socket.emit('error', { error: 'Not authenticated' });
        return;
      }

      const room = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');

      if (!room) {
        socket.emit('error', { error: 'Room not found' });
        return;
      }

      // Check if user can join
      const canJoin = room.canUserJoin(socket.userId);
      if (!canJoin.canJoin) {
        socket.emit('error', { error: canJoin.reason });
        return;
      }

      // Join socket room
      socket.join(roomId);
      socket.roomId = roomId;

      // Add user to room participants
      await room.addParticipant(socket.userId);

      // Get updated room info
      const updatedRoom = await Room.findById(roomId)
        .populate('host', 'name picture')
        .populate('participants.user', 'name picture');

      // Send room info to the joining user
      socket.emit('room-joined', {
        room: {
          id: updatedRoom._id,
          name: updatedRoom.name,
          host: {
            id: updatedRoom.host._id,
            name: updatedRoom.host.name,
            picture: updatedRoom.host.picture
          },
          movie: updatedRoom.movie,
          videoFile: updatedRoom.videoFile,
          status: updatedRoom.status,
          playbackState: updatedRoom.playbackState,
          settings: updatedRoom.settings,
          participants: updatedRoom.participants.map(p => ({
            user: {
              id: p.user._id,
              name: p.user.name,
              picture: p.user.picture
            },
            joinedAt: p.joinedAt,
            isHost: p.isHost,
            isActive: p.isActive
          }))
        }
      });

      // Notify other users
      socket.to(roomId).emit('user-joined', {
        user: socket.user,
        participants: updatedRoom.participants.map(p => ({
          user: {
            id: p.user._id,
            name: p.user.name,
            picture: p.user.picture
          },
          isHost: p.isHost,
          isActive: p.isActive
        }))
      });

      console.log(`User ${socket.user.name} joined room ${roomId}`);
    } catch (error) {
      console.error('Join room error:', error);
      socket.emit('error', { error: 'Failed to join room' });
    }
  });

  // Leave room
  socket.on('leave-room', async () => {
    try {
      if (!socket.roomId || !socket.userId) {
        return;
      }

      const room = await Room.findById(socket.roomId);
      if (room) {
        await room.removeParticipant(socket.userId);
        
        // Get updated room info
        const updatedRoom = await Room.findById(socket.roomId)
          .populate('participants.user', 'name picture');

        // Notify other users
        socket.to(socket.roomId).emit('user-left', {
          user: socket.user,
          participants: updatedRoom.participants.map(p => ({
            user: {
              id: p.user._id,
              name: p.user.name,
              picture: p.user.picture
            },
            isHost: p.isHost,
            isActive: p.isActive
          }))
        });
      }

      socket.leave(socket.roomId);
      socket.roomId = null;

      console.log(`User ${socket.user?.name} left room`);
    } catch (error) {
      console.error('Leave room error:', error);
    }
  });

  // Video control events
  socket.on('video-play', async (data) => {
    try {
      if (!socket.roomId || !socket.userId) return;

      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;

      await room.updatePlaybackState({ isPlaying: true });
      
      socket.to(socket.roomId).emit('video-play', {
        currentTime: room.playbackState.currentTime
      });
    } catch (error) {
      console.error('Video play error:', error);
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

  // Video metadata
  socket.on('video-metadata', async (data) => {
    try {
      if (!socket.roomId || !socket.userId) return;

      const room = await Room.findById(socket.roomId);
      if (!room || room.host.toString() !== socket.userId.toString()) return;

      room.videoFile = {
        name: data.name,
        size: data.size,
        type: data.type,
        url: data.url
      };
      await room.save();

      socket.to(socket.roomId).emit('video-metadata', {
        name: data.name,
        size: data.size,
        type: data.type,
        url: data.url
      });
    } catch (error) {
      console.error('Video metadata error:', error);
    }
  });

  // Chat messages
  socket.on('chat-message', (data) => {
    if (!socket.roomId || !socket.user) return;

    socket.to(socket.roomId).emit('chat-message', {
      user: socket.user,
      message: data.message,
      timestamp: new Date().toISOString()
    });
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    socket.to(data.to).emit('offer', {
      offer: data.offer,
      from: socket.id
    });
  });

  socket.on('answer', (data) => {
    socket.to(data.to).emit('answer', {
      answer: data.answer,
      from: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.to).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.id
    });
  });

  // Disconnect handling
  socket.on('disconnect', async () => {
    try {
      console.log('User disconnected:', socket.id);

      // Update user online status
      if (socket.userId) {
        await User.findByIdAndUpdate(socket.userId, {
          isOnline: false,
          lastSeen: new Date()
        });
      }

      // Remove user from room
      if (socket.roomId && socket.userId) {
        const room = await Room.findById(socket.roomId);
        if (room) {
          await room.removeParticipant(socket.userId);
          
          // Notify other users
          const updatedRoom = await Room.findById(socket.roomId)
            .populate('participants.user', 'name picture');

          socket.to(socket.roomId).emit('user-left', {
            user: socket.user,
            participants: updatedRoom.participants.map(p => ({
              user: {
                id: p.user._id,
                name: p.user.name,
                picture: p.user.picture
              },
              isHost: p.isHost,
              isActive: p.isActive
            }))
          });
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