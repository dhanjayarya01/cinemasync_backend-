import express from 'express';
import {
  createRoom,
  getRooms,
  getRoom,
  updateRoom,
  deleteRoom,
  joinRoom,
  leaveRoom,
  getUserRooms
} from '../controllers/roomController.js';
import { authenticateToken, isRoomHost, isRoomParticipant } from '../middleware/auth.js';

const router = express.Router();

// Public routes (with optional auth)
router.get('/', getRooms);
router.get('/:roomId', getRoom);

// Protected routes
router.post('/', authenticateToken, createRoom);
router.put('/:roomId', authenticateToken, isRoomHost, updateRoom);
router.delete('/:roomId', authenticateToken, isRoomHost, deleteRoom);
router.post('/:roomId/join', authenticateToken, joinRoom);
router.post('/:roomId/leave', authenticateToken, isRoomParticipant, leaveRoom);
router.get('/user/rooms', authenticateToken, getUserRooms);

export default router; 