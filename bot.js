import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import mongoose from "mongoose";
import { logger } from "./lib/logger.js";

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  throw new Error("BOT_TOKEN environment variable is required.");
}

// Создаем модель пользователя прямо здесь, чтобы не плодить файлы и папки
const userSchema = new mongoose.Schema(
  {
    tgId: { type: Number, required: true, unique: true },
    username: { type: String, default: "" },
  },
  { timestamps: true }
);

// Защита от повторной компиляции модели, если файл перезагрузится
const User = mongoose.models.User || mongoose.model("User", userSchema);

const bot = new TelegramBot(botToken, { polling: true });

bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const from = msg.from;

    if (!from) {
      return;
    }

    // Сохраняем или находим пользователя в базе данных
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
    logger.error(error);
  }
});
