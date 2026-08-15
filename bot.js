import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

// Инициализация бота с безопасным поллингом
const bot = new TelegramBot(TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    console.error("⚠️ Поллинг ошибка:", error.message);
});

// База данных в памяти
const db = {
    users: {},
    marketItems: [],
    giveaways: []
};

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// Отдача фронтенда
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Профиль пользователя
app.get('/api/user/profile', (req, res) => {
    const { tgId, tgUser } = req.query;
    if (!db.users[tgId]) {
        db.users[tgId] = { tgId, username: tgUser, balance: 0, rating: 5.0, completedDeals: 0, tradeUrl: '', steamId: '' };
    }
    res.json({ success: true, ...db.users[tgId] });
});

app.post('/api/user/save', (req, res) => {
    const { tgId, tradeUrl, steamId } = req.body;
    if (!db.users[tgId]) db.users[tgId] = { tgId, balance: 0, rating: 5.0, completedDeals: 0 };
    db.users[tgId].tradeUrl = tradeUrl;
    db.users[tgId].steamId = steamId;
    res.json({ success: true });
});

// Маркетплейс
app.get('/api/market/items', (req, res) => res.json({ success: true, items: db.marketItems }));

app.post('/api/market/add', (req, res) => {
    const item = { ...req.body, _id: Date.now().toString() };
    db.marketItems.push(item);
    res.json({ success: true, item });
});

app.post('/api/market/cancel', (req, res) => {
    const { itemId, tgId } = req.body;
    db.marketItems = db.marketItems.filter(i => !(i._id === itemId && String(i.tgId) === String(tgId)));
    res.json({ success: true });
});

// Розыгрыши
app.get('/api/giveaways/list', (req, res) => {
    const formatted = db.giveaways.map(g => ({ ...g, participantsCount: g.participants.length }));
    res.json({ success: true, giveaways: formatted });
});

app.post('/api/giveaways/join', async (req, res) => {
    const { tgId, giveawayId } = req.body;
    const giveaway = db.giveaways.find(g => g._id === giveawayId);
    if (!giveaway) return res.json({ success: false, error: 'Розыгрыш не найден' });
    if (giveaway.participants.includes(String(tgId))) return res.json({ success: false, error: 'Вы уже участвуете!' });

    if (giveaway.sponsor.includes('@')) {
        try {
            const sponsorUsername = giveaway.sponsor.match(/@[\w\d_]+/)[0];
            const chatMember = await bot.getChatMember(sponsorUsername, tgId);
            if (!['creator', 'administrator', 'member'].includes(chatMember.status)) {
                return res.json({ success: false, error: `Подпишитесь на спонсора: ${sponsorUsername}` });
            }
        } catch (e) {}
    }

    giveaway.participants.push(String(tgId));
    res.json({ success: true });
});

// Steam API (Цены и инвентарь)
app.get('/api/steam/price', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.json({ success: true, price: 50 });

    try {
        const response = await fetch(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodeURIComponent(name)}`);
        const data = await response.json();
        if (data && data.success && data.lowest_price) {
            let priceNum = parseFloat(data.lowest_price.replace(/[^\d,]/g, '').replace(',', '.'));
            return res.json({ success: true, price: priceNum || 50 });
        }
    } catch (e) {}

    const isCheap = name.toLowerCase().includes('sticker') || name.toLowerCase().includes('graffiti');
    res.json({ success: true, price: isCheap ? 30 : 250 });
});

app.post('/api/steam/inventory', async (req, res) => {
    try {
        const { steamId } = req.body;
        if (!steamId) return res.json({ success: false, error: 'Steam ID не указан', items: [], descriptions: [] });
        
        const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`;
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!response.ok) throw new Error("Steam API error");
        
        const data = await response.json();
        res.json({ success: true, items: data.assets || [], descriptions: data.descriptions || [] });
    } catch (e) {
        res.json({ success: false, error: 'Профиль закрыт или инвентарь недоступен', items: [], descriptions: [] });
    }
});

