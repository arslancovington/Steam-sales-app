import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import http from "http";
import fs from "fs";
import path from "path";

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  throw new Error("BOT_TOKEN environment variable is required.");
}

const APP_URL = process.env.WEBAPP_URL || "https://steam-sales-app.onrender.com";
const PORT = process.env.PORT || 3000;

// Хранилища в памяти сервера (работают быстро и без ошибок с БД)
let serverUsers = [];
let serverMarketItems = [];
let serverDeals = [];

// === ВЕБ-СЕРВЕР ===
const server = http.createServer(async (req, res) => {
  
  // Редирект на Steam OpenID
  if (req.url === "/auth/steam") {
    const returnTo = `${APP_URL}/auth/steam/return`;
    const realm = APP_URL;
    const steamOpenIdUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(returnTo)}&openid.realm=${encodeURIComponent(realm)}&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;

    res.writeHead(302, { Location: steamOpenIdUrl });
    res.end();
    return;
  }

  // Возврат от Steam
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

  // Получение товаров маркетплейса
  if (req.url === "/api/market/items" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, items: serverMarketItems }));
    return;
  }

  // Добавление товара на маркет
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
        serverMarketItems.unshift(newItem);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, item: newItem }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Покупка товара и создание сделки
  if (req.url === "/api/deals/buy" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { itemId, buyerName } = JSON.parse(body);
        const itemIndex = serverMarketItems.findIndex(i => i._id === itemId);
        
        if (itemIndex === -1) {
          throw new Error("Товар уже куплен или удален");
        }

        const purchasedItem = serverMarketItems.splice(itemIndex, 1)[0];

        const newDeal = {
          id: Date.now().toString(),
          name: purchasedItem.name,
          price: purchasedItem.price,
          seller: purchasedItem.seller,
          buyer: buyerName || "Покупатель",
          status: "waiting_transfer",
          image: purchasedItem.image,
          createdAt: new Date()
        };

        serverDeals.unshift(newDeal);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deal: newDeal }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Получение списка сделок
  if (req.url === "/api/deals/list" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, deals: serverDeals }));
    return;
  }

  // Запрос инвентаря CS2
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

  // Отдача index.html
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

// === ТЕЛЕГРАМ БОТ ===
const bot = new TelegramBot(botToken, { polling: true });

bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const from = msg.from;

    if (!from) return;

    // Сохраняем пользователя в память
    if (!serverUsers.some(u => u.tgId === from.id)) {
      serverUsers.push({ tgId: from.id, username: from.username || "" });
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
