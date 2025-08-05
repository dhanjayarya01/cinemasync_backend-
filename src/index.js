import express from 'express';
import http from 'http';
import { Server as socketIo } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';


const app = express();
const server = http.createServer(app);

// Setup Socket.io
const io = new socketIo(server, {
  cors: {
    origin: "http://localhost:3000", // Frontend origin
    methods: ["GET", "POST"]
  }
});



app.use(cors());
app.use(express.json());


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