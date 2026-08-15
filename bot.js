<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Steam Sales</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root { --bg: #0b0f19; --card: #131b2e; --accent: #22c55e; --accent-glow: rgba(34, 197, 94, 0.4); --text: #f8fafc; --muted: #94a3b8; }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        body { background: var(--bg); color: var(--text); padding-bottom: 80px; }

        /* Экран загрузки CS 1.6 */
        #loader { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 9999; display: flex; flex-direction: column; justify-content: center; align-items: center; transition: opacity 0.5s ease; }
        .cs-logo { font-size: 26px; font-weight: bold; color: #ffcc00; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 20px; text-shadow: 0 0 12px rgba(255,204,0,0.6); }
        .progress-bar-container { width: 260px; height: 16px; border: 2px solid #ffcc00; padding: 2px; background: #111; border-radius: 4px; }
        .progress-bar { width: 0%; height: 100%; background: #ffcc00; transition: width 0.2s; box-shadow: 0 0 8px #ffcc00; }
        .loading-text { margin-top: 12px; font-size: 13px; color: var(--muted); }

        /* Шапка */
        .header { display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; background: var(--card); border-bottom: 1px solid #1e293b; }
        .user-info { display: flex; align-items: center; gap: 10px; }
        .user-avatar { width: 42px; height: 42px; border-radius: 50%; background: #222; border: 2px solid var(--accent); object-fit: cover; }
        .user-name { font-weight: bold; font-size: 15px; font-style: italic; letter-spacing: 0.5px; }
        .user-rating { font-size: 11px; color: #fbbf24; margin-top: 2px; }

        /* Баланс в правом верхнем углу */
        .balance-box { background: #0f172a; padding: 6px 12px; border-radius: 10px; font-weight: bold; color: var(--accent); display: flex; align-items: center; gap: 6px; border: 1px solid #1e293b; cursor: pointer; box-shadow: 0 0 10px var(--accent-glow); }
        .balance-box span { font-size: 15px; }
        .balance-add { background: var(--accent); color: #000; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: bold; }

        /* Контент */
        .container { padding: 15px; display: none; }
        .container.active { display: block; }
        
        h2, h3 { margin-bottom: 12px; font-style: italic; letter-spacing: 0.5px; }
        input, select { width: 100%; padding: 12px; margin: 8px 0; background: #1e293b; border: 1px solid #334155; color: #fff; border-radius: 10px; font-size: 14px; }
        button { width: 100%; padding: 12px; background: var(--accent); color: #000; font-weight: bold; border: none; border-radius: 10px; cursor: pointer; margin-top: 8px; font-size: 14px; text-transform: uppercase; box-shadow: 0 0 10px var(--accent-glow); }
        button:active { opacity: 0.8; }

        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 10px; }
        .card { background: var(--card); border-radius: 12px; padding: 12px; text-align: center; border: 1px solid #1e293b; position: relative; }
        .card img { width: 90px; height: 90px; object-fit: contain; margin-bottom: 5px; }
        .card-title { font-size: 12px; margin: 5px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
        .card-price { color: var(--accent); font-weight: bold; font-size: 15px; margin-bottom: 8px; }
        .card-price-uzs { font-size: 11px; color: var(--muted); margin-bottom: 6px; }

        /* Нижнее меню */
        .navbar { display: flex; justify-content: space-around; background: var(--card); position: fixed; bottom: 0; left: 0; width: 100%; padding: 8px 0; border-top: 1px solid #1e293b; z-index: 100; }
        .nav-item { color: var(--muted); text-align: center; font-size: 10px; cursor: pointer; flex: 1; text-transform: uppercase; transition: 0.2s; }
        .nav-item.active { color: var(--accent); text-shadow: 0 0 8px var(--accent-glow); }
        .nav-item svg { width: 22px; height: 22px; fill: currentColor; margin: 0 auto 2px auto; display: block; }

        .section-box { background: var(--card); border-radius: 12px; padding: 15px; margin-bottom: 15px; border: 1px solid #1e293b; }
        .lot-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #1e293b; font-size: 13px; }
    </style>
</head>
<body>

    <!-- Экран загрузки CS 1.6 -->
    <div id="loader">
        <div class="cs-logo">STEAM SALES v1.6</div>
        <div class="progress-bar-container">
            <div class="progress-bar" id="progressBar"></div>
        </div>
        <div class="loading-text" id="loadingText">Инициализация ресурсов...</div>
    </div>

    <!-- Шапка -->
    <div class="header">
        <div class="user-info">
            <img id="userAvatar" class="user-avatar" src="" alt="">
            <div>
                <div id="userName" class="user-name">Игрок</div>
                <div class="user-rating">★ Рейтинг: <span id="userRating">5.0</span></div>
            </div>
        </div>
        <div class="balance-box" onclick="switchTab('wallet')">
            <div><span id="userBalance">0</span> ₽</div>
            <div class="balance-add">+</div>
        </div>
    </div>

    <!-- Вкладка 1: Маркетплейс -->
    <div id="tab-market" class="container active">
        <input type="text" id="searchInput" placeholder="🔍 Поиск предмета..." oninput="filterMarket()">
        <div class="grid" id="marketGrid"></div>
    </div>

    <!-- Вкладка 2: Инвентарь (Вход через Trade URL) -->
    <div id="tab-inventory" class="container">
        <h3>Авторизация через Steam</h3>
        <input type="text" id="tradeUrlInput" placeholder="Вставьте вашу Trade URL...">
        <button onclick="saveAndLoadInventory()">Войти и загрузить инвентарь</button>
        <div class="grid" id="inventoryGrid" style="margin-top: 15px;"></div>
    </div>

    <!-- Вкладка 3: Розыгрыши -->
    <div id="tab-giveaways" class="container">
        <h3>Активные розыгрыши</h3>
        <div id="giveawaysList"></div>
    </div>

    <!-- Вкладка 4: Профиль -->
    <div id="tab-profile" class="container">
        <div class="section-box">
            <h3>📦 Активные лоты</h3>
            <div id="activeLotsList"><p style="color: var(--muted); font-size: 13px;">Нет выставленных лотов</p></div>
        </div>
        <div class="section-box">
            <h3>📜 История сделок</h3>
            <div id="dealHistoryList"><p style="color: var(--muted); font-size: 13px;">История сделок пуста</p></div>
        </div>
    </div>

    <!-- Вкладка 5: Кошелек -->
    <div id="tab-wallet" class="container">
        <div class="section-box">
            <h3>Пополнение баланса</h3>
            <input type="number" id="topupAmount" placeholder="Сумма в рублях (₽)">
            <button onclick="payCrypto()" style="background: #2481cc; color: #fff;">💳 Пополнить CryptoBot (от 3 USDT)</button>
            <button onclick="payStars()" style="background: #e1ab3f; color: #000;">⭐ Пополнить Telegram Stars</button>
        </div>

        <div class="section-box">
            <h3>P2P UZ (Мин. 200 ₽)</h3>
            <input type="number" id="p2pAmountRub" placeholder="Сумма пополнения в рублях (₽)">
            <button onclick="payP2P()" style="background: #3b82f6; color: #fff;">💳 Запросить реквизиты (P2P UZ)</button>
        </div>

        <div class="section-box">
            <h3>Вывод средств</h3>
            <input type="number" id="withdrawAmount" placeholder="Сумма вывода (₽)">
            <input type="text" id="withdrawDetails" placeholder="Номер карты или реквизиты">
            <button onclick="requestWithdraw()" style="background: #ef4444; color: #fff;">Запросить вывод</button>
        </div>
    </div>

    <!-- Нижнее меню -->
    <div class="navbar">
        <div class="nav-item active" onclick="switchTab('market')">
            <svg viewBox="0 0 24 24"><path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.60 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/></svg>
            Маркет
        </div>
        <div class="nav-item" onclick="switchTab('inventory')">
            <svg viewBox="0 0 24 24"><path d="M20 6h-4V4c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4zm10 15H4V8h16v11z"/></svg>
            Инвентарь
        </div>
        <div class="nav-item" onclick="switchTab('giveaways')">
            <svg viewBox="0 0 24 24"><path d="M20 6h-2.18c.11-.31.18-.65.18-1 0-1.66-1.34-3-3-3-1.05 0-1.96.54-2.5 1.35l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 12 7.5 15.38 12 17 10.83 14.92 8H20v6z"/></svg>
            Розыгрыши
        </div>
        <div class="nav-item" onclick="switchTab('profile')">
            <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
            Профиль
        </div>
        <div class="nav-item" onclick="switchTab('wallet')">
            <svg viewBox="0 0 24 24"><path d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
            Кошелек
        </div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();
        const tgUser = tg.initDataUnsafe.user || { id: 12345, first_name: 'Игрок', username: 'guest' };
        
        // Восстановление сохраненного профиля Steam или Telegram
        let savedSteam = JSON.parse(localStorage.getItem('steamUser') || 'null');
        if (savedSteam) {
            document.getElementById('userName').innerText = savedSteam.name;
            document.getElementById('userAvatar').src = savedSteam.avatar;
            if (savedSteam.tradeUrl) document.getElementById('tradeUrlInput').value = savedSteam.tradeUrl;
        } else {
            document.getElementById('userName').innerText = tgUser.first_name;
            if (tgUser.photo_url) document.getElementById('userAvatar').src = tgUser.photo_url;
        }

        async function updateBalance() {
            try {
                const res = await fetch(`/api/user/profile?tgId=${tgUser.id}`);
                const data = await res.json();
                if (data.success) {
                    document.getElementById('userBalance').innerText = data.balance;
                    document.getElementById('userRating').innerText = data.rating;
                }
            } catch(e) {}
        }
        setInterval(updateBalance, 5000);
        updateBalance();

        let progress = 0;
        const progressBar = document.getElementById('progressBar');
        const loadingText = document.getElementById('loadingText');
        const loader = document.getElementById('loader');
        const stages = ["Загрузка моделей...", "Синхронизация Steam API...", "Подключение к P2P...", "Готово!"];

        let loadInterval = setInterval(() => {
            progress += Math.floor(Math.random() * 20) + 10;
            if (progress >= 100) {
                progress = 100;
                clearInterval(loadInterval);
                loader.style.opacity = '0';
                setTimeout(() => loader.style.display = 'none', 400);
            }
            progressBar.style.width = progress + '%';
            let idx = Math.floor((progress / 100) * (stages.length - 1));
            loadingText.innerText = stages[idx];
        }, 120);

        function switchTab(tabId) {
            document.querySelectorAll('.container').forEach(c => c.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.getElementById('tab-' + tabId).classList.add('active');
            event.currentTarget.classList.add('active');
            if (tabId === 'profile') loadProfileData();
            if (tabId === 'wallet') updateBalance();
        }

        // Вход по трейд-ссылке и загрузка инвентаря
        async function saveAndLoadInventory() {
            const tradeUrl = document.getElementById('tradeUrlInput').value;
            if (!tradeUrl || !tradeUrl.includes('partner=')) return alert('Введите корректную Trade URL!');
            
            const res = await fetch('/api/steam/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tradeUrl })
            });
            const data = await res.json();
            const grid = document.getElementById('inventoryGrid');
            grid.innerHTML = '';
            
            if (data.success) {
                // Если Steam вернул имя или аватар, обновляем шапку (Вход через Steam успешен)
                if (data.profile) {
                    document.getElementById('userName').innerText = data.profile.name;
                    document.getElementById('userAvatar').src = data.profile.avatar;
                    localStorage.setItem('steamUser', JSON.stringify({ name: data.profile.name, avatar: data.profile.avatar, tradeUrl }));
                }

                if (data.items && data.items.length > 0) {
                    data.items.forEach(item => {
                        const desc = data.descriptions.find(d => d.classid === item.classid && d.instanceid === item.instanceid);
                        if (!desc) return;
                        
                        const card = document.createElement('div');
                        card.className = 'card';
                        card.innerHTML = `
                            <img src="https://community.cloudflare.steamstatic.com/economy/image/${desc.icon_url}" alt="">
                            <div class="card-title">${desc.market_hash_name}</div>
                            <button onclick="sellItem('${desc.market_hash_name}', '${desc.icon_url}', '${tradeUrl}')">Продать</button>
                        `;
                        grid.appendChild(card);
                    });
                } else {
                    grid.innerHTML = '<p style="grid-column: span 2; text-align: center; color: var(--muted);">Инвентарь пуст или профиль скрыт</p>';
                }
            } else {
                alert(data.error || 'Ошибка загрузки инвентаря');
            }
        }

        async function sellItem(name, iconUrl, tradeUrl) {
            const priceRes = await fetch(`/api/steam/price?name=${encodeURIComponent(name)}`);
            const priceData = await priceRes.json();
            const price = priceData.price || 150;
            
            const res = await fetch('/api/market/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, iconUrl, price, tgId: tgUser.id, tradeUrl })
            });
            const data = await res.json();
            if (data.success) {
                alert('Предмет выставлен на маркет!');
                loadMarketItems();
            }
        }

        async function loadMarketItems() {
            const res = await fetch('/api/market/items');
            const data = await res.json();
            const grid = document.getElementById('marketGrid');
            grid.innerHTML = '';
            
            if (data.success && data.items.length > 0) {
                data.items.forEach(item => {
                    const priceUzs = Math.round(item.price * 175).toLocaleString();
                    const card = document.createElement('div');
                    card.className = 'card';
                    card.innerHTML = `
                        <img src="https://community.cloudflare.steamstatic.com/economy/image/${item.iconUrl}" alt="">
                        <div class="card-title">${item.name}</div>
                        <div class="card-price">${item.price} ₽</div>
                        <div class="card-price-uzs">≈ ${priceUzs} сўм</div>
                        <button onclick="buyItem('${item._id}')">Купить</button>
                    `;
                    grid.appendChild(card);
                });
            } else {
                grid.innerHTML = '<p style="grid-column: span 2; text-align: center; color: var(--muted);">Маркет пуст</p>';
            }
        }

        async function buyItem(itemId) {
            const buyerTradeUrl = prompt('Введите вашу Trade URL:');
            if (!buyerTradeUrl) return;

            const res = await fetch('/api/deals/buy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ buyerTgId: tgUser.id, buyerTradeUrl, itemId })
            });
            const data = await res.json();
            if (data.success) {
                alert('Запрос на покупку создан!');
                loadMarketItems();
            } else {
                alert(data.error || 'Ошибка');
            }
        }

        async function loadProfileData() {
            const res = await fetch(`/api/user/profile?tgId=${tgUser.id}`);
            const data = await res.json();
            if (data.success) {
                document.getElementById('userRating').innerText = data.rating;
                const historyContainer = document.getElementById('dealHistoryList');
                historyContainer.innerHTML = '';
                if (data.history && data.history.length > 0) {
                    data.history.forEach(h => {
                        historyContainer.innerHTML += `<div class="lot-item"><span>${h}</span></div>`;
                    });
                } else {
                    historyContainer.innerHTML = '<p style="color: var(--muted); font-size: 13px;">История сделок пуста</p>';
                }
            }

            const marketRes = await fetch('/api/market/items');
            const marketData = await marketRes.json();
            const activeContainer = document.getElementById('activeLotsList');
            activeContainer.innerHTML = '';

            if (marketData.success && marketData.items.length > 0) {
                const userLots = marketData.items.filter(i => String(i.tgId) === String(tgUser.id));
                if (userLots.length > 0) {
                    userLots.forEach(lot => {
                        const priceUzs = Math.round(lot.price * 175).toLocaleString();
                        activeContainer.innerHTML += `
                            <div class="lot-item">
                                <span>${lot.name} - <b>${lot.price} ₽</b> <i style="color:var(--muted); font-size:11px;">(${priceUzs} сўм)</i></span>
                                <button onclick="cancelLot('${lot._id}')" style="width: auto; padding: 6px 10px; background: #ef4444; color: #fff; margin: 0; font-size: 11px;">Снять</button>
                            </div>
                        `;
                    });
                    return;
                }
            }
            activeContainer.innerHTML = '<p style="color: var(--muted); font-size: 13px;">Нет активных лотов</p>';
        }

        async function cancelLot(itemId) {
            const res = await fetch('/api/market/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemId, tgId: tgUser.id })
            });
            const data = await res.json();
            if (data.success) {
                loadProfileData();
                loadMarketItems();
            }
        }

        async function payCrypto() {
            const amount = document.getElementById('topupAmount').value;
            const res = await fetch('/api/billing/invoice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tgId: tgUser.id, method: 'crypto', amount })
            });
            const data = await res.json();
            if (data.success) window.location.href = data.url;
            else alert(data.error || 'Ошибка');
        }

        async function payStars() {
            const amount = document.getElementById('topupAmount').value;
            const res = await fetch('/api/billing/invoice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tgId: tgUser.id, method: 'stars', amount })
            });
            const data = await res.json();
            if (data.success) tg.openInvoice(data.url);
            else alert(data.error || 'Ошибка');
        }

        async function payP2P() {
            const amountRub = document.getElementById('p2pAmountRub').value;
            if (!amountRub || amountRub < 200) return alert('Минимальная сумма пополнения P2P UZ: 200 рублей!');
            
            const res = await fetch('/api/billing/p2p', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tgId: tgUser.id, username: tgUser.username, amountRub })
            });
            const data = await res.json();
            alert(data.message || data.error);
        }

        async function requestWithdraw() {
            const amount = document.getElementById('withdrawAmount').value;
            const details = document.getElementById('withdrawDetails').value;
            if (!amount || !details) return alert('Заполните поля');
            const res = await fetch('/api/billing/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tgId: tgUser.id, amount, details })
            });
            const data = await res.json();
            alert(data.message || data.error);
        }

        function filterMarket() {
            let q = document.getElementById('searchInput').value.toLowerCase();
            document.querySelectorAll('#marketGrid .card').forEach(c => {
                let t = c.querySelector('.card-title').innerText.toLowerCase();
                c.style.display = t.includes(q) ? 'block' : 'none';
            });
        }

        loadMarketItems();
    </script>
</body>
</html>
