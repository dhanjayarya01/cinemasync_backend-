import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// Middleware to verify JWT token
export const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ 
        success: false,
        error: 'Access token required' 
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user from database
    const user = await User.findById(decoded.id).select('-googleId');
    
    if (!user) {
      return res.status(403).json({ 
        success: false,
        error: 'Invalid or expired token' 
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(403).json({ 
      success: false,
      error: 'Invalid or expired token' 
    });
  }
};

// Optional authentication middleware
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-googleId');
      if (user) {
        req.user = user;
      }
    }
    
    next();
  } catch (error) {
    // Continue without authentication
    next();
  }
};

// Check if user is room host
export const isRoomHost = async (req, res, next) => {
  try {
    const { roomId } = req.params;
    
    const room = await Room.findById(roomId);
    
    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    if (room.host.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Only the host can perform this action'
      });
    }

    req.room = room;
    next();
  } catch (error) {
    console.error('Is room host middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// Check if user is room participant
export const isRoomParticipant = async (req, res, next) => {
  try {
    const { roomId } = req.params;
    
    const room = await Room.findById(roomId);
    
    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    const isParticipant = room.participants.some(
      p => p.user.toString() === req.user.id && p.isActive
    );

    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        error: 'You must be a participant to perform this action'
      });
    }

    req.room = room;
    next();
  } catch (error) {
    console.error('Is room participant middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
}; 