const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Защита от падений сервера
process.on('uncaughtException', (err) => console.error('⚠️ [CRITICAL] Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('⚠️ [CRITICAL] Unhandled Rejection:', reason));

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID';
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-app.onrender.com';
const PROXY_URL = process.env.PROXY_URL || '';

const USD_TO_RUB = 95;

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

let botUserId = null;
bot.getMe().then(me => { botUserId = me.id; }).catch(e => {});

bot.on('polling_error', (error) => console.error('⚠️ Ошибка Telegram:', error.code, error.message));
bot.on('error', (error) => console.error('⚠️ Общая ошибка бота:', error.message));

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send('Файл index.html не найден!');
});

const dataDir = '/data';
if (!fs.existsSync(dataDir)) {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
}

const dbFile = fs.existsSync(dataDir) ? path.join(dataDir, 'database.json') : path.join(__dirname, 'database.json');
const cardsFile = fs.existsSync(dataDir) ? path.join(dataDir, 'cards.json') : path.join(__dirname, 'cards.json');

// Глобальные переменные
let users = {};
let marketItems = [];
let giveaways = [];
let chats = [];
let shopCatalog = []; 
let cards = [];

const DEFAULT_CATALOG = [
    { id: '1', name: '★ Karambit | Doppler (Factory New)', image: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpovbSsLQJf2-r3ZzRSyN2xlZaYwLz0Orjcx2gGssEh0uw_j9r38Vfj-xU5Yjj3d4STJFA7aQ3RqVa4kLvpjMe7u5TJynIwuCcrsCvZlgv3308xN85S9A/360fx360f', price: 85000, discount: '-12%' }
];

if (fs.existsSync(dbFile)) { 
    try { 
        const db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); 
        if (db.users) users = db.users;
        if (db.marketItems) marketItems = db.marketItems;
        if (db.giveaways) giveaways = db.giveaways;
        if (db.chats) chats = db.chats;
        if (db.shopCatalog && db.shopCatalog.length > 0) shopCatalog = db.shopCatalog;
        else shopCatalog = DEFAULT_CATALOG;
    } catch (e) { shopCatalog = DEFAULT_CATALOG; } 
} else {
    shopCatalog = DEFAULT_CATALOG;
}

if (fs.existsSync(cardsFile)) { 
    try { cards = JSON.parse(fs.readFileSync(cardsFile, 'utf8')).map(c => ({ ...c, type: c.type || 'UZ' })); } catch (e) {} 
}

function saveData() { 
    try { fs.writeFileSync(dbFile, JSON.stringify({ users, marketItems, giveaways, chats, shopCatalog }, null, 2)); } catch (e) {} 
}

function getOrCreateUser(tgId, username = 'Игрок', photoUrl = null) {
    const now = Date.now();
    if (!users[tgId]) {
        users[tgId] = { tgId, username: username || 'Игрок', photoUrl, balance: 0, rating: 5.0, completedDeals: 0, tradeUrl: '', steamId: '', lastActive: now };
    } else {
        users[tgId].lastActive = now;
        if (username && username !== 'Игрок') users[tgId].username = username;
        if (photoUrl) users[tgId].photoUrl = photoUrl;
    }
    saveData();
    return users[tgId];
}

function extractSteamIdFromTradeUrl(url) {
    if (!url) return null;
    const profileMatch = url.match(/\/profiles\/(\d{17})/);
    if (profileMatch && profileMatch[1]) return profileMatch[1];
    const partnerMatch = url.match(/partner=(\d+)/);
    if (partnerMatch && partnerMatch[1]) {
        try { return (BigInt(partnerMatch[1]) + 76561197960265728n).toString(); } catch (e) { return null; }
    }
    return null;
}

