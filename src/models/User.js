import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  googleId: {
    type: String,
    required: true,
    unique: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  picture: {
    type: String,
    default: null
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  preferences: {
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'dark'
    },
    notifications: {
      type: Boolean,
      default: true
    }
  },
  stats: {
    roomsCreated: {
      type: Number,
      default: 0
    },
    roomsJoined: {
      type: Number,
      default: 0
    },
    totalWatchTime: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true
});

// Index for better query performance
userSchema.index({ isOnline: 1 });

// Virtual for user's display name
userSchema.virtual('displayName').get(function() {
  return this.name || this.email.split('@')[0];
});

// Method to update online status
userSchema.methods.updateOnlineStatus = function(isOnline) {
  this.isOnline = isOnline;
  this.lastSeen = new Date();
  return this.save();
};

// Method to update stats
userSchema.methods.updateStats = function(type, value = 1) {
  if (this.stats[type] !== undefined) {
    this.stats[type] += value;
  }
  return this.save();
};

// Static method to find or create user from Google OAuth
userSchema.statics.findOrCreateFromGoogle = async function(googleData) {
  const { sub: googleId, email, name, picture } = googleData;
  
  let user = await this.findOne({ googleId });
  
  if (!user) {
    user = new this({
      googleId,
      email,
      name,
      picture,
      isOnline: true
    });
  } else {
    // Update existing user info
    user.name = name;
    user.picture = picture;
    user.email = email;
    user.isOnline = true;
    user.lastSeen = new Date();
  }
  
  await user.save();
  return user;
};

const User = mongoose.model('User', userSchema);

export default User; 