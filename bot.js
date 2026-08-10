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

// Твоя ссылка на Render (важно для возврата от Steam)
// Убедись, что переменная WEBAPP_URL задана в Render (например: https://steam-sales-app.onrender.com)
const APP_URL = process.env.WEBAPP_URL || "https://steam-sales-app.onrender.com";
const PORT = process.env.PORT || 3000;

// === 1. ВЕБ-СЕРВЕР И АВТОРИЗАЦИЯ STEAM ===
const server = http.createServer(async (req, res) => {
  
  // 1.1 РОУТ: Редирект на официальную страницу входа Steam
  if (req.url === "/auth/steam") {
    const returnTo = `${APP_URL}/auth/steam/return`;
    const realm = APP_URL;
    const steamOpenIdUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(returnTo)}&openid.realm=${encodeURIComponent(realm)}&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;

    res.writeHead(302, { Location: steamOpenIdUrl });
    res.end();
    return;
  }

  // 1.2 РОУТ: Возврат пользователя от Steam после успешного входа
  if (req.url.startsWith("/auth/steam/return")) {
    const url = new URL(req.url, APP_URL);
    const claimedId = url.searchParams.get("openid.claimed_id");

    if (claimedId) {
      // Достаем SteamID (последние цифры ссылки, например 765611980...)
      const steamId = claimedId.split("/").pop();
      // Перенаправляем обратно на сайт, передавая SteamID в адресной строке
      res.writeHead(302, { Location: `/?steamId=${steamId}` });
      res.end();
    } else {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Ошибка авторизации Steam. Попробуйте еще раз.</h1>");
    }
    return;
  }

  // 1.3 РОУТ: Запрос настоящего инвентаря CS2
  if (req.url === "/api/steam/inventory" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const steamId = data.steamId;

        if (!steamId) throw new Error("Не передан SteamID");

        // Реальный запрос к серверам Steam (AppID 730 = CS2, Context 2)
        const response = await fetch(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=100`);
        
        if (!response.ok) throw new Error("Инвентарь скрыт настройками приватности Steam");

        const steamData = await response.json();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          items: steamData.assets || [],
          descriptions: steamData.descriptions || []
        }));
      } catch (error) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // 1.4 РОУТ: Отдаем интерфейс (index.html) для всех остальных запросов
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
const userSchema = new mongoose.Schema({
  tgId: { type: Number, required: true, unique: true },
  username: { type: String, default: "" },
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model("User", userSchema);

// === 3. ЛОГИКА ТЕЛЕГРАМ БОТА ===
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
            [{ text: "🛒 Открыть Маркет", web_app: { url: APP_URL } }],
          ],
        },
      }
    );
  } catch (error) {
    console.error("Ошибка в боте:", error);
  }
});
