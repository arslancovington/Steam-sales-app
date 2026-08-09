import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    tgId: {
      type: Number,
      required: true,
      unique: true,
    },
    username: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model("User", userSchema);

export default User;
