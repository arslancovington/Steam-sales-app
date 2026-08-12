import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import http from "http";
import fs from "fs";
import path from "path";

const dbFile = path.join(process.cwd(), "users.json");
const marketFile = path.join(process.cwd(), "market.json");

function loadUsers() {
  if (!fs.existsSync(dbFile)) return {};
  try { return JSON.parse(fs.readFileSync(dbFile, "utf8")); }
  catch (e) { return {}; }
}

function saveUsers(data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2), "utf8");
}

function loadMarket() {
  if (!fs.existsSync(marketFile)) return [];
  try { return JSON.parse(fs.readFileSync(marketFile, "utf8")); }
  catch (e) { return []; }
}

function saveMarket(items) {
  fs.writeFileSync(marketFile, JSON.stringify(items, null, 2), "utf8");
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
let serverDeals = {};
let withdrawRequests = {};

const steamHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
};

async function createCryptoInvoice(amountUsdt, description, tgId, received) {
  if (!CRYPTO_PAY_TOKEN) {
    return { success: false, error: "Токен CRYPTO_PAY_TOKEN не задан в Render!" };
  }

  let apiUrl = "https://pay.crypt.bot/api/createInvoice";
  if (CRYPTO_PAY_TOKEN.includes("test") || CRYPTO_PAY_TOKEN.startsWith("t")) {
    apiUrl = "https://testnet-pay.crypt.bot/api/createInvoice";
  }

  try {
    const payloadData = { tgId, received };
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "Crypto-Pay-API-Token": CRYPTO_PAY_TOKEN 
      },
      body: JSON.stringify({
        asset: "USDT",
        amount: String(amountUsdt),
        description: description,
        payload: JSON.stringify(payloadData)
      })
    });
    
    const data = await response.json();
    if (!data.ok) {
      const errName = data.error?.name || JSON.stringify(data);
      console.error("CRYPTO PAY API ERROR:", errName);
      return { success: false, error: `CryptoBot: ${errName}` };
    }
    
    return { success: true, payUrl: data.result.pay_url };
  } catch (e) {
    console.error("FETCH EXCEPTION:", e);
    return { success: false, error: e.message };
  }
}

