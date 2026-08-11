import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import http from "http";
import fs from "fs";
import path from "path";

const botToken = process.env.BOT_TOKEN;
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN || "620902:AATcBsJtTEYOEJxBiShsJFcE82mFJ88nL9z";

if (!botToken) {
  throw new Error("BOT_TOKEN environment variable is required.");
}

const APP_URL = process.env.WEBAPP_URL || "https://steam-sales-app.onrender.com";
const PORT = process.env.PORT || 3000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new TelegramBot(botToken, { polling: true });

let serverMarketItems = [];
let serverDeals = [];

// Функция создания инвойса через Crypto Pay API
async function createCryptoInvoice(amountUsdt, description) {
  try {
    const response = await fetch("https://pay.crypt.bot/api/createInvoice", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Crypto-Pay-API-Token": CRYPTO_PAY_TOKEN
      },
      body: JSON.stringify({
        asset: "USDT",
        amount: String(amountUsdt),
        description: description,
        payload: "balance_topup",
        allow_comments: true,
        allow_anonymous: false
      })
    });

    const data = await response.json();
    if (data.ok && data.result) {
      return data.result.pay_url; // Ссылка на оплату от CryptoBot
    }
    return null;
  } catch (err) {
    console.error("Crypto Pay API error:", err);
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  
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
      res.end("<h1>Ошибка авторизации Steam.</h1>");
    }
    return;
  }

  // Получение всех товаров маркетплейса
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

        if (newItem.tgId) {
          await bot.sendMessage(
            newItem.tgId,
            `✅ **Предмет успешно выставлен на продажу!**\n\n` +
            `🎯 Предмет: *${newItem.name}*\n` +
            `💰 Стоимость: *${newItem.price} ₽*\n` +
            `⏳ Статус: Активен на маркетплейсе\n\n` +
            `⚠️ *Не удаляйте предмет из инвентаря Steam*, пока он выставлен.`,
            { parse_mode: "Markdown" }
          );
        }

        if (ADMIN_CHAT_ID) {
          await bot.sendMessage(
            ADMIN_CHAT_ID,
            `🏷 **Новый лот на маркете!**\n\n` +
            `🎯 Предмет: *${newItem.name}*\n` +
            `💵 Цена: *${newItem.price} ₽*\n` +
            `👤 Продавец: *${newItem.seller}* (ID: \`${newItem.tgId || "не указан"}\`)`,
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

  // Снятие лота с продажи
  if (req.url === "/api/market/remove" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { itemId, tgId } = JSON.parse(body);
        const index = serverMarketItems.findIndex(i => i._id === itemId && String(i.tgId) === String(tgId));
        
        if (index !== -1) {
          serverMarketItems.splice(index, 1);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } else {
          throw new Error("Лот не найден");
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
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
        const { itemId, buyerName, buyerTgId, buyerTradeUrl } = JSON.parse(body);
        const itemIndex = serverMarketItems.findIndex(i => i._id === itemId);
        
        if (itemIndex === -1) {
          throw new Error("Товар уже куплен или удален");
        }

        const purchasedItem = serverMarketItems[itemIndex];

        if (purchasedItem.tgId && buyerTgId && String(purchasedItem.tgId) === String(buyerTgId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Вы не можете купить собственный предмет!" }));
          return;
        }

        serverMarketItems.splice(itemIndex, 1);

        const dealId = Date.now().toString();
        const newDeal = {
          id: dealId,
          name: purchasedItem.name,
          price: purchasedItem.price,
          seller: purchasedItem.seller,
          sellerTgId: purchasedItem.tgId,
          buyer: buyerName || "Покупатель",
          buyerTgId: buyerTgId,
          buyerTradeUrl: buyerTradeUrl || "Не указана",
          status: "waiting_transfer",
          image: purchasedItem.image,
          createdAt: new Date()
        };

        serverDeals.unshift(newDeal);

        if (purchasedItem.tgId) {
          await bot.sendMessage(
            purchasedItem.tgId,
            `🛒 **У вас купили предмет!**\n\n` +
            `🎯 Предмет: *${purchasedItem.name}*\n` +
            `💰 Стоимость: *${purchasedItem.price} ₽*\n` +
            `👤 Покупатель: *${buyerName}*\n` +
            `🔗 Трейд-ссылка покупателя: \`${buyerTradeUrl}\`\n\n` +
            `⏳ *Шаг 1:* Передайте скин покупателю по ссылке в Steam, затем нажмите кнопку ниже.`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "📤 Я отправил скин", callback_data: `sent_${dealId}` }]
                ]
              }
            }
          );
        }

        if (buyerTgId) {
          await bot.sendMessage(
            buyerTgId,
            `🎉 **Заказ успешно оформлен!**\n\n` +
            `🎯 Предмет: *${purchasedItem.name}*\n` +
            `💰 Сумма: *${purchasedItem.price} ₽*\n` +
            `👤 Продавец: *${purchasedItem.seller}*\n\n` +
            `⏳ *Статус:* Ожидаем отправку скина от продавца.`,
            { parse_mode: "Markdown" }
          );
        }

        if (ADMIN_CHAT_ID) {
          await bot.sendMessage(
            ADMIN_CHAT_ID,
            `🛍 **Совершена сделка (покупка)!**\n\n` +
            `🎯 Предмет: *${purchasedItem.name}*\n` +
            `💵 Цена: *${purchasedItem.price} ₽*\n` +
            `👤 Продавец ID: \`${purchasedItem.tgId || "н/д"}\`\n` +
            `🛒 Покупатель: *${buyerName}* (ID: \`${buyerTgId}\`)`,
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

  // Выставление счета на пополнение баланса через Crypto Pay API
  if (req.url === "/api/billing/invoice" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { tgId, amount, currency, received } = JSON.parse(body);
        const invoiceId = Math.floor(1000000 + Math.random() * 9000000);

        let payUrl = null;
        if (currency === "USDT") {
          payUrl = await createCryptoInvoice(amount, `Пополнение баланса Steam Sales на ${received} ₽`);
        }

        if (tgId) {
          let messageText = `💡 **Счет на оплату ${currency} выставлен** 💡\n\n` +
            `💳 Сумма к оплате: *${amount} ${currency}*\n` +
            `🆔 ID платежа: *${invoiceId}*\n` +
            `💎 Получите: *${received} ₽*\n\n`;

          let replyMarkup = undefined;
          if (payUrl) {
            messageText += `🔗 Нажмите кнопку ниже для безопасной оплаты через **Crypto Bot**:`;
            replyMarkup = {
              inline_keyboard: [
                [{ text: "💳 Оплатить в Crypto Bot", url: payUrl }]
              ]
            };
          } else {
            messageText += `❗ **Оплачивайте ровно ту сумму** на которую создали платеж.`;
          }

          await bot.sendMessage(tgId, messageText, { parse_mode: "Markdown", reply_markup: replyMarkup });
        }

        if (ADMIN_CHAT_ID) {
          await bot.sendMessage(
            ADMIN_CHAT_ID,
            `💳 **Создан счет на пополнение**\n\n` +
            `👤 Пользователь ID: \`${tgId}\`\n` +
            `💰 Сумма: *${amount} ${currency}* (Зачисление: ${received} ₽)\n` +
            `🆔 ID платежа: \`${invoiceId}\``,
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

  // Запрос на вывод средств в USDT
  if (req.url === "/api/billing/withdraw" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { tgId, amount, recipientAccount, username } = JSON.parse(body);
        const withdrawId = Math.floor(1000000 + Math.random() * 9000000);
        const netAmount = Math.round(amount * 0.95);
        const usdtApprox = (netAmount / 90).toFixed(2);

        if (tgId) {
          await bot.sendMessage(
            tgId,
            `📤 **Заявка на вывод средств (Crypto Bot) создана**\n\n` +
            `🆔 ID заявки: *${withdrawId}*\n` +
            `💵 Списано: *${amount} ₽*\n` +
            `💎 К получению (~): *~${usdtApprox} USDT* (с учетом комиссии 5%)\n` +
            `👤 Аккаунт: *${recipientAccount}*\n` +
            `⏳ Статус: *В обработке администратором*`,
            { parse_mode: "Markdown" }
          );
        }

        if (ADMIN_CHAT_ID) {
          await bot.sendMessage(
            ADMIN_CHAT_ID,
            `📤 **Новый запрос на вывод в USDT!**\n\n` +
            `👤 Пользователь: @${username || "ненейм"} (ID: \`${tgId}\`)\n` +
            `💵 Сумма: *${amount} ₽* (~${usdtApprox} USDT)\n` +
            `🎯 Аккаунт Crypto Bot: \`${recipientAccount}\`\n` +
            `🆔 ID заявки: \`${withdrawId}\``,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ Выплачено (USDT)", callback_data: `wd_ok_${withdrawId}` },
                    { text: "❌ Отклонить", callback_data: `wd_no_${withdrawId}` }
                  ]
                ]
              }
            }
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

  if (req.url === "/api/steam/inventory" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const steamId = data.steamId;
        if (!steamId) throw new Error("Не передан SteamID");

        const response = await fetch(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=100`);
        if (!response.ok) throw new Error("Инвентарь скрыт или профиль закрыт");

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

bot.on("callback_query", async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data.startsWith("sent_")) {
    const dealId = data.split("_")[1];
    const deal = serverDeals.find(d => d.id === dealId);

    if (deal) {
      deal.status = "sent";
      await bot.editMessageText(`✅ Вы подтвердили отправку скина для сделки *${deal.name}*.`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      });

      if (deal.buyerTgId) {
        await bot.sendMessage(
          deal.buyerTgId,
          `📦 **Продавец отправил вам скин!**\n\n` +
          `🎯 Предмет: *${deal.name}*\n\n` +
          `⏳ Проверьте свой Steam-аккаунт и подтвердите получение предмета:`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Я получил скин", callback_data: `received_${dealId}` }]
              ]
            }
          }
        );
      }
    }
  } else if (data.startsWith("received_")) {
    const dealId = data.split("_")[1];
    const deal = serverDeals.find(d => d.id === dealId);

    if (deal) {
      deal.status = "completed";
      await bot.editMessageText(`🎉 Сделка по предмету *${deal.name}* успешно завершена!`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown"
      });

      if (deal.sellerTgId) {
        await bot.sendMessage(
          deal.sellerTgId,
          `🎉 **Покупатель подтвердил получение скина!**\n\n` +
          `Сделка по предмету *${deal.name}* успешно завершена. Средства зачислены на ваш баланс.`,
          { parse_mode: "Markdown" }
        );
      }
    }
  } else if (data.startsWith("wd_ok_")) {
    const wdId = data.split("_")[2];
    await bot.editMessageText(`✅ Заявка на вывод №${wdId} обработана и выплачена.`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "Markdown"
    });
  } else if (data.startsWith("wd_no_")) {
    const wdId = data.split("_")[2];
    await bot.editMessageText(`❌ Заявка на вывод №${wdId} отклонена администратором.`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "Markdown"
    });
  }

  bot.answerCallbackQuery(query.id);
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

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
