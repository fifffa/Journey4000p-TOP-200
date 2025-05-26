import mongoose from "mongoose";

const specificitySchema = new mongoose.Schema({
  특성이름: String,
  url: String,
});

export default mongoose.model("Specificity", specificitySchema);