async function transferCryptoToUser(tgId, amountUsdt, comment) {
  let apiUrl = "https://pay.crypt.bot/api/transfer";
  if (CRYPTO_PAY_TOKEN && (CRYPTO_PAY_TOKEN.includes("test") || CRYPTO_PAY_TOKEN.startsWith("t"))) {
    apiUrl = "https://testnet-pay.crypt.bot/api/transfer";
  }
  try {
    const response = await fetch(apiUrl, {
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

  // Вебхук от Crypto Bot при успешной оплате счета -> отправка чека в личные сообщения с ботом
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
              // Чек об оплате от нашего бота в лс
              await bot.sendMessage(
                data.tgId, 
                `🧾 **Чек об успешной оплате**\n\n` +
                `✅ Баланс успешно пополнен!\n` +
                `💎 Зачислено: *${data.received} ₽*\n` +
                `📦 Статус: Выполнено`, 
                { parse_mode: "Markdown" }
              );
            }
          }
        }
        res.writeHead(200); res.end("OK");
      } catch (e) { res.writeHead(500); res.end(); }
    });
    return;
  }

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

  if (req.url.startsWith("/api/steam/price")) {
    const urlObj = new URL(req.url, APP_URL);
    const skinName = urlObj.searchParams.get("name");
    let realPrice = 1500;
    try {
      if (skinName) {
        const pRes = await fetch(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodeURIComponent(skinName)}`, { headers: steamHeaders });
        const pData = await pRes.json();
        if (pData && pData.success && (pData.lowest_price || pData.median_price)) {
          const rawPrice = pData.lowest_price || pData.median_price;
          const parsed = parseFloat(rawPrice.replace(/[^\d,.]/g, '').replace(',', '.'));
          if (!isNaN(parsed)) realPrice = parsed;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, price: realPrice }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, price: 1500 }));
    }
    return;
  }

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

  if (req.url === "/api/market/items" && req.method === "GET") {
    res.end(JSON.stringify({ success: true, items: loadMarket() }));
    return;
  }

  if (req.url === "/api/market/add" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const item = JSON.parse(body);
        let items = loadMarket();
        
        if (item.assetid && items.some(i => i.assetid === item.assetid && String(i.tgId) === String(item.tgId))) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Этот предмет уже выставлен на продажу!" }));
          return;
        }

        item._id = Date.now().toString();
        items.unshift(item);
        saveMarket(items);

        if (item.tgId) {
          await bot.sendMessage(
            item.tgId,
            `🏷 **Лот успешно выставлен!**\n\nПредмет: *${item.name}*\nЦена: *${item.price} ₽*\nСтатус: Активен на маркетплейсе.`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }

        if (ADMIN_CHAT_ID) {
          await bot.sendMessage(
            ADMIN_CHAT_ID,
            `🏷 **Новый лот на маркете!**\n\nПредмет: *${item.name}*\nЦена: *${item.price} ₽*\nПродавец: *${item.seller}* (ID: \`${item.tgId}\`)`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }

        res.end(JSON.stringify({ success: true }));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ success: false })); }
    });
    return;
  }

  if (req.url === "/api/market/cancel" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { itemId, tgId } = JSON.parse(body);
        let items = loadMarket();
        const idx = items.findIndex(i => i._id === itemId && String(i.tgId) === String(tgId));
        if (idx !== -1) {
          items.splice(idx, 1);
          saveMarket(items);
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400); 
          res.end(JSON.stringify({ success: false, error: "Лот не найден" }));
        }
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ success: false })); }
    });
    return;
  }

  if (req.url === "/api/deals/buy" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { itemId, buyerTgId, buyerTradeUrl, buyerName } = JSON.parse(body);
        let items = loadMarket();
        const idx = items.findIndex(i => i._id === itemId);
        if (idx === -1) { 
          res.writeHead(400); 
          res.end(JSON.stringify({ success: false, error: "Товар уже куплен" })); 
          return; 
        }
        
        const item = items.splice(idx, 1)[0];
        saveMarket(items);

        updateUserBalance(buyerTgId, -item.price);

        const dealId = Date.now().toString();
        serverDeals[dealId] = { ...item, buyerTgId, buyerTradeUrl, buyerName, status: 'pending_sent' };

        await bot.sendMessage(
          buyerTgId,
          `🎉 **Заказ успешно оформлен!**\n\nПредмет: *${item.name}*\nСумма: *${item.price} ₽*\nПродавец: *${item.seller}*\n\nОжидайте отправки предмета в Steam от продавца.`,
          { parse_mode: "Markdown" }
        ).catch(() => {});

        if (item.tgId) {
          await bot.sendMessage(
            item.tgId,
            `🛒 **У вас купили предмет!**\n\nПредмет: *${item.name}*\nЦена: *${item.price} ₽*\nПокупатель: *${buyerName}*\nСсылка для обмена: \`${buyerTradeUrl}\`\n\nПожалуйста, отправьте предмет в Steam покупателю, после чего нажмите кнопку ниже:`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [[{ text: "📦 Подтвердить отправку", callback_data: `deal_sent_${dealId}` }]]
              }
            }
          ).catch(() => {});
        }

        if (ADMIN_CHAT_ID) {
          await bot.sendMessage(
            ADMIN_CHAT_ID,
            `🛍 **Новая сделка!**\n\nПредмет: *${item.name}*\nЦена: *${item.price} ₽*\nПродавец ID: \`${item.tgId}\`\nПокупатель: *${buyerName}* (ID: \`${buyerTgId}\`)`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }

        res.end(JSON.stringify({ success: true, deal: { id: dealId } }));
      } catch(e) { 
        res.writeHead(400); 
        res.end(JSON.stringify({ success: false, error: e.message })); 
      }
    });
    return;
  }

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

        const response = await fetch(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=500`, { headers: steamHeaders });
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

  // Создание счета и отправка счет-сообщения НАПРЯМУЮ от нашего бота в ЛС
  if (req.url === "/api/billing/invoice" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { tgId, amount, currency, received } = JSON.parse(body);
        if (currency === "USDT") {
          const invRes = await createCryptoInvoice(amount, "Пополнение баланса", tgId, received);
          if (invRes.success) {
            // Отправляем счет на оплату в личные сообщения с нашим ботом
            await bot.sendMessage(
              tgId, 
              `💡 **Счет на оплату USDT выставлен**\n\n` +
              `💳 Сумма к оплате: *${amount} USDT*\n` +
              `💎 Получите: *${received} ₽*\n\n` +
              `Нажмите кнопку ниже для безопасной оплаты:`, 
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[{ text: "💳 Оплатить в Crypto Bot", url: invRes.payUrl }]]
                }
              }
            ).catch(e => console.error("Error sending invoice to DM:", e));

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: invRes.error }));
          }
        } else {
          const payUrl = await bot.createInvoiceLink("Пополнение", `Зачисление ${received} ₽`, `topup_${tgId}_${received}`, "", "XTR", [{label: "Пополнение", amount: parseInt(amount)}]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, payUrl }));
        }
      } catch(e) { 
        res.writeHead(500, { "Content-Type": "application/json" }); 
        res.end(JSON.stringify({ success: false, error: e.message })); 
      }
    });
    return;
  }

  if (req.url === "/api/billing/withdraw" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { tgId, amount, recipientAccount, username } = JSON.parse(body);
        const wdId = Date.now().toString().slice(-7);
        const usdtApprox = (Math.round(amount * 0.95) / 90).toFixed(2);
        
        const safeUser = username && username !== 'undefined' ? `@${username}` : `ID: ${tgId}`;
        const safeAccount = recipientAccount && recipientAccount !== 'undefined' ? recipientAccount : `ID: ${tgId}`;

        updateUserBalance(tgId, -amount);
        withdrawRequests[wdId] = { tgId, amount, usdtApprox };

        if (ADMIN_CHAT_ID) {
          await bot.sendMessage(ADMIN_CHAT_ID, `📤 **Заявка на вывод!**\nСумма: *${amount} ₽* (~${usdtApprox} USDT)\nПользователь: ${safeUser}\nCrypto Bot: \`${safeAccount}\`\nID: \`${wdId}\``, {
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
  const data = q.data;

  if (data.startsWith("deal_sent_") || data.startsWith("deal_received_")) {
    const parts = data.split("_");
    const action = parts[1];
    const dealId = parts[2];
    const deal = serverDeals[dealId];

    if (!deal) {
      await bot.answerCallbackQuery(q.id, { text: "Сделка не найдена или устарела", show_alert: true });
      return;
    }

    if (action === 'sent') {
      deal.status = 'pending_received';
      await bot.editMessageText(`✅ Вы подтвердили отправку предмета *${deal.name}*. Ожидайте подтверждения от покупателя.`, {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        parse_mode: "Markdown"
      }).catch(() => {});

      await bot.sendMessage(
        deal.buyerTgId,
        `📦 **Продавец сообщил об отправке предмета!**\n\nПредмет: *${deal.name}*\n\nПожалуйста, примите обмен в Steam, а затем нажмите кнопку ниже для подтверждения получения:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "✅ Подтвердить получение", callback_data: `deal_received_${dealId}` }]]
          }
        }
      ).catch(() => {});

    } else if (action === 'received') {
      deal.status = 'completed';
      
      let users = loadUsers();
      if (users[deal.tgId]) {
        users[deal.tgId]["Balance"] = (users[deal.tgId]["Balance"] || 0) + deal.price;
        users[deal.tgId]["CompletedDeals"] = (users[deal.tgId]["CompletedDeals"] || 0) + 1;
        saveUsers(users);
      }

      await bot.editMessageText(`✅ Вы подтвердили получение предмета *${deal.name}*. Сделка успешно завершена!`, {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        parse_mode: "Markdown"
      }).catch(() => {});

      if (deal.tgId) {
        await bot.sendMessage(
          deal.tgId,
          `🎉 **Сделка успешно завершена!**\n\nПокупатель подтвердил получение предмета *${deal.name}*.\nНа ваш баланс зачислено: *${deal.price} ₽*.`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }

      if (ADMIN_CHAT_ID) {
        await bot.sendMessage(
          ADMIN_CHAT_ID,
          `✅ **Сделка #${dealId} успешно завершена!**\nПредмет: *${deal.name}* (${deal.price} ₽)`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }

      delete serverDeals[dealId];
    }

    await bot.answerCallbackQuery(q.id);
    return;
  }

  if (data.startsWith("wd_")) {
    const parts = data.split("_");
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
  }
});

server.listen(PORT, () => { console.log(`Server started on port ${PORT}`); });
