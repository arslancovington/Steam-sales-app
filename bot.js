const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || 'YOUR_CRYPTO_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID';

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let users = {};
let marketItems = [];
let giveaways = [];

// Профиль пользователя
app.get('/api/user/profile', (req, res) => {
    const { tgId, tgUser } = req.query;
    if (!users[tgId]) {
        users[tgId] = { tgId, username: tgUser, balance: 0, rating: 5.0, completedDeals: 0, tradeUrl: '', steamId: '' };
    }
    res.json({ success: true, ...users[tgId] });
});

app.post('/api/user/save', (req, res) => {
    const { tgId, tradeUrl, steamId } = req.body;
    if (!users[tgId]) users[tgId] = { tgId, balance: 0, rating: 5.0, completedDeals: 0 };
    users[tgId].tradeUrl = tradeUrl;
    users[tgId].steamId = steamId;
    res.json({ success: true });
});

app.get('/api/market/items', (req, res) => {
    res.json({ success: true, items: marketItems });
});

app.post('/api/market/add', (req, res) => {
    const item = req.body;
    item._id = Date.now().toString();
    marketItems.push(item);
    res.json({ success: true, item });
});

app.post('/api/market/cancel', (req, res) => {
    const { itemId, tgId } = req.body;
    marketItems = marketItems.filter(i => !(i._id === itemId && String(i.tgId) === String(tgId)));
    res.json({ success: true });
});

app.get('/api/giveaways/list', (req, res) => {
    const formattedGiveaways = giveaways.map(g => ({
        ...g,
        participantsCount: g.participants ? g.participants.length : 0
    }));
    res.json({ success: true, giveaways: formattedGiveaways });
});

app.post('/api/giveaways/join', async (req, res) => {
    const { tgId, giveawayId } = req.body;
    const giveaway = giveaways.find(g => g._id === giveawayId);
    if (!giveaway) return res.json({ success: false, error: 'Розыгрыш не найден' });
    if (!giveaway.participants) giveaway.participants = [];
    if (giveaway.participants.includes(String(tgId))) return res.json({ success: false, error: 'Вы уже участвуете!' });

    giveaway.participants.push(String(tgId));
    giveaway.participantsCount = giveaway.participants.length;
    res.json({ success: true });
});

// Умная цена для предметов через встроенный fetch
app.get('/api/steam/price', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.json({ success: true, price: 50 });

    try {
        const encodedName = encodeURIComponent(name);
        const response = await fetch(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodedName}`);
        const data = await response.json();

        if (data && data.success && data.lowest_price) {
            let priceNum = parseFloat(data.lowest_price.replace(/[^\d,]/g, '').replace(',', '.'));
            return res.json({ success: true, price: priceNum || 50 });
        }
    } catch (e) { console.error("Price fetch error:", e.message); }

    const isCheap = name.toLowerCase().includes('sticker') || name.toLowerCase().includes('graffiti');
    res.json({ success: true, price: isCheap ? 30 : 250 });
});

app.post('/api/steam/inventory', async (req, res) => {
    try {
        const { steamId } = req.body;
        if (!steamId) {
            return res.json({ success: false, error: 'Steam ID не указан', items: [], descriptions: [] });
        }
        const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        if (!response.ok) throw new Error();
        const data = await response.json();
        res.json({ success: true, items: data.assets || [], descriptions: data.descriptions || [] });
    } catch (e) {
        res.json({ success: false, error: 'Ошибка загрузки инвентаря', items: [], descriptions: [] });
    }
});

app.post('/api/deals/buy', (req, res) => {
    const { tgId, itemId } = req.body;
    const itemIndex = marketItems.findIndex(i => i._id === itemId);
    if (itemIndex === -1) return res.json({ success: false, error: 'Лот не найден' });
    
    const item = marketItems[itemIndex];
    if (users[tgId].balance < Number(item.price)) return res.json({ success: false, error: 'Недостаточно средств' });

    users[tgId].balance -= Number(item.price);
    if (users[item.tgId]) users[item.tgId].balance += Number(item.price);

    marketItems.splice(itemIndex, 1);
    res.json({ success: true, newBalance: users[tgId].balance });
});

app.post('/api/billing/invoice', async (req, res) => {
    try {
        const { tgId, method, amount } = req.body;
        if (method === 'stars') {
            const link = await bot.createInvoiceLink('Пополнение', 'Steam Sales', JSON.stringify({tgId, amount}), '', 'XTR', [{label: 'Stars', amount: Number(amount)}]);
            return res.json({ success: true, invoiceUrl: link });
        }
        res.json({ success: true, invoiceUrl: 'https://crypt.bot/pay/test' });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

bot.on('message', async (msg) => {
    const text = msg.text || msg.caption;
    if (!text || !text.startsWith('/newgiveaway')) return;
    
    const lines = text.split('\n');
    let title = '', sponsor = '', timer = 'Скоро', image = '';

    lines.forEach(line => {
        if (line.toLowerCase().startsWith('приз:') || line.toLowerCase().startsWith('prize:')) 
            title = line.replace(/^(приз:|prize:)/i, '').trim();
        if (line.toLowerCase().startsWith('спонсор:') || line.toLowerCase().startsWith('sponsor:')) 
            sponsor = line.replace(/^(спонсор:|sponsor:)/i, '').trim();
        if (line.toLowerCase().startsWith('таймер:') || line.toLowerCase().startsWith('timer:')) 
            timer = line.replace(/^(таймер:|timer:)/i, '').trim();
        if (line.toLowerCase().startsWith('картинка:') || line.toLowerCase().startsWith('image:')) 
            image = line.replace(/^(картинка:|image:)/i, '').trim();
    });

    if (msg.photo && msg.photo.length > 0) {
        try {
            const photo = msg.photo[msg.photo.length - 1];
            const fileLink = await bot.getFileLink(photo.file_id);
            if (fileLink) image = fileLink;
        } catch (err) {
            console.error('Error fetching photo:', err.message);
        }
    }

    if (!title || !sponsor) {
        return bot.sendMessage(msg.chat.id, '❌ Ошибка! Укажите формат:\nПриз: Название\nСпонсор: @канал');
    }

    giveaways.push({
        _id: Date.now().toString(),
        title,
        sponsor,
        timer,
        image: image || 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f',
        participantsCount: 0,
        participants: []
    });

    bot.sendMessage(msg.chat.id, `✅ Розыгрыш приза "${title}" успешно добавлен в приложение!`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
