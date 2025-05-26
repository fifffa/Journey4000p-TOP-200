import mongoose from "mongoose";

const seasonIdSchema = new mongoose.Schema({
  seasonId: {
    type: Number,
    required: true, // require -> required
  },
  className: {
    type: String,
    required: true, // require -> required
  },
  seasonImg: {
    type: String,
    required: true, // require -> required
  },
  seasonCard: {
    type: String,
    required: true, // require -> required
  },
});

export default mongoose.model("SeasonId", seasonIdSchema);
