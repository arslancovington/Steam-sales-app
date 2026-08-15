import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "node:crypto";
import connectDB from "./database.js";
import User from "./models/User.js";
import Listing from "./models/Listing.js";
import Deal from "./models/Deal.js";
import { logger } from "./lib/logger.js";

const app = express();

app.use(cors());
app.use(express.json());

function verifyTelegramWebAppData(telegramInitData) {
  if (!telegramInitData || !process.env.BOT_TOKEN) {
    return false;
  }

  const initData = new URLSearchParams(telegramInitData);
  const hash = initData.get("hash");

  if (!hash) {
    return false;
  }

  initData.delete("hash");

  const dataToCheck = [];
  initData.sort();
  initData.forEach((value, key) => {
    dataToCheck.push(`${key}=${value}`);
  });

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN)
    .digest();
  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataToCheck.join("\n"))
    .digest("hex");

  const expectedHash = Buffer.from(calculatedHash, "utf8");
  const receivedHash = Buffer.from(hash, "utf8");

  return (
    expectedHash.length === receivedHash.length &&
    crypto.timingSafeEqual(expectedHash, receivedHash)
  );
}

async function authMiddleware(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];
  const tgIdHeader = req.headers["x-telegram-id"];

  if (process.env.NODE_ENV === "development" && tgIdHeader) {
