// models/price.js
import mongoose from "mongoose";

const PriceSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  prices: [
    {
      grade: { type: Number, required: true },
      price: { type: String, required: true },
      _id: false,
    },
  ],
});

const Price = mongoose.models.Price || mongoose.model("Price", PriceSchema);
export default Price;
