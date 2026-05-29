require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== 🔑 金鑰與環境變數設定區 ====================
const PUBLIC_VAPID_KEY = process.env.PUBLIC_VAPID_KEY;
const PRIVATE_VAPID_KEY = process.env.PRIVATE_VAPID_KEY;

// ⚠️ 您可以在 .env 檔或雲端平台上設定 FUGLE_API_KEY，或者直接把下方的字串替換成您的富果 Token
const FUGLE_API_KEY = process.env.FUGLE_API_KEY || 'NWYzYWU4YWEtNTMxMy00NmNjLWJlNDItZWY0OWMwZGE2NTJmIDI4MmYxODc0LTdmZDktNDIyYy05OGI0LWI5ZTJkODkyNGVhOA=='; 
// ===============================================================

if (PUBLIC_VAPID_KEY && PRIVATE_VAPID_KEY) {
    webpush.setVapidDetails(
        'mailto:willie0eilliw@gmail.com', // 您的電子信箱
        PUBLIC_VAPID_KEY,
        PRIVATE_VAPID_KEY
    );
    console.log('✅ Web Push VAPID 金鑰設定成功');
} else {
    console.warn('⚠️ 警告：缺少 VAPID 金鑰環境變數，推播通知功能將無法運作！');
}

// 儲存所有使用者的追蹤條件與訂閱資訊（記憶體儲存，重啟 Render 會清空）
let users = [];

// 前端同步訂閱資訊與警示門檻的 Endpoint
app.post('/api/subscribe', (req, res) => {
    const { subscription, configs } = req.body;

    if (!subscription) {
        return res.status(400).json({ error: '缺少訂閱資訊' });
    }

    let user = users.find(u => JSON.stringify(u.subscription) === JSON.stringify(subscription));

    if (!user) {
        user = {
            subscription,
            configs: configs || [],
            triggeredAlerts: {}
        };
        users.push(user);
        console.log('✨ 偵測到新手機訂閱！已加入雲端監控清單。');
    } else {
        user.configs = configs || [];
        console.log('🔄 使用者更新了監控條件，已同步至雲端。');
    }

    res.status(201).json({ success: true, message: '雲端同步成功！' });
});

// 前端即時查詢股價的 Endpoint (改回富果 API)
app.get('/api/stock/:symbol', async (req, res) => {
    const symbol = req.params.symbol;
    try {
        // 呼叫富果行情 API 取得即時當日行情 (Intraday Quotes)
        const response = await axios.get(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${symbol}`, {
            headers: { 'X-API-KEY': FUGLE_API_KEY }
        });

        // 解析富果回傳的收盤價或最新成交價
        const currentPrice = response.data.closePrice || response.data.lastTrade?.price;
        const name = response.data.name || symbol;

        if (!currentPrice) {
            return res.status(404).json({ error: '查無此股票目前的即時價格' });
        }

        res.json({
            symbol,
            name,
            currentPrice: parseFloat(currentPrice)
        });
    } catch (error) {
        console.error(`❌ 前端查詢股票 ${symbol} 失敗:`, error.message);
        res.status(500).json({ error: '無法自富果 API 取得即時數據，請檢查代號或金鑰。' });
    }
});

// 核心功能：定時循環檢查股價與計算回檔 (改回富果 API)
async function checkPrices() {
    console.log(`🔄 [排程] 開始執行富果 API 價格檢查... 當前監控人數: ${users.length}`);

    for (let user of users) {
        for (let config of user.configs) {
            const symbol = config.stockCode;         // 股票代號 (例: 2330)修改
            const periodMonths = parseInt(config.period); // 觀測時段 (例: 3 個月)
            const percentThreshold = parseFloat(config.percent); // 跌幅門檻 (例: 8%)

            const alertKey = `${symbol}-${periodMonths}-${percentThreshold}`;

            try {
                // 步驟 A：利用富果 API 取得目前最新價格
                const quoteRes = await axios.get(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quotes/${symbol}`, {
                    headers: { 'X-API-KEY': FUGLE_API_KEY }
                });
                const currentPrice = quoteRes.data.closePrice || quoteRes.data.lastTrade?.price;

                if (!currentPrice) {
                    console.warn(`⚠️ 無法取得 ${symbol} 的當前股價，跳過本次檢查。`);
                    continue;
                }

                // 步驟 B：計算歷史區間並呼叫富果 K 線 API (Historical Candles)
                const endDate = new Date().toISOString().split('T')[0];
                const startDateObj = new Date();
                startDateObj.setMonth(startDateObj.getMonth() - periodMonths);
                const startDate = startDateObj.toISOString().split('T')[0];

                const historyRes = await axios.get(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles`, {
                    params: { symbol: symbol, from: startDate, to: endDate }, //修改
                    headers: { 'X-API-KEY': FUGLE_API_KEY }
                });

                const candles = historyRes.data.candles || [];
                if (candles.length === 0) {
                    console.warn(`⚠️ 無法取得 ${symbol} 的歷史 K 線數據。`);
                    continue;
                }

                // 步驟 C：尋找這段時間的最高點
                const highestPrice = Math.max(...candles.map(c => c.high));

                // 步驟 D：計算目前跌幅
                const dropPercent = ((highestPrice - currentPrice) / highestPrice) * 100;

                console.log(`[監控詳情] 股票: ${symbol} | 目前價: ${currentPrice} | ${periodMonths}個月最高價: ${highestPrice} | 當前跌幅: ${dropPercent.toFixed(2)}%`);

                // 步驟 E：判斷是否觸發推播
                const isTriggered = dropPercent >= percentThreshold;

                if (isTriggered) {
                    // 如果尚未對該條件發過通知，才發送
                    if (!user.triggeredAlerts[alertKey]) {
                        user.triggeredAlerts[alertKey] = true; 

                        const message = `📉 富果策略盯盤：股票 ${symbol} 目前價格 ${currentPrice} 元，相較近 ${periodMonths} 個月最高價 ${highestPrice} 元已回檔 ${dropPercent.toFixed(2)}%（已達設定門檻 ${percentThreshold}%）！`;
                        
                        const payload = JSON.stringify({
                            title: '🔔 策略抄底提醒',
                            body: message,
                            icon: '/icon-192.png'
                        });

                        await webpush.sendNotification(user.subscription, payload);
                        console.log(`[Push Sent] 成功發送推播給使用者: ${message}`);
                    }
                } else {
                    // 股價回升到門檻內時解除標記，以便下次再度跌破時能重新觸發
                    if (user.triggeredAlerts[alertKey]) {
                        user.triggeredAlerts[alertKey] = false;
                        console.log(`[Alert Reset] 股票 ${symbol} 價格已回到設定範圍內，重設警報狀態。`);
                    }
                }

            } catch (err) {
                console.error(`❌ 監控股票 ${symbol} 時發生錯誤:`, err.message);
            }
        }
    }
}

// 設定每 5 分鐘自動執行一次價格檢查排程
setInterval(checkPrices, 5 * 60 * 1000);

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 後端伺服器已在連接埠 ${PORT} 啟動`);
});