// Сделки (покупка)
app.post('/api/deals/buy', (req, res) => {
    const { tgId, itemId } = req.body;
    const index = db.marketItems.findIndex(i => i._id === itemId);
    if (index === -1) return res.json({ success: false, error: 'Лот не найден' });
    
    const item = db.marketItems[index];
    if (!db.users[tgId] || db.users[tgId].balance < Number(item.price)) {
        return res.json({ success: false, error: 'Недостаточно средств' });
    }

    db.users[tgId].balance -= Number(item.price);
    if (db.users[item.tgId]) {
        db.users[item.tgId].balance += Number(item.price);
        bot.sendMessage(item.tgId, `🎉 Ваш скин "${item.name}" успешно продан за ${item.price} ₽!`).catch(()=>{});
    }

    db.marketItems.splice(index, 1);
    res.json({ success: true, newBalance: db.users[tgId].balance });
});

// Оплата и вывод
app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, method, amount } = req.body;
    if (method === 'stars') {
        try {
            const link = await bot.createInvoiceLink('Пополнение', 'Steam Sales', JSON.stringify({tgId, amount}), '', 'XTR', [{label: 'Stars', amount: Number(amount)}]);
            return res.json({ success: true, invoiceUrl: link });
        } catch(e) { return res.json({ success: false, error: e.message }); }
    }
    
    if (method === 'crypto') {
        const CRYPTO_TOKEN = process.env.CRYPTO_BOT_TOKEN;
        if (!CRYPTO_TOKEN) return res.json({ success: false, error: 'Токен CryptoBot не настроен' });
        try {
            const resp = await fetch('https://pay.crypt.bot/api/createInvoice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': CRYPTO_TOKEN },
                body: JSON.stringify({ asset: 'USDT', amount: String(amount), description: `Пополнение баланса ${tgId}` })
            });
            const data = await resp.json();
            if (data.ok) return res.json({ success: true, invoiceUrl: data.result.pay_url });
        } catch(e) {}
    }
    res.json({ success: false, error: 'Ошибка создания счета' });
});

app.post('/api/billing/withdraw', (req, res) => {
    const { tgId, amount, address } = req.body;
    const withdrawAmount = Number(amount);
    if (!db.users[tgId] || db.users[tgId].balance < withdrawAmount) return res.json({ success: false, error: 'Недостаточно средств' });
    
    db.users[tgId].balance -= withdrawAmount;
    if (process.env.ADMIN_CHAT_ID) {
        bot.sendMessage(process.env.ADMIN_CHAT_ID, `💸 Заявка на вывод:\nUser: ${tgId}\nСумма: ${withdrawAmount} ₽\nРеквизиты: ${address}`).catch(()=>{});
    }
    res.json({ success: true, newBalance: db.users[tgId].balance });
});

// Телеграм-бот: создание розыгрышей через команду /newgiveaway
bot.on('message', async (msg) => {
    const text = msg.text || msg.caption;
    if (!text || !text.startsWith('/newgiveaway')) return;
    
    const lines = text.split('\n');
    let title = '', sponsor = '', timer = 'Скоро', image = '';

    lines.forEach(line => {
        if (line.toLowerCase().match(/^(приз|prize):/)) title = line.replace(/^(приз|prize):/i, '').trim();
        if (line.toLowerCase().match(/^(спонсор|sponsor):/)) sponsor = line.replace(/^(спонсор|sponsor):/i, '').trim();
        if (line.toLowerCase().match(/^(таймер|timer):/)) timer = line.replace(/^(таймер|timer):/i, '').trim();
    });

    if (msg.photo && msg.photo.length > 0) {
        try {
            image = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
        } catch (err) {}
    }

    if (!title || !sponsor) {
        return bot.sendMessage(msg.chat.id, '❌ Укажите формат:\nПриз: Название\nСпонсор: @канал');
    }

    db.giveaways.push({
        _id: Date.now().toString(), title, sponsor, timer,
        image: image || 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f',
        participantsCount: 0, participants: []
    });

    bot.sendMessage(msg.chat.id, `✅ Розыгрыш "${title}" успешно добавлен!`);
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Bot and Server running together on port ${PORT}`);
});
