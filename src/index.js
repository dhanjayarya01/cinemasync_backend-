import express from 'express';
import http from 'http';
import { Server as socketIo } from 'socket.io';
import cors from 'cors';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

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

// Initialize Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// In-memory user storage (in production, use a database)
const users = new Map();

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Google OAuth verification endpoint
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    
    if (!credential) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Create or update user
    let user = users.get(googleId);
    if (!user) {
      user = {
        id: googleId,
        email,
        name,
        picture,
        createdAt: new Date().toISOString()
      };
      users.set(googleId, user);
    } else {
      // Update existing user info
      user.name = name;
      user.picture = picture;
      user.email = email;
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        name: user.name 
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture
      }
    });

  } catch (error) {
    console.error('Google OAuth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Get user profile
app.get('/api/auth/profile', authenticateToken, (req, res) => {
  const user = users.get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture
  });
});

// Logout endpoint
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  // In a real application, you might want to blacklist the token
  res.json({ success: true, message: 'Logged out successfully' });
});

const rooms = new Map();

// API Routes
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.keys()).map(roomId => ({
    id: roomId,
    participants: rooms.get(roomId).participants.length,
    hasVideo: !!rooms.get(roomId).videoFile
  }));
  res.json(roomList);
});

app.post('/api/create-room', (req, res) => {
  const { roomId } = req.body;
  if (rooms.has(roomId)) {
    return res.status(400).json({ error: 'Room already exists' });
  }
  
  rooms.set(roomId, {
    participants: [],
    host: null,
    videoFile: null,
    isPlaying: false,
    currentTime: 0
  });
  
  res.json({ success: true, roomId });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        participants: [],
        host: null,
        videoFile: null,
        isPlaying: false,
        currentTime: 0
      });
    }
    
    const room = rooms.get(roomId);
    room.participants.push(socket.id);
    
    // Set first user as host
    if (!room.host) {
      room.host = socket.id;
    }
    
    // Send room info to the joining user
    socket.emit('room-info', {
      participants: room.participants,
      host: room.host,
      videoFile: room.videoFile,
      isPlaying: room.isPlaying,
      currentTime: room.currentTime
    });
    
    // Notify other users
    socket.to(roomId).emit('user-joined', socket.id);
    io.to(roomId).emit('room-updated', {
      participants: room.participants,
      host: room.host
    });
    
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  socket.on('leave-room', (roomId) => {
    socket.leave(roomId);
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.participants = room.participants.filter(id => id !== socket.id);
      
      // If host leaves, assign new host
      if (room.host === socket.id && room.participants.length > 0) {
        room.host = room.participants[0];
      }
      
      // If room is empty, delete it
      if (room.participants.length === 0) {
        rooms.delete(roomId);
      } else {
        io.to(roomId).emit('room-updated', {
          participants: room.participants,
          host: room.host
        });
      }
    }
    
    console.log(`User ${socket.id} left room ${roomId}`);
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

  // Video control events
  socket.on('video-play', (roomId) => {
    const room = rooms.get(roomId);
    if (room && room.host === socket.id) {
      room.isPlaying = true;
      socket.to(roomId).emit('video-play');
    }
  });

  socket.on('video-pause', (roomId) => {
    const room = rooms.get(roomId);
    if (room && room.host === socket.id) {
      room.isPlaying = false;
      socket.to(roomId).emit('video-pause');
    }
  });

  socket.on('video-seek', (data) => {
    const room = rooms.get(data.roomId);
    if (room && room.host === socket.id) {
      room.currentTime = data.time;
      socket.to(data.roomId).emit('video-seek', { time: data.time });
    }
  });

  // Video metadata for P2P streaming
  socket.on('video-metadata', (data) => {
    const room = rooms.get(data.roomId);
    if (room && room.host === socket.id) {
      room.videoFile = {
        name: data.name,
        size: data.size,
        type: data.type
      };
      socket.to(data.roomId).emit('video-metadata', {
        name: data.name,
        size: data.size,
        type: data.type
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Remove user from all rooms
    for (const [roomId, room] of rooms.entries()) {
      if (room.participants.includes(socket.id)) {
        room.participants = room.participants.filter(id => id !== socket.id);
        
        if (room.host === socket.id && room.participants.length > 0) {
          room.host = room.participants[0];
        }
        
        if (room.participants.length === 0) {
          rooms.delete(roomId);
        } else {
          io.to(roomId).emit('room-updated', {
            participants: room.participants,
            host: room.host
          });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 