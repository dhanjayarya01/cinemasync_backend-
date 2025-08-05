import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  movie: {
    name: {
      type: String,
      required: true,
      trim: true
    },
    year: {
      type: Number,
      default: null
    },
    poster: {
      type: String,
      default: null
    },
    duration: {
      type: Number, // in minutes
      default: 0
    },
    genre: {
      type: String,
      default: ''
    }
  },
  videoFile: {
    name: {
      type: String,
      default: null
    },
    size: {
      type: Number,
      default: 0
    },
    type: {
      type: String,
      default: null
    },
    url: {
      type: String,
      default: null
    }
  },
  isPrivate: {
    type: Boolean,
    default: false
  },
  password: {
    type: String,
    default: null
  },
  maxParticipants: {
    type: Number,
    default: 50,
    min: 1,
    max: 100
  },
  currentParticipants: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['waiting', 'playing', 'paused', 'ended'],
    default: 'waiting'
  },
  playbackState: {
    isPlaying: {
      type: Boolean,
      default: false
    },
    currentTime: {
      type: Number,
      default: 0
    },
    duration: {
      type: Number,
      default: 0
    },
    lastUpdated: {
      type: Date,
      default: Date.now
    }
  },
  settings: {
    allowChat: {
      type: Boolean,
      default: true
    },
    allowVideoUpload: {
      type: Boolean,
      default: true
    },
    autoPlay: {
      type: Boolean,
      default: false
    },
    syncTolerance: {
      type: Number,
      default: 5 // seconds
    }
  },
  participants: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    isHost: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: true
    },
    lastSeen: {
      type: Date,
      default: Date.now
    }
  }],
  tags: [{
    type: String,
    trim: true
  }],
  stats: {
    totalViews: {
      type: Number,
      default: 0
    },
    totalWatchTime: {
      type: Number,
      default: 0
    },
    peakParticipants: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true
});

// Indexes for better query performance
roomSchema.index({ host: 1 });
roomSchema.index({ status: 1 });
roomSchema.index({ isPrivate: 1 });
roomSchema.index({ 'movie.name': 1 });
roomSchema.index({ createdAt: -1 });
roomSchema.index({ tags: 1 });

// Virtual for room URL
roomSchema.virtual('roomUrl').get(function() {
  return `/theater/${this._id}`;
});

// Virtual for host info
roomSchema.virtual('hostInfo').get(function() {
  return {
    id: this.host._id,
    name: this.host.name,
    picture: this.host.picture
  };
});

// Method to add participant
roomSchema.methods.addParticipant = async function(userId) {
  const existingParticipant = this.participants.find(p => p.user.toString() === userId.toString());
  
  if (!existingParticipant) {
    this.participants.push({
      user: userId,
      joinedAt: new Date(),
      isActive: true,
      lastSeen: new Date()
    });
    this.currentParticipants = this.participants.filter(p => p.isActive).length;
    this.stats.peakParticipants = Math.max(this.stats.peakParticipants, this.currentParticipants);
  } else {
    existingParticipant.isActive = true;
    existingParticipant.lastSeen = new Date();
  }
  
  return this.save();
};

// Method to remove participant
roomSchema.methods.removeParticipant = async function(userId) {
  const participant = this.participants.find(p => p.user.toString() === userId.toString());
  if (participant) {
    participant.isActive = false;
    participant.lastSeen = new Date();
    this.currentParticipants = this.participants.filter(p => p.isActive).length;
  }
  return this.save();
};

// Method to update playback state
roomSchema.methods.updatePlaybackState = async function(playbackData) {
  this.playbackState = {
    ...this.playbackState,
    ...playbackData,
    lastUpdated: new Date()
  };
  
  if (playbackData.isPlaying !== undefined) {
    this.status = playbackData.isPlaying ? 'playing' : 'paused';
  }
  
  return this.save();
};

// Method to check if user can join
roomSchema.methods.canUserJoin = function(userId) {
  if (this.currentParticipants >= this.maxParticipants) {
    return { canJoin: false, reason: 'Room is full' };
  }
  
  if (this.isPrivate && !this.participants.find(p => p.user.toString() === userId.toString())) {
    return { canJoin: false, reason: 'Private room' };
  }
  
  return { canJoin: true };
};

// Static method to get public rooms
roomSchema.statics.getPublicRooms = function(limit = 20, skip = 0) {
  return this.find({ isPrivate: false })
    .populate('host', 'name picture')
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip);
};

// Static method to search rooms
roomSchema.statics.searchRooms = function(query, limit = 20) {
  return this.find({
    $or: [
      { name: { $regex: query, $options: 'i' } },
      { 'movie.name': { $regex: query, $options: 'i' } },
      { tags: { $in: [new RegExp(query, 'i')] } }
    ],
    isPrivate: false
  })
  .populate('host', 'name picture')
  .sort({ createdAt: -1 })
  .limit(limit);
};

const Room = mongoose.model('Room', roomSchema);

export default Room; 