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

const APP_URL = process.env.WEBAPP_URL || "https://steam-sales-app.onrender.com";
const PORT = process.env.PORT || 3000;

// === 1. ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ MONGODB ===
const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/steam_sales";
mongoose.connect(mongoUri)
  .then(() => console.log("MongoDB connected successfully"))
  .catch(err => console.error("MongoDB connection error:", err));

// === 2. МОДЕЛИ ДАННЫХ ===
const userSchema = new mongoose.Schema({
  tgId: { type: Number, required: true, unique: true },
  username: { type: String, default: "" },
  tradeUrl: { type: String, default: "" },
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model("User", userSchema);

// Временный массив в памяти сервера для мгновенной публикации и показа лотов всем пользователям
let serverMarketItems = [];

// === 3. ВЕБ-СЕРВЕР ===
const server = http.createServer(async (req, res) => {
  
  // 3.1 Редирект на Steam OpenID
  if (req.url === "/auth/steam") {
    const returnTo = `${APP_URL}/auth/steam/return`;
    const realm = APP_URL;
    const steamOpenIdUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(returnTo)}&openid.realm=${encodeURIComponent(realm)}&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;

    res.writeHead(302, { Location: steamOpenIdUrl });
    res.end();
    return;
  }

  // 3.2 Возврат от Steam
  if (req.url.startsWith("/auth/steam/return")) {
    const url = new URL(req.url, APP_URL);
    const claimedId = url.searchParams.get("openid.claimed_id");

    if (claimedId) {
      const steamId = claimedId.split("/").pop();
      res.writeHead(302, { Location: `/?steamId=${steamId}` });
      res.end();
    } else {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Ошибка авторизации Steam.</h1>");
    }
    return;
  }

  // 3.3 Получение всех товаров маркетплейса
  if (req.url === "/api/market/items" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, items: serverMarketItems }));
    return;
  }

  // 3.4 Добавление товара на маркет
  if (req.url === "/api/market/add" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const itemData = JSON.parse(body);
        const newItem = {
          _id: Date.now().toString(),
          ...itemData,
          createdAt: new Date()
        };
        serverMarketItems.unshift(newItem); // Добавляем товар в начало списка
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, item: newItem }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 3.5 Запрос инвентаря CS2
  if (req.url === "/api/steam/inventory" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const steamId = data.steamId;

        if (!steamId) throw new Error("Не передан SteamID");

        const response = await fetch(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=100`);
        
        if (!response.ok) {
          throw new Error("Инвентарь скрыт или профиль закрыт настройками приватности Steam");
        }

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

  // 3.6 Отдача index.html
  const filePath = path.join(process.cwd(), "index.html");
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Файл index.html не найден!</h1>");
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// === 4. ТЕЛЕГРАМ БОТ ===
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
