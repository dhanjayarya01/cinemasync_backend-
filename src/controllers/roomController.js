import Room from '../models/Room.js';
import User from '../models/User.js';

// Create a new room
export const createRoom = async (req, res) => {
  try {
    const {
      name,
      description,
      movieName,
      movieYear,
      moviePoster,
      movieDuration,
      movieGenre,
      isPrivate,
      password,
      maxParticipants,
      tags,
      settings
    } = req.body;

    // Validate required fields
    if (!name || !movieName) {
      return res.status(400).json({
        success: false,
        error: 'Room name and movie name are required'
      });
    }

    // Create room
    const room = new Room({
      name,
      description,
      host: req.user.id,
      movie: {
        name: movieName,
        year: movieYear,
        poster: moviePoster,
        duration: movieDuration,
        genre: movieGenre
      },
      isPrivate,
      password,
      maxParticipants: maxParticipants || 50,
      tags: tags || [],
      settings: settings || {}
    });

    // Add host as first participant
    await room.addParticipant(req.user.id, true);

    await room.save();

    // Update user stats
    await User.findByIdAndUpdate(req.user.id, {
      $inc: { 'stats.roomsCreated': 1 }
    });

    // Populate host info
    await room.populate('host', 'name picture');

    res.status(201).json({
      success: true,
      room: {
        id: room._id,
        name: room.name,
        description: room.description,
        host: {
          id: room.host._id,
          name: room.host.name,
          picture: room.host.picture
        },
        movie: room.movie,
        isPrivate: room.isPrivate,
        maxParticipants: room.maxParticipants,
        currentParticipants: room.currentParticipants,
        status: room.status,
        tags: room.tags,
        settings: room.settings,
        createdAt: room.createdAt
      }
    });

  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create room'
    });
  }
};

// Get all public rooms
export const getRooms = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const skip = (page - 1) * limit;

    let query = { isPrivate: false };
    
    if (status) {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { 'movie.name': { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } }
      ];
    }

    const rooms = await Room.find(query)
      .populate('host', 'name picture')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Room.countDocuments(query);

    res.json({
      success: true,
      rooms: rooms.map(room => ({
        id: room._id,
        name: room.name,
        description: room.description,
        host: {
          id: room.host._id,
          name: room.host.name,
          picture: room.host.picture
        },
        movie: room.movie,
        isPrivate: room.isPrivate,
        maxParticipants: room.maxParticipants,
        currentParticipants: room.currentParticipants,
        status: room.status,
        tags: room.tags,
        createdAt: room.createdAt
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get rooms error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get rooms'
    });
  }
};

// Get room by ID
export const getRoom = async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findById(roomId)
      .populate('host', 'name picture')
      .populate('participants.user', 'name picture');

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    // Check if user can join (only if user is authenticated)
    let canJoin = { canJoin: true };
    if (req.user && req.user.id) {
      canJoin = room.canUserJoin(req.user.id);
    }

    res.json({
      success: true,
      room: {
        id: room._id,
        name: room.name,
        description: room.description,
        host: {
          id: room.host._id,
          name: room.host.name,
          picture: room.host.picture
        },
        movie: room.movie,
        videoFile: room.videoFile,
        isPrivate: room.isPrivate,
        maxParticipants: room.maxParticipants,
        currentParticipants: room.currentParticipants,
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
        })),
        tags: room.tags,
        stats: room.stats,
        createdAt: room.createdAt
      },
      canJoin
    });

  } catch (error) {
    console.error('Get room error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get room'
    });
  }
};

// Update room
export const updateRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const updateData = req.body;

    const room = await Room.findById(roomId);

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    // Check if user is the host
    if (room.host.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Only the host can update the room'
      });
    }

    // Update room
    const updatedRoom = await Room.findByIdAndUpdate(
      roomId,
      updateData,
      { new: true, runValidators: true }
    ).populate('host', 'name picture');

    res.json({
      success: true,
      room: {
        id: updatedRoom._id,
        name: updatedRoom.name,
        description: updatedRoom.description,
        host: {
          id: updatedRoom.host._id,
          name: updatedRoom.host.name,
          picture: updatedRoom.host.picture
        },
        movie: updatedRoom.movie,
        isPrivate: updatedRoom.isPrivate,
        maxParticipants: updatedRoom.maxParticipants,
        currentParticipants: updatedRoom.currentParticipants,
        status: updatedRoom.status,
        settings: updatedRoom.settings,
        tags: updatedRoom.tags
      }
    });

  } catch (error) {
    console.error('Update room error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update room'
    });
  }
};

// Delete room
export const deleteRoom = async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findById(roomId);

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    // Check if user is the host
    if (room.host.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Only the host can delete the room'
      });
    }

    await Room.findByIdAndDelete(roomId);

    res.json({
      success: true,
      message: 'Room deleted successfully'
    });

  } catch (error) {
    console.error('Delete room error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete room'
    });
  }
};

// Join room
export const joinRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { password } = req.body;

    const room = await Room.findById(roomId)
      .populate('host', 'name picture');

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    // Check if room is private and password is required
    if (room.isPrivate && room.password && room.password !== password) {
      return res.status(403).json({
        success: false,
        error: 'Invalid password'
      });
    }

    // Check if user can join
    const canJoin = room.canUserJoin(req.user.id);
    if (!canJoin.canJoin) {
      return res.status(403).json({
        success: false,
        error: canJoin.reason
      });
    }

    // Add user to room
    await room.addParticipant(req.user.id);

    // Update user stats
    await User.findByIdAndUpdate(req.user.id, {
      $inc: { 'stats.roomsJoined': 1 }
    });

    res.json({
      success: true,
      room: {
        id: room._id,
        name: room.name,
        host: {
          id: room.host._id,
          name: room.host.name,
          picture: room.host.picture
        },
        movie: room.movie,
        currentParticipants: room.currentParticipants,
        status: room.status
      }
    });

  } catch (error) {
    console.error('Join room error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to join room'
    });
  }
};

// Leave room
export const leaveRoom = async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findById(roomId);

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    // Remove user from room
    await room.removeParticipant(req.user.id);

    res.json({
      success: true,
      message: 'Left room successfully'
    });

  } catch (error) {
    console.error('Leave room error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to leave room'
    });
  }
};

// Get user's rooms
export const getUserRooms = async (req, res) => {
  try {
    const rooms = await Room.find({
      'participants.user': req.user.id,
      'participants.isActive': true
    })
    .populate('host', 'name picture')
    .sort({ updatedAt: -1 });

    res.json({
      success: true,
      rooms: rooms.map(room => ({
        id: room._id,
        name: room.name,
        host: {
          id: room.host._id,
          name: room.host.name,
          picture: room.host.picture
        },
        movie: room.movie,
        status: room.status,
        currentParticipants: room.currentParticipants,
        createdAt: room.createdAt
      }))
    });

  } catch (error) {
    console.error('Get user rooms error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user rooms'
    });
  }
}; 