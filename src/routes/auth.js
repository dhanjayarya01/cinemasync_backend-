import express from 'express';
import {
  googleAuth,
  getProfile,
  updateProfile,
  logout,
  getOnlineUsers,
  updateOnlineStatus
} from '../controllers/authController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Google OAuth
router.post('/google', googleAuth);

// Protected routes
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.post('/logout', authenticateToken, logout);
router.get('/online-users', authenticateToken, getOnlineUsers);
router.put('/online-status', authenticateToken, updateOnlineStatus);

export default router; 