function isShopOpen() {
    try {
        const now = new Date();
        const mskHour = parseInt(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow', hour: 'numeric', hour12: false }));
        return mskHour >= 9 && mskHour < 23;
    } catch (e) { return true; }
}

function isAdmin(msg) {
    const userId = String(msg.from ? msg.from.id : '');
    const chatId = String(msg.chat.id);
    const adminId = String(ADMIN_CHAT_ID);
    return userId === adminId || chatId === adminId;
}

const BATTLE_COLORS = ['#FF9900', '#ffffff', '#ffaa33', '#cc7a00', '#ffc266', '#e68a00'];
let battleState = { id: Date.now().toString(), status: 'waiting', participants: [], bank: 0, startTime: null, rollEndTime: null, winnerTgId: null, winnerPrize: 0 };

setInterval(async () => {
    const now = Date.now();
    let giveawaysUpdated = false;
    giveaways.forEach(g => {
        if (!g.ended && g.endTime && now >= g.endTime) {
            g.ended = true; g.endedAt = now; giveawaysUpdated = true;
            if (g.participants && g.participants.length > 0) {
                const winnerId = g.participants[Math.floor(Math.random() * g.participants.length)];
                g.winnerTgId = winnerId;
                const winnerUser = users[winnerId];
                g.winnerUsername = winnerUser ? winnerUser.username : String(winnerId);
                g.winnerTradeUrl = winnerUser ? (winnerUser.tradeUrl || 'Не указан') : 'Не указан';
                try { bot.sendMessage(winnerId, `🎉 Вы выиграли: *${g.title}*!`, { parse_mode: 'Markdown' }); } catch (e) {}
                if (ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                    try { bot.sendMessage(ADMIN_CHAT_ID, `🎁 Розыгрыш завершен!\n🏆 Приз: *${g.title}*\n👤 Победитель: @${g.winnerUsername} (ID: \`${winnerId}\`)\n🔗 Трейд: \`${g.winnerTradeUrl}\``, { parse_mode: 'Markdown' }); } catch (e) {}
                }
            }
        }
    });
    if (giveawaysUpdated) saveData();
}, 15000);

app.get('/api/user/profile', (req, res) => {
    const { tgId, tgUser, photoUrl } = req.query;
    if (!tgId) return res.json({ success: false });
    res.json({ success: true, ...getOrCreateUser(tgId, tgUser, photoUrl) });
});

app.post('/api/user/save', (req, res) => {
    const { tgId, tradeUrl } = req.body;
    const user = getOrCreateUser(tgId);
    user.tradeUrl = tradeUrl || '';
    const steamId = extractSteamIdFromTradeUrl(tradeUrl);
    if (steamId) user.steamId = steamId;
    saveData();
    res.json({ success: true, steamId: user.steamId });
});

app.get('/api/giveaways/list', (req, res) => res.json({ success: true, giveaways }));

app.post('/api/giveaways/join', async (req, res) => {
    const { tgId, giveawayId } = req.body;
    const giveaway = giveaways.find(g => g._id === giveawayId);
    if (!giveaway) return res.json({ success: false, error: 'Розыгрыш не найден' });
    if (giveaway.ended) return res.json({ success: false, error: 'Завершен' });
    if (giveaway.participants.includes(String(tgId))) return res.json({ success: false, error: 'Уже участвуете' });
    giveaway.participants.push(String(tgId));
    giveaway.participantsCount = giveaway.participants.length;
    saveData();
    res.json({ success: true });
});

app.post('/api/steam/inventory', async (req, res) => {
    let { steamId, tgId } = req.body;
    if (!steamId && tgId && users[tgId]) steamId = users[tgId].steamId;
    if (!steamId) return res.json({ success: false, error: 'Не указан SteamID' });
    try {
        let axiosConfig = { timeout: 10000 };
        if (PROXY_URL) axiosConfig.httpsAgent = new HttpsProxyAgent(PROXY_URL);
        const invRes = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`, axiosConfig);
        if (invRes?.data?.success && invRes.data.assets?.length > 0) return res.json({ success: true, items: invRes.data.assets, descriptions: invRes.data.descriptions });
    } catch (e) {}
    res.json({ success: false, error: 'Не удалось загрузить инвентарь.' });
});

app.get('/api/market/items', (req, res) => res.json({ success: true, items: marketItems }));

app.post('/api/market/add', (req, res) => {
    const item = req.body;
    const user = getOrCreateUser(item.tgId);
    item.price = parseFloat(item.price);
    item.buyerPrice = Math.round(item.price * 1.04);
    item._id = Date.now().toString();
    marketItems.push(item);
    saveData();
    res.json({ success: true, newBalance: user.balance });
});

app.post('/api/deals/buy', async (req, res) => {
    const { itemId, buyerTgId } = req.body;
    const buyer = getOrCreateUser(buyerTgId);
    const itemIndex = marketItems.findIndex(i => i._id === itemId);
    if (itemIndex === -1) return res.json({ success: false, error: 'Предмет не найден' });
    const item = marketItems[itemIndex];
    if (buyer.balance < item.buyerPrice) return res.json({ success: false, error: 'Недостаточно средств' });
    buyer.balance -= item.buyerPrice;
    const seller = getOrCreateUser(item.tgId, item.seller);
    seller.balance += item.price;
    marketItems.splice(itemIndex, 1);
    saveData();
    res.json({ success: true, newBalance: buyer.balance });
});

// Отдаем наш собственный стабильный каталог
app.get('/api/shop/items', (req, res) => {
    res.json({ success: true, items: shopCatalog });
});

app.post('/api/shop/buy', async (req, res) => {
    const { tgId, itemId, itemName, itemPrice } = req.body;
    if (!isShopOpen()) return res.json({ success: false, error: 'Магазин работает с 09:00 до 23:00' });
    const user = getOrCreateUser(tgId);
    const finalPrice = parseFloat(itemPrice);
    if (isNaN(finalPrice) || user.balance < finalPrice) return res.json({ success: false, error: 'Недостаточно средств' });
    if (!user.tradeUrl) return res.json({ success: false, error: 'Укажите Trade URL!' });
    
    user.balance -= finalPrice;
    saveData();
    try {
        await bot.sendMessage(tgId, `🛍 **Заказ оформлен!**\nСкин *${itemName || 'Предмет'}* куплен за ${finalPrice} ₽.\nАдминистратор скоро отправит трейд.`); 
        if (ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, `🔥 **Покупка в Магазине!**\n\n👤 ID: \`${user.tgId}\`\n🏷 Товар: *${itemName}*\n💰 Сумма: ${finalPrice} ₽\n🔗 Трейд:\n\`${user.tradeUrl}\``, { parse_mode: 'Markdown' });
        }
        res.json({ success: true, newBalance: user.balance });
    } catch (error) {
        user.balance += finalPrice; saveData();
        res.json({ success: false, error: 'Ошибка оформления.' });
    }
});

