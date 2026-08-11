import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import http from "http";
import fs from "fs";
import path from "path";

const dbFile = path.join(process.cwd(), "users.json");

function loadUsers() {
  if (!fs.existsSync(dbFile)) return {};
  try { return JSON.parse(fs.readFileSync(dbFile, "utf8")); }
  catch (e) { return {}; }
}

function saveUsers(data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2), "utf8");
}

function getUser(tgId, tgUser = "Игрок") {
  let users = loadUsers();
  if (!users[tgId]) {
    users[tgId] = {
      "TG user": tgUser,
      "TG id": String(tgId),
      "Steam user": "",
      "Steam trade url": "",
      "Balance": 0,
      "CompletedDeals": 0
    };
    saveUsers(users);
  }
  return users[tgId];
}

function updateUserBalance(tgId, amountChange) {
  let users = loadUsers();
  if (!users[tgId]) users[tgId] = { "Balance": 0, "CompletedDeals": 0 };
  users[tgId]["Balance"] = (users[tgId]["Balance"] || 0) + amountChange;
  saveUsers(users);
  return users[tgId]["Balance"];
}

const botToken = process.env.BOT_TOKEN;
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const APP_URL = process.env.WEBAPP_URL || "https://steam-sales-app.onrender.com";
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(botToken, { polling: true });
let serverMarketItems = [];
let serverDeals = [];
let withdrawRequests = {};

// Заголовки для обхода блокировок Steam API
const steamHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
};

async function createCryptoInvoice(amountUsdt, description, tgId, received) {
  try {
    const response = await fetch("https://pay.crypt.bot/api/createInvoice", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Crypto-Pay-API-Token": CRYPTO_PAY_TOKEN },
      body: JSON.stringify({ 
        asset: "USDT", amount: String(amountUsdt), description, 
        payload: JSON.stringify({ tgId, received }) 
      })
    });
    const data = await response.json();
    return data.ok ? data.result.pay_url : null;
  } catch (e) { return null; }
}

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

  // Вебхук Crypto Bot
  if (req.url === "/api/crypto-webhook" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        if (update.update_type === "invoice_paid") {
          const inv = update.payload;
          if (inv && inv.payload) {
            const data = JSON.parse(inv.payload);
            if (data.tgId && data.received) {
              updateUserBalance(data.tgId, data.received);
              await bot.sendMessage(data.tgId, `🎉 **Оплата получена!**\nНа баланс зачислено *${data.received} ₽*.`, { parse_mode: "Markdown" });
            }
          }
        }
        res.writeHead(200); res.end("OK");
      } catch (e) { res.writeHead(500); res.end(); }
    });
    return;
  }

  // Авторизация Steam
  if (req.url === "/auth/steam") {
    const returnTo = `${APP_URL}/auth/steam/return`;
    const realm = APP_URL;
    const steamOpenIdUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(returnTo)}&openid.realm=${encodeURIComponent(realm)}&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;
    res.writeHead(302, { Location: steamOpenIdUrl });
    res.end();
    return;
  }

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

  // Профиль пользователя
  if (req.url.startsWith("/api/user/profile")) {
    const url = new URL(req.url, APP_URL);
    const tgId = url.searchParams.get("tgId");
    const tgUser = url.searchParams.get("tgUser") || "Игрок";
    const user = getUser(tgId, tgUser);
    
    let dealsCount = user["CompletedDeals"] || 0;
    let rating = dealsCount === 0 ? "0.0" : Math.min(5.0, (3.5 + dealsCount * 0.1)).toFixed(1);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      success: true, 
      balance: user["Balance"], 
      tradeUrl: user["Steam trade url"],
      steamId: user["Steam user"],
      completedDeals: dealsCount,
      rating: rating
    }));
    return;
  }

  // Сохранение пользователя
  if (req.url === "/api/user/save" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { tgId, tgUser, steamId, tradeUrl } = JSON.parse(body);
        if (tgId) {
          let users = loadUsers();
          let user = users[tgId] || getUser(tgId, tgUser);
          user["TG user"] = tgUser || user["TG user"];
          if (steamId) user["Steam user"] = steamId;
          if (tradeUrl) user["Steam trade url"] = tradeUrl;
          users[tgId] = user;
          saveUsers(users);
        }
        res.end(JSON.stringify({ success: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ success: false })); }
    });
    return;
  }

  // Маркетплейс
  if (req.url === "/api/market/items" && req.method === "GET") {
    res.end(JSON.stringify({ success: true, items: serverMarketItems }));
    return;
  }
  if (req.url === "/api/market/add" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const item = JSON.parse(body);
        item._id = Date.now().toString();
        serverMarketItems.unshift(item);
        res.end(JSON.stringify({ success: true }));
      } catch(e) { res.writeHead(400); res.end(); }
    });
    return;
  }

  // Покупка
  if (req.url === "/api/deals/buy" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { itemId, buyerTgId, buyerTradeUrl } = JSON.parse(body);
        const idx = serverMarketItems.findIndex(i => i._id === itemId);
        if (idx === -1) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: "Товар уже куплен" })); return; }
        
        const item = serverMarketItems.splice(idx, 1)[0];
        updateUserBalance(buyerTgId, -item.price);

        let users = loadUsers();
        if (users[item.tgId]) {
          users[item.tgId]["CompletedDeals"] = (users[item.tgId]["CompletedDeals"] || 0) + 1;
          saveUsers(users);
        }

        const dealId = Date.now().toString();
        serverDeals.push({ ...item, id: dealId, buyerTgId, status: 'sent' });

        if (item.tgId) {
          await bot.sendMessage(item.tgId, `🛒 **У вас купили предмет!**\nПредмет: *${item.name}* за *${item.price} ₽*\nСсылка: \`${buyerTradeUrl}\``, { parse_mode: "Markdown" });
        }
        res.end(JSON.stringify({ success: true, deal: { id: dealId } }));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: e.message })); }
    });
    return;
  }

  // Загрузка инвентаря и аватара Steam (с исправленными заголовками)
  if (req.url === "/api/steam/inventory" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { steamId } = JSON.parse(body);
        if (!steamId) throw new Error("Нет SteamID");

        let avatarUrl = "";
        let steamName = "";
        try {
          const xmlRes = await fetch(`https://steamcommunity.com/profiles/${steamId}?xml=1`, { headers: steamHeaders });
          const xmlText = await xmlRes.text();
          const avMatch = xmlText.match(/<avatarMedium>([\s\S]*?)<\/avatarMedium>/);
          if (avMatch) avatarUrl = avMatch[1].replace('<![CDATA[', '').replace(']]>', '').trim();
          const nameMatch = xmlText.match(/<steamID>([\s\S]*?)<\/steamID>/);
          if (nameMatch) steamName = nameMatch[1].replace('<![CDATA[', '').replace(']]>', '').trim();
        } catch(e) {}

        const response = await fetch(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=100`, { headers: steamHeaders });
        if (!response.ok) {
          res.end(JSON.stringify({ success: true, items: [], descriptions: [], avatarUrl, steamName }));
          return;
        }

        const steamData = await response.json();
        res.end(JSON.stringify({
          success: true,
          items: steamData.assets || [],
          descriptions: steamData.descriptions || [],
          avatarUrl,
          steamName
        }));
      } catch (error) {
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // Пополнение баланса (возвращает ссылку на оплату на клиент)
  if (req.url === "/api/billing/invoice" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { tgId, amount, currency, received } = JSON.parse(body);
        let payUrl = null;
        if (currency === "USDT") {
          payUrl = await createCryptoInvoice(amount, "Пополнение", tgId, received);
        } else {
          payUrl = await bot.createInvoiceLink("Пополнение", `Зачисление ${received} ₽`, `topup_${tgId}_${received}`, "", "XTR", [{label: "Пополнение", amount: parseInt(amount)}]);
        }
        res.end(JSON.stringify({ success: true, payUrl }));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false })); }
    });
    return;
  }

  // Вывод средств
  if (req.url === "/api/billing/withdraw" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { tgId, amount, recipientAccount, username } = JSON.parse(body);
        const wdId = Date.now().toString().slice(-7);
        const usdtApprox = (Math.round(amount * 0.95) / 90).toFixed(2);
        
        updateUserBalance(tgId, -amount);
        withdrawRequests[wdId] = { tgId, amount, usdtApprox };

        if (ADMIN_CHAT_ID) {
          await bot.sendMessage(ADMIN_CHAT_ID, `📤 **Заявка на вывод!**\nСумма: *${amount} ₽* (~${usdtApprox} USDT)\nЮзер: @${username}\nID: \`${wdId}\``, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "✅ Выплатить", callback_data: `wd_ok_${wdId}` }, { text: "❌ Отклонить", callback_data: `wd_no_${wdId}` }]] }
          });
        }
        res.end(JSON.stringify({ success: true }));
      } catch (err) { res.writeHead(500); res.end(); }
    });
    return;
  }

  const filePath = path.join(process.cwd(), "index.html");
  fs.readFile(filePath, (err, content) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

bot.on("pre_checkout_query", async (query) => { await bot.answerPreCheckoutQuery(query.id, true); });
bot.on("successful_payment", async (msg) => {
  const payment = msg.successful_payment;
  const payload = payment.invoice_payload;
  const chatId = msg.chat.id;
  if (payload && payload.startsWith("topup_")) {
    const parts = payload.split("_");
    const tgId = parts[1];
    const received = parseInt(parts[2]);
    updateUserBalance(tgId, received);
    await bot.sendMessage(chatId, `🎉 **Оплата через Telegram Stars подтверждена!**\nЗачислено *${received} ₽*.`, { parse_mode: "Markdown" });
  }
});

bot.on("callback_query", async (q) => {
  if (!q.data.startsWith("wd_")) { bot.answerCallbackQuery(q.id); return; }
  const parts = q.data.split("_");
  const status = parts[1];
  const wdId = parts[2];
  const reqData = withdrawRequests[wdId];

  if (!reqData) { await bot.answerCallbackQuery(q.id, { text: "Заявка не найдена", show_alert: true }); return; }

  if (status === 'ok') {
    const resTr = await transferCryptoToUser(reqData.tgId, reqData.usdtApprox, `Выплата #${wdId}`);
    if (resTr) {
      await bot.sendMessage(reqData.tgId, `✅ **Выплата подтверждена!**\n💎 ${reqData.usdtApprox} USDT зачислено.`);
      await bot.editMessageText(`✅ Заявка №${wdId} выплачена.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    } else {
      await bot.sendMessage(reqData.tgId, `✅ Вывод на *${reqData.usdtApprox} USDT* подтвержден администратором.`, { parse_mode: "Markdown" });
      await bot.editMessageText(`✅ Заявка №${wdId} закрыта (вручную).`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    }
  } else {
    updateUserBalance(reqData.tgId, reqData.amount);
    await bot.sendMessage(reqData.tgId, "❌ Вывод отклонен, средства возвращены на баланс.");
    await bot.editMessageText(`❌ Заявка №${wdId} отклонена.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
  }
  delete withdrawRequests[wdId];
  bot.answerCallbackQuery(q.id);
});

server.listen(PORT, () => { console.log(`Server started on port ${PORT}`); });
