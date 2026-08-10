import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import mongoose from "mongoose";
import http from "http";
import fs from "fs";
import path from "path";

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  throw new Error("BOT_TOKEN environment variable is required.");
}

// === 1. ВЕБ-СЕРВЕР ДЛЯ ОТКРЫТИЯ INDEX.HTML ===
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Путь к вашему index.html в корне проекта
  const filePath = path.join(process.cwd(), "index.html");

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Файл index.html не найден в корне проекта!</h1>");
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// === 2. МОДЕЛЬ ПОЛЬЗОВАТЕЛЯ ===
const userSchema = new mongoose.Schema(
  {
    tgId: { type: Number, required: true, unique: true },
    username: { type: String, default: "" },
  },
  { timestamps: true }
);

const User = mongoose.models.User || mongoose.model("User", userSchema);

// === 3. ЛОГИКА БОТА ===
const bot = new TelegramBot(botToken, { polling: true });

bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const from = msg.from;

    if (!from) return;

    let user = await User.findOne({ tgId: from.id });

    if (!user) {
      user = await User.create({
        tgId: from.id,
        username: from.username || "",
      });
    }

    await bot.sendMessage(
      chatId,
      `Привет, ${from.first_name}! 🎮\n\nДобро пожаловать в P2P маркетплейс скинов CS2. Нажми кнопку ниже, чтобы открыть маркет.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛒 Открыть Маркет", web_app: { url: process.env.WEBAPP_URL } }],
          ],
        },
      }
    );
  } catch (error) {
    console.error("Ошибка:", error);
  }
});
