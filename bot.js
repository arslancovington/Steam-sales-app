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

// Инициализация Telegram бота
const bot = new TelegramBot(botToken, { polling: true });

// Хранилища в памяти сервера
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

  // Добавление товара на маркет + уведомление в чат бота
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

        // Отправка уведомления продавцу в Telegram
        if (itemData.tgId) {
          await bot.sendMessage(
            itemData.tgId,
            `✅ **Предмет успешно выставлен на продажу!**\n\n` +
            `🎯 Предмет: *${newItem.name}*\n` +
            `💰 Стоимость: *${newItem.price} ₽*\n` +
            `⏳ Статус: Активен на маркетплейсе\n\n` +
            `⚠️ *Не удаляйте предмет из инвентаря Steam*, пока он выставлен на продажу.`,
            { parse_mode: "Markdown" }
          );
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, item: newItem }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Выставление счета на пополнение баланса (как на скриншоте)
  if (req.url === "/api/billing/invoice" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { tgId, amount, currency, received } = JSON.parse(body);
        const invoiceId = Math.floor(1000000 + Math.random() * 9000000);

        if (tgId) {
          await bot.sendMessage(
            tgId,
            `💡 **Счет на оплату ${currency} выставлен** 💡\n\n` +
            `💳 Сумма к оплате: *${amount} ${currency}*\n` +
            `🆔 ID платежа: *${invoiceId}*\n` +
            `💎 Получите: *${received} ₽*\n\n` +
            `❗ **Оплачивайте ровно ту сумму** на которую создали платеж и только на те реквизиты, которые получили. Оплата на другие реквизиты или неверная сумма вызовет потерю платежа.\n\n` +
            `⏳ Среднее время зачисления депозита — **до 30 минут** после оплаты.`,
            { parse_mode: "Markdown" }
          );
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, invoiceId }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Запрос на вывод средств
  if (req.url === "/api/billing/withdraw" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { tgId, amount, recipientId } = JSON.parse(body);
        const withdrawId = Math.floor(1000000 + Math.random() * 9000000);

        if (tgId) {
          await bot.sendMessage(
            tgId,
            `📤 **Заявка на вывод средств создана**\n\n` +
            `🆔 ID заявки: *${withdrawId}*\n` +
            `💵 Сумма: *${amount} ₽*\n` +
            `👤 Получатель (TG ID): *${recipientId}*\n` +
            `⏳ Статус: *В обработке администратором*`,
            { parse_mode: "Markdown" }
          );
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, withdrawId }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Покупка товара и уведомления в чат продавцу
  if (req.url === "/api/deals/buy" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { itemId, buyerName, buyerTgId } = JSON.parse(body);
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
          sellerTgId: purchasedItem.tgId,
          buyer: buyerName || "Покупатель",
          buyerTgId: buyerTgId,
          status: "waiting_transfer",
          image: purchasedItem.image,
          createdAt: new Date()
        };

        serverDeals.unshift(newDeal);

        // Уведомление продавцу в Telegram (если известен его tgId)
        if (purchasedItem.tgId) {
          await bot.sendMessage(
            purchasedItem.tgId,
            `🛒 **У вас купили предмет!**\n\n` +
            `🎯 Предмет: *${purchasedItem.name}*\n` +
            `💰 Стоимость: *${purchasedItem.price} ₽*\n` +
            `👤 Покупатель: *${buyerName}*\n\n` +
            `⏳ *Статус:* Требуется передача скина в Steam. Зайдите в приложение во вкладку «Сделки».`,
            { parse_mode: "Markdown" }
          );
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deal: newDeal }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
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
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const from = msg.from;

    if (!from) return;

    await bot.sendMessage(
      chatId,
      `Привет, ${from.first_name}! 🎮\n\nДобро пожаловать в P2P маркетплейс скинов CS2. Все уведомления о сделках, выставлении счетов и пополнении баланса будут приходить сюда.`,
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
