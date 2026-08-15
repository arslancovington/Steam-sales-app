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

// Функция проверки подлинности данных от Telegram WebApp
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

// Middleware авторизации с поддержкой режима разработки и Telegram WebApp
async function authMiddleware(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];
  const tgIdHeader = req.headers["x-telegram-id"];

  // Разработка: если передан заголовок с ID в режиме dev
  if (process.env.NODE_ENV === "development" && tgIdHeader) {
    req.userTgId = tgIdHeader;
    return next();
  }

  // Проверка через защищенный хэш Telegram WebApp
  if (initData && verifyTelegramWebAppData(initData)) {
    try {
      const urlParams = new URLSearchParams(initData);
      const userParam = urlParams.get("user");
      if (userParam) {
        const userObj = JSON.parse(userParam);
        req.userTgId = String(userObj.id);
        return next();
      }
    } catch (e) {
      logger.error("Error parsing telegram user data: " + e.message);
    }
  }

  return res.status(401).json({ success: false, error: "Unauthorized: Invalid Telegram data" });
}

// Базовый маршрут для проверки работы сервера
app.get("/", (req, res) => {
  res.json({ success: true, message: "P2P Market API is running" });
});

// Пример защищенного маршрута профиля
app.get("/api/user/profile", authMiddleware, async (req, res) => {
  try {
    let user = await User.findOne({ tgId: req.userTgId });
    if (!user) {
      user = await User.create({ tgId: req.userTgId, balance: 0, rating: 5.0, completedDeals: 0 });
    }
    res.json({ success: true, ...user.toObject() });
  } catch (err) {
    logger.error("Profile fetch error: " + err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;

// Подключаем базу данных и запускаем сервер
connectDB().then(() => {
  app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
  });
}).catch(err => {
  logger.error("Database connection failed: " + err.message);
});
