import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import http from "http";
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";

// Инициализация базы данных SQLite
const dbFile = path.join(process.cwd(), "database.db");
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) console.error("Ошибка открытия БД:", err.message);
  else console.log("База данных подключена успешно.");
});

// Создание таблицы для сохранения пользователей
db.run(`CREATE TABLE IF NOT EXISTS users (
  tg_id TEXT PRIMARY KEY,
  tg_user TEXT,
  steam_id TEXT,
  trade_url TEXT,
  balance INTEGER DEFAULT 1500,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const botToken = process.env.BOT_TOKEN;
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const APP_URL = process.env.WEBAPP_URL || "https://steam-sales-app.onrender.com";
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(botToken, { polling: true });
let serverMarketItems = [];
let serverDeals = [];
let withdrawRequests = {};

// Функция создания инвойса Crypto Pay
async function createCryptoInvoice(amountUsdt, description) {
  try {
    const response = await fetch("https://pay.crypt.bot/api/createInvoice", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Crypto-Pay-API-Token": CRYPTO_PAY_TOKEN },
      body: JSON.stringify({ asset: "USDT", amount: String(amountUsdt), description, payload: "topup" })
    });
    const data = await response.json();
    return data.ok ? data.result.pay_url : null;
  } catch (e) { return null; }
}

// Функция перевода средств через Crypto Pay
async function transferCryptoToUser(tgId, amountUsdt, comment) {
  try {
    const response = await fetch("https://pay.crypt.bot/api/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Crypto-Pay-API-Token": CRYPTO_PAY_TOKEN },
      body: JSON.stringify({ user_id: Number(tgId), asset: "USDT", amount: String(amountUsdt), spend_id: `wd_${Date.now()}`, comment })
    });
    const data = await response.json();
    return data.ok ? data.result : null;
  } catch (e) { return null; }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // 1. Исправленный редирект для авторизации через Steam OpenID
  if (req.url === "/auth/steam") {
    const returnTo = `${APP_URL}/auth/steam/return`;
    const realm = APP_URL;
    const steamOpenIdUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(returnTo)}&openid.realm=${encodeURIComponent(realm)}&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;

    res.writeHead(302, { Location: steamOpenIdUrl });
    res.end();
    return;
  }

  // 2. Обработка возврата после успешного входа через Steam
  if (req.url.startsWith("/auth/steam/return")) {
    const url = new URL(req.url, APP_URL);
    const claimedId = url.searchParams.get("openid.claimed_id");

    if (claimedId) {
      const steamId = claimedId.split("/").pop();
      res.writeHead(302, { Location: `/?steamId=${steamId}` });
      res.end();
    } else {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Ошибка авторизации Steam</h1>");
    }
    return;
  }

  // 3. API для сохранения пользователя в базу данных (TG user, TG id, Steam user, Trade url)
  if (req.url === "/api/user/save" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { tgId, tgUser, steamId, tradeUrl } = JSON.parse(body);
        if (tgId) {
          db.run(
            `INSERT INTO users (tg_id, tg_user, steam_id, trade_url) VALUES (?, ?, ?, ?)
             ON CONFLICT(tg_id) DO UPDATE SET 
             tg_user = coalesce(?, tg_user), 
             steam_id = coalesce(?, steam_id), 
             trade_url = coalesce(?, trade_url)`,
            [tgId, tgUser, steamId, tradeUrl, tgUser, steamId, tradeUrl],
            (err) => { if (err) console.error("Ошибка сохранения в БД:", err); }
          );
        }
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // API Маркетплейс
  if (req.url === "/api/market/items" && req.method === "GET") {
    res.end(JSON.stringify({ success: true, items: serverMarketItems }));
    return;
  }
  if (req.url === "/api/market/add" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const item = JSON.parse(body);
      item._id = Date.now().toString();
      serverMarketItems.unshift(item);
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // API Покупка
  if (req.url === "/api/deals/buy" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      const { itemId, buyerTgId, buyerTradeUrl } = JSON.parse(body);
      const idx = serverMarketItems.findIndex(i => i._id === itemId);
      if (idx === -1) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: "Товар уже куплен" })); return; }
      const item = serverMarketItems.splice(idx, 1)[0];
      const dealId = Date.now().toString();
      serverDeals.push({ ...item, id: dealId, buyerTgId, status: 'sent' });
      await bot.sendMessage(item.tgId, `🛒 У вас купили ${item.name}! Ссылка: \`${buyerTradeUrl}\``, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "📤 Я отправил скин", callback_data: `sent_${dealId}` }]] } });
      res.end(JSON.stringify({ success: true, deal: { id: dealId } }));
    });
    return;
  }

  // API Пополнение
  if (req.url === "/api/billing/invoice" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      const { tgId, amount, currency } = JSON.parse(body);
      let payUrl = currency === "USDT" ? await createCryptoInvoice(amount, "Пополнение баланса") : await bot.createInvoiceLink("Пополнение", "Пополнение баланса", "topup", "", "XTR", [{label: "Пополнение", amount: parseInt(amount)}]);
      await bot.sendMessage(tgId, `💡 Счет выставлен: ${amount} ${currency}`, { reply_markup: { inline_keyboard: [[{ text: "💳 Оплатить", url: payUrl }]] } });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // API Вывод
  if (req.url === "/api/billing/withdraw" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      const { tgId, amount, recipientAccount, username } = JSON.parse(body);
      const wdId = Date.now().toString().slice(-7);
      withdrawRequests[wdId] = { tgId, amount, usdtApprox: (Math.round(amount * 0.95) / 90).toFixed(2) };
      if (ADMIN_CHAT_ID) {
        await bot.sendMessage(ADMIN_CHAT_ID, `📤 **Заявка: ${amount} ₽**\n👤 @${username} (ID: \`${tgId}\`)\n🎯 Crypto Bot: \`${recipientAccount}\`\n🆔 \`${wdId}\``, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "✅ Выплатить", callback_data: `wd_ok_${wdId}` }, { text: "❌ Отклонить", callback_data: `wd_no_${wdId}` }]] }
        });
      }
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // Отдача index.html
  const filePath = path.join(process.cwd(), "index.html");
  fs.readFile(filePath, (err, content) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

// Кнопки подтверждения вывода
bot.on("callback_query", async (q) => {
  const parts = q.data.split("_");
  const action = parts[0];
  if (action === 'wd') {
    const status = parts[1];
    const wdId = parts[2];
    const reqData = withdrawRequests[wdId];
    if (!reqData) { bot.answerCallbackQuery(q.id, { text: "Заявка не найдена" }); return; }

    if (status === 'ok') {
      const resTr = await transferCryptoToUser(reqData.tgId, reqData.usdtApprox, `Выплата #${wdId}`);
      if (resTr) {
        await bot.sendMessage(reqData.tgId, `✅ **Выплата подтверждена!**\n💎 ${reqData.usdtApprox} USDT`, { parse_mode: "Markdown" });
        await bot.editMessageText(`✅ Выплата ${wdId} проведена.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
      } else {
        bot.answerCallbackQuery(q.id, { text: "Ошибка перевода Crypto Bot" });
        return;
      }
    } else {
      await bot.sendMessage(reqData.tgId, "❌ Вывод отклонен администратором.");
      await bot.editMessageText(`❌ Выплата ${wdId} отклонена.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    }
    delete withdrawRequests[wdId];
  }
  bot.answerCallbackQuery(q.id);
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
