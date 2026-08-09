import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import User from "./User.js";
import { logger } from "./lib/logger.js";

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  throw new Error("BOT_TOKEN environment variable is required.");
}

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
    logger.error(error);
  }
});
