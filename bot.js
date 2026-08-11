import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import http from "http";
import fs from "fs";
import path from "path";

const botToken = process.env.BOT_TOKEN;
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const APP_URL = process.env.WEBAPP_URL || "https://steam-sales-app.onrender.com";
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(botToken, { polling: true });
let serverMarketItems = [];
let serverDeals = [];
let withdrawRequests = {};

// --- Функции API ---
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

// --- Сервер ---
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // API Маркет
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
      const { itemId, buyerTgId, buyerTradeUrl, buyerName } = JSON.parse(body);
      const idx = serverMarketItems.findIndex(i => i._id === itemId);
      const item = serverMarketItems.splice(idx, 1)[0];
      const dealId = Date.now().toString();
      serverDeals.push({ ...item, id: dealId, buyerTgId, status: 'sent' });
      await bot.sendMessage(item.tgId, `🛒 У вас купили ${item.name}!`, { reply_markup: { inline_keyboard: [[{ text: "📤 Я отправил", callback_data: `sent_${dealId}` }]] } });
      res.end(JSON.stringify({ success: true, deal: { id: dealId } }));
    });
    return;
  }

  // API Пополнение
  if (req.url === "/api/billing/invoice" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      const { tgId, amount, currency } = JSON.parse(body);
      let payUrl = currency === "USDT" ? await createCryptoInvoice(amount, "Пополнение") : await bot.createInvoiceLink("Пополнение", "Пополнение счета", "topup", "", "XTR", [{label: "Пополнение", amount: parseInt(amount)}]);
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
        await bot.sendMessage(ADMIN_CHAT_ID, `📤 **Заявка: ${amount} ₽**\n👤 @${username}\n🎯 ${recipientAccount}\n🆔 \`${wdId}\``, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "✅ Выплатить", callback_data: `wd_ok_${wdId}` }, { text: "❌ Отклонить", callback_data: `wd_no_${wdId}` }]] }
        });
      }
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // Steam Auth & Static
  if (req.url === "/auth/steam") { res.writeHead(302, { Location: "https://steamcommunity.com/openid/login?..." }); res.end(); return; }
  const content = fs.readFileSync("index.html");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(content);
});

// Кнопки
bot.on("callback_query", async (q) => {
  const [action, status, wdId] = q.data.split("_");
  if (action === 'wd') {
    const reqData = withdrawRequests[wdId];
    if (status === 'ok') {
      const resTr = await transferCryptoToUser(reqData.tgId, reqData.usdtApprox, `Выплата ${wdId}`);
      if (resTr) {
        await bot.sendMessage(reqData.tgId, `✅ **Выплата подтверждена!**\n💎 ${reqData.usdtApprox} USDT`);
        await bot.editMessageText(`✅ Выплата ${wdId} проведена.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
      }
    } else {
      await bot.sendMessage(reqData.tgId, "❌ Вывод отклонен.");
      await bot.editMessageText(`❌ Выплата ${wdId} отклонена.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    }
    delete withdrawRequests[wdId];
  }
  bot.answerCallbackQuery(q.id);
});

server.listen(PORT);