bot.on('message', async (msg) => {
    const text = msg.text || '';
    if (!text) return;

    if (text.startsWith('/start')) {
        const userId = msg.from ? msg.from.id : msg.chat.id;
        getOrCreateUser(userId, msg.from?.username, msg.from?.photo_url);
        await bot.sendMessage(msg.chat.id, '🟧⬛️ Добро пожаловать в **Skin Hub**!', {
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть Skin Hub', web_app: { url: WEBAPP_URL } }]] }
        });
        return;
    }

    // --- АВТОМАТИЧЕСКИЙ ПАРСЕР СКИНОВ > 1000 РУБ ---
    if (text === '/parser') {
        if (!isAdmin(msg)) return await bot.sendMessage(msg.chat.id, '❌ Нет прав.');
        await bot.sendMessage(msg.chat.id, '⏳ Подключаюсь к базе Steam... Начинаю парсинг и фильтрацию. Это займет около 10 секунд.');

        try {
            const response = await axios.get('https://csgobackpack.net/api/GetItemsList/v2/?no_details=true', { timeout: 20000 });
            const items = response.data.items_list;
            let parsedCatalog = [];
            let idCounter = 1;

            for (const key in items) {
                const item = items[key];
                const priceUsd = item.price?.['7_days']?.average || item.price?.['30_days']?.average || 0;
                const priceRub = Math.round(priceUsd * USD_TO_RUB);

                // Фильтруем мусор: оставляем только скины оружия, ножи и перчатки
                const isWeaponOrKnife = !key.includes('Sticker') && !key.includes('Case') &&
                                        !key.includes('Key') && !key.includes('Capsule') &&
                                        !key.includes('Patch') && !key.includes('Graffiti') &&
                                        !key.includes('Package') && !key.includes('Pin') &&
                                        !key.includes('Music Kit');

                if (priceRub >= 1000 && item.icon_url && isWeaponOrKnife) {
                    parsedCatalog.push({
                        id: `p_${idCounter++}`,
                        name: item.name,
                        image: `https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}/360fx360f`,
                        price: priceRub,
                        discount: null
                    });
                }
            }

            // Сортируем от самых дорогих к дешевым
            parsedCatalog.sort((a, b) => b.price - a.price);
            
            // Берем Топ-300 (чтобы WebApp не зависал у пользователей на слабых телефонах)
            shopCatalog = parsedCatalog.slice(0, 300);
            saveData();

            await bot.sendMessage(msg.chat.id, `✅ **Каталог успешно обновлен!**\n\nЗагружено **${shopCatalog.length}** премиум-скинов (от 1000 ₽ до ${shopCatalog[0].price} ₽).\nОткрой Web App, чтобы проверить результат!`, { parse_mode: 'Markdown' });
        } catch (e) {
            await bot.sendMessage(msg.chat.id, `❌ Ошибка парсинга: ${e.message}`);
        }
        return;
    }

    if (text.startsWith('/setprice')) {
        if (!isAdmin(msg)) return;
        const parts = text.split(' ');
        const targetId = parts[1];
        const newPrice = parseFloat(parts[2]);
        
        const itemIndex = shopCatalog.findIndex(i => i.id === targetId);
        if (itemIndex === -1) return await bot.sendMessage(msg.chat.id, `❌ Товар с ID ${targetId} не найден.`);

        shopCatalog[itemIndex].price = newPrice;
        saveData();
        await bot.sendMessage(msg.chat.id, `✅ Цена для **${shopCatalog[itemIndex].name}** обновлена на **${newPrice} ₽**!`, { parse_mode: 'Markdown' });
        return;
    }

    if (text.startsWith('/broadcast')) {
        if (!isAdmin(msg)) return;
        const broadcastText = text.replace('/broadcast', '').trim();
        let successCount = 0;
        for (const chatId of chats) {
            try { await bot.sendMessage(chatId, broadcastText, { parse_mode: 'Markdown' }); successCount++; } catch (err) {}
        }
        await bot.sendMessage(msg.chat.id, `📢 Рассылка завершена! Доставлено: ${successCount}`);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
