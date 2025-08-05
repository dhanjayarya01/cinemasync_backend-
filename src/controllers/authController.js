import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user._id, 
      email: user.email, 
      name: user.name 
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// Google OAuth verification
export const googleAuth = async (req, res) => {
  try {
    const { credential } = req.body;
    
    if (!credential) {
      return res.status(400).json({ 
        success: false,
        error: 'Google credential is required' 
      });
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    
    // Find or create user
    const user = await User.findOrCreateFromGoogle(payload);
    
    // Generate JWT token
    const token = generateToken(user);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        isOnline: user.isOnline,
        stats: user.stats
      }
    });

  } catch (error) {
    console.error('Google OAuth error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Authentication failed' 
    });
  }
};

// Get user profile
export const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('-googleId -__v');
    
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }
    
    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        isOnline: user.isOnline,
        lastSeen: user.lastSeen,
        preferences: user.preferences,
        stats: user.stats,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get profile' 
    });
  }
};

// Update user profile
export const updateProfile = async (req, res) => {
  try {
    const { name, preferences } = req.body;
    const updateData = {};
    
    if (name) updateData.name = name;
    if (preferences) updateData.preferences = preferences;
    
    const user = await User.findByIdAndUpdate(
      req.user.id,
      updateData,
      { new: true, runValidators: true }
    ).select('-googleId -__v');
    
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }
    
    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        isOnline: user.isOnline,
        preferences: user.preferences,
        stats: user.stats
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update profile' 
    });
  }
};

// Logout user
export const logout = async (req, res) => {
  try {
    // Update user's online status
    await User.findByIdAndUpdate(req.user.id, {
      isOnline: false,
      lastSeen: new Date()
    });
    
    res.json({ 
      success: true, 
      message: 'Logged out successfully' 
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to logout' 
    });
  }
};

// Get online users
export const getOnlineUsers = async (req, res) => {
  try {
    const users = await User.find({ isOnline: true })
      .select('name picture lastSeen')
      .sort({ lastSeen: -1 })
      .limit(50);
    
    res.json({
      success: true,
      users: users.map(user => ({
        id: user._id,
        name: user.name,
        picture: user.picture,
        lastSeen: user.lastSeen
      }))
    });
  } catch (error) {
    console.error('Get online users error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get online users' 
    });
  }
};

// Update online status
export const updateOnlineStatus = async (req, res) => {
  try {
    const { isOnline } = req.body;
    
    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        isOnline,
        lastSeen: new Date()
      },
      { new: true }
    ).select('isOnline lastSeen');
    
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }
    
    res.json({
      success: true,
      isOnline: user.isOnline,
      lastSeen: user.lastSeen
    });
  } catch (error) {
    console.error('Update online status error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update online status' 
    });
  }
}; 