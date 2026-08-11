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

const botToken = process.env.BOT_TOKEN;
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const APP_URL = process.env.WEBAPP_URL || "https://steam-sales-app.onrender.com";
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(botToken, { polling: true });
let serverMarketItems = [];
let serverDeals = [];
let withdrawRequests = {};

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

  if (req.url === "/api/user/save" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { tgId, tgUser, steamId, tradeUrl } = JSON.parse(body);
        if (tgId) {
          let users = loadUsers();
          users[tgId] = {
            "TG user": tgUser || users[tgId]?.["TG user"] || "Unknown",
            "TG id": tgId,
            "Steam user": steamId || users[tgId]?.["Steam user"] || "",
            "Steam trade url": tradeUrl || users[tgId]?.["Steam trade url"] || "",
            "Balance": users[tgId]?.["Balance"] || 1500
          };
          saveUsers(users);
        }
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

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

  // ИСПРАВЛЕННЫЙ API ВЫВОДА (передаем корректные поля без UNDEFINED)
  if (req.url === "/api/billing/withdraw" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const tgId = data.tgId;
        const amount = data.amount;
        const recipientAccount = data.recipientAccount || data.cryptoAccount || "Не указан";
        const username = data.username || "Игрок";
        
        const wdId = Date.now().toString().slice(-7);
        const usdtApprox = (Math.round(amount * 0.95) / 90).toFixed(2);
        
        withdrawRequests[wdId] = { tgId, amount, usdtApprox };

        if (ADMIN_CHAT_ID) {
          await bot.sendMessage(
            ADMIN_CHAT_ID, 
            `📤 **Заявка на вывод**\n` +
            `📥 Сумма: *${amount} ₽* (~${usdtApprox} USDT)\n` +
            `👤 Пользователь: @${username}\n` +
            `🎯 Crypto Bot: \`${recipientAccount}\`\n` +
            `🆔 ID: \`${wdId}\``, 
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ Выплатить", callback_data: `wd_ok_${wdId}` },
                    { text: "❌ Отклонить", callback_data: `wd_no_${wdId}` }
                  ]
                ]
              }
            }
          );
        }
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  const filePath = path.join(process.cwd(), "index.html");
  fs.readFile(filePath, (err, content) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

// ИСПРАВЛЕННЫЙ ОБРАБОТЧИК КНОПОК (чтобы убирать крутящуюся загрузку)
bot.on("callback_query", async (q) => {
  const data = q.data;
  if (!data.startsWith("wd_")) {
    bot.answerCallbackQuery(q.id);
    return;
  }

  const parts = data.split("_");
  const status = parts[1]; // ok или no
  const wdId = parts[2];
  const reqData = withdrawRequests[wdId];

  if (!reqData) {
    await bot.answerCallbackQuery(q.id, { text: "Заявка не найдена или уже обработана", show_alert: true });
    return;
  }

  if (status === 'ok') {
    const resTr = await transferCryptoToUser(reqData.tgId, reqData.usdtApprox, `Выплата #${wdId}`);
    if (resTr) {
      await bot.sendMessage(reqData.tgId, `✅ **Выплата подтверждена!**\n💎 Начислено: *${reqData.usdtApprox} USDT*`, { parse_mode: "Markdown" });
      await bot.editMessageText(`✅ Заявка №${wdId} успешно выплачена.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    } else {
      await bot.answerCallbackQuery(q.id, { text: "Ошибка перевода Crypto Bot (проверьте баланс)", show_alert: true });
      return;
    }
  } else {
    await bot.sendMessage(reqData.tgId, "❌ Ваш запрос на вывод средств был отклонен администратором.");
    await bot.editMessageText(`❌ Заявка №${wdId} отклонена.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
  }

  delete withdrawRequests[wdId];
  bot.answerCallbackQuery(q.id);
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
