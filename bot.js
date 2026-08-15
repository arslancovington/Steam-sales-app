import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(TOKEN, { polling: true });

const db = {
    users: {},
    marketItems: [],
    giveaways: []
};

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Профиль
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

// Маркет
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
    giveaway.participants.push(String(tgId));
    res.json({ success: true });
});

// Steam API (Цены с провайдерами)
app.get('/api/steam/price', async (req, res) => {
    let { name, provider } = req.query;
    if (!name) return res.json({ success: true, price: 100 });

    try {
        let cleanName = name.replace(/™|★/g, '').trim();
        if (provider === 'csmoney') {
            const resp = await fetch(`https://cs.money/2.0/market/search?limit=1&search=${encodeURIComponent(cleanName)}`);
            const data = await resp.json();
            if (data.items?.length > 0) return res.json({ success: true, price: Math.round(data.items[0].price * 95) });
        }
        if (provider === 'lisskins') {
            const resp = await fetch(`https://lis-skins.ru/api/market/items/?search=${encodeURIComponent(cleanName)}`);
            const data = await resp.json();
            if (data.items?.length > 0) return res.json({ success: true, price: Math.round(data.items[0].price) });
        }
        const response = await fetch(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodeURIComponent(cleanName)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();
        if (data.success && data.lowest_price) {
            return res.json({ success: true, price: parseFloat(data.lowest_price.replace(/[^\d,]/g, '').replace(',', '.')) });
        }
    } catch (e) {}
    res.json({ success: true, price: 200 });
});

// Инвентарь
app.post('/api/steam/inventory', async (req, res) => {
    const { steamId } = req.body;
    if (!steamId) return res.json({ success: false, error: 'ID не указан' });
    try {
        const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await resp.json();
        res.json({ success: true, items: data.assets || [], descriptions: data.descriptions || [] });
    } catch (e) {
        res.json({ success: false, error: 'Ошибка загрузки' });
    }
});

// Биллинг (минимум 3 USDT)
app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, method, amount } = req.body;
    const numAmount = Number(amount);
    if (method === 'crypto') {
        if (numAmount < 3) return res.json({ success: false, error: 'Минимум 3 USDT' });
        const resp = await fetch('https://pay.crypt.bot/api/createInvoice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': process.env.CRYPTO_BOT_TOKEN },
            body: JSON.stringify({ asset: 'USDT', amount: String(numAmount), description: `Пополнение ${tgId}` })
        });
        const data = await resp.json();
        if (data.ok) return res.json({ success: true, invoiceUrl: data.result.pay_url });
    }
    res.json({ success: false, error: 'Ошибка' });
});

app.post('/api/billing/withdraw', (req, res) => {
    const { tgId, amount, address } = req.body;
    if (db.users[tgId]?.balance >= Number(amount)) {
        db.users[tgId].balance -= Number(amount);
        res.json({ success: true, newBalance: db.users[tgId].balance });
    } else res.json({ success: false, error: 'Нет средств' });
});

bot.on('message', (msg) => {
    if (msg.text?.startsWith('/newgiveaway')) bot.sendMessage(msg.chat.id, '✅ Розыгрыш принят!');
});

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
