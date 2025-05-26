import mongoose from "mongoose";
import data from "../seed/test3-json.json" assert { type: "json" };
import SeasonId from "./seasonId.js";
import Specificity from "./specificity.js";
import Price from "./price.js";

const ablityKey = Object.keys(data[0].능력치);

const 능력치Schema = new mongoose.Schema({}, { _id: false });

ablityKey.forEach((key) => {
  능력치Schema.add({
    [key]: {
      type: Object,
      required: true,
      포지션능력치: {
        type: Object,
        required: true,
        주포지션: {
          type: [String],
          required: true,
        },
        포지션최고능력치: {
          type: String,
          required: true,
        },
      },
    },
  });
});

const PlayerReportsSchema = new mongoose.Schema({
  id: {
    type: Number,
    required: true,
    unique: true,
  },
  name: {
    type: String,
    required: true,
  },
  선수이미지: {
    type: String,
  },
  선수정보: {
    신체정보: {
      birth: Date,
      height: String,
      weight: String,
      physical: String,
      skill: String,
      foot: String,
      mainfoot: String,
    },
    급여: {
      type: Number,
      required: true,
    },
    국적: {
      국적: String,
      국적이미지: String,
    },
    특성: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Specificity",
      },
    ],
    클럽경력: {
      type: [String],
      required: true,
    },
    시즌이미지: {
      시즌이미지: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SeasonId",
      },
      시즌빅이미지: String,
    },
    prices: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Price",
    },
    특성컬러: Array,
  },
  능력치: 능력치Schema,
});

const PlayerReport =
  mongoose.models.PlayerReport ||
  mongoose.model("PlayerReport", PlayerReportsSchema);

export default PlayerReport;
