import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import mongoose from "mongoose";
import http from "http"; // Встроенный модуль для создания веб-сервера

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  throw new Error("BOT_TOKEN environment variable is required.");
}

// === 1. ЗАПУСКАЕМ ВЕБ-СЕРВЕР ДЛЯ RENDER ===
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h1>Сайт работает! Бот запущен.</h1><p>Здесь будет интерфейс вашего маркета.</p>");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Web server is listening on port ${PORT}`);
});

// === 2. ОСНОВНОЙ КОД БОТА ===
const userSchema = new mongoose.Schema(
  {
    tgId: { type: Number, required: true, unique: true },
    username: { type: String, default: "" },
  },
  { timestamps: true }
);

const User = mongoose.models.User || mongoose.model("User", userSchema);

const bot = new TelegramBot(botToken, { polling: true });

bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const from = msg.from;

    if (!from) {
      return;
    }

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
            [
              {
                text: "🛒 Открыть Маркет",
                web_app: { url: process.env.WEBAPP_URL },
              },
            ],
          ],
        },
      },
    );
  } catch (error) {
    console.error("Error in /start handler:", error);
  }
});
