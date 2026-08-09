import mongoose from "mongoose";
import { logger } from "./lib/logger.js";

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
      throw new Error("MONGODB_URI environment variable is required.");
    }

    await mongoose.connect(mongoUri);
    logger.info("База данных успешно подключена!");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, `Ошибка подключения к базе данных: ${message}`);
    process.exit(1);
  }
};

export default connectDB;
