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

// // Health check endpoint
// app.get('/api/health', (req, res) => {
//   res.json({ 
//     success: true, 
//     message: 'Server is running',
//     timestamp: new Date().toISOString()
//   });
// });


io.on('connection', (socket) => {
  console.log('_on connection__User connected :', socket.id);

  
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
      const jwt = await import('jsonwebtoken');
      const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
      console.log('Token decoded:', decoded);
      const user = await User.findById(decoded.id);
      console.log('User found:', user ? user.name : 'Not found');

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

    let room = await Room.findById(roomId)
      .populate('host', 'name picture')
      .populate('participants.user', 'name picture');

    if (!room) {
      socket.emit('error', { error: 'Room not found' });
      return;
    }

    // Check if user can join (custom room logic)
    const canJoin = room.canUserJoin(socket.userId);
    if (!canJoin.canJoin) {
      socket.emit('error', { error: canJoin.reason });
      return;
    }

    // Join socket.io room
    socket.join(roomId);
    socket.roomId = roomId;

    // ✅ Prevent duplicates: Update or insert participant atomically
    await Room.updateOne(
      { _id: roomId, 'participants.user': { $ne: socket.userId } },
      {
        $addToSet: {
          participants: {
            user: socket.userId,
            joinedAt: new Date(),
            isHost: false,
            isActive: true,
            lastSeen: new Date()
          }
        }
      }
    );

    // ✅ If already in room, just update active status & timestamp
    await Room.updateOne(
      { _id: roomId, 'participants.user': socket.userId },
      {
        $set: {
          'participants.$.isActive': true,
          'participants.$.lastSeen': new Date()
        }
      }
    );

    // Get updated room info
    room = await Room.findById(roomId)
      .populate('host', 'name picture')
      .populate('participants.user', 'name picture');

    console.log(`User ${socket.user.name} joined room ${roomId}`);

    // Send room info to the joining user
    socket.emit('room-joined', {
      room: {
        id: room._id,
        name: room.name,
        host: {
          id: room.host._id,
          name: room.host.name,
          picture: room.host.picture
        },
        movie: room.movie,
        videoFile: room.videoFile,
        status: room.status,
        playbackState: room.playbackState,
        settings: room.settings,
        participants: room.participants.map(p => ({
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

    // Notify other users in the room
    socket.to(roomId).emit('user-joined', {
      user: socket.user,
      userId: socket.userId,
      participants: room.participants.map(p => ({
        user: {
          id: p.user._id,
          name: p.user.name,
          picture: p.user.picture
        },
        isHost: p.isHost,
        isActive: p.isActive
      }))
    });

    console.log(`[Socket.io] user-joined event emitted for userId: ${socket.userId}`);

    // Notify WebRTC peers
    socket.to(roomId).emit('peer-joined', {
      peerId: socket.userId,
      peerName: socket.user.name
    });

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

        // Notify for WebRTC connections
        socket.to(socket.roomId).emit('peer-left', {
          peerId: socket.userId,
          peerName: socket.user?.name
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
      ...data,
      user: socket.user,
      timestamp: new Date().toISOString()
    });
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    // Find the target user's socket and send the offer
    const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.userId === data.to);
    if (targetSocket) {
      targetSocket.emit('offer', {
        offer: data.offer,
        from: socket.userId
      });
      console.log(`WebRTC offer sent from ${socket.userId} to ${data.to}`);
    } else {
      console.log(`Target user ${data.to} not found for WebRTC offer`);
    }
  });

  socket.on('answer', (data) => {
    // Find the target user's socket and send the answer
    const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.userId === data.to);
    if (targetSocket) {
      targetSocket.emit('answer', {
        answer: data.answer,
        from: socket.userId
      });
      console.log(`WebRTC answer sent from ${socket.userId} to ${data.to}`);
    } else {
      console.log(`Target user ${data.to} not found for WebRTC answer`);
    }
  });

  socket.on('ice-candidate', (data) => {
    // Find the target user's socket and send the ICE candidate
    const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.userId === data.to);
    if (targetSocket) {
      targetSocket.emit('ice-candidate', {
        candidate: data.candidate,
        from: socket.userId
      });
      console.log(`WebRTC ICE candidate sent from ${socket.userId} to ${data.to}`);
    } else {
      console.log(`Target user ${data.to} not found for WebRTC ICE candidate`);
    }
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

          // Notify for WebRTC connections
          socket.to(socket.roomId).emit('peer-left', {
            peerId: socket.userId,
            peerName: socket.user?.name
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