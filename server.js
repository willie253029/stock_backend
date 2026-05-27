const express = require('express');
const webpush = require('web-push');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 這裡填入你原本的 VAPID 金鑰
webpush.setVapidDetails(
  'mailto:your-email@example.com',
  'BOqI-NMOQANwPM44bvi_XXkbaTaI4htRS4tooJcDD8MY6u2fJwNnnhl_RvjJNsdlXEuiodPQMzJMlhg961gJrzw',
  'aYV7hfV0vnaUaWCmJxB0ZVbuwTh4F_s4Jq7bUtlPD_s'
);

const FUGLE_API_KEY = 'NWYzYWU4YWEtNTMxMy00NmNjLWJlNDItZWY0OWMwZGE2NTJmIDI4MmYxODc0LTdmZDktNDIyYy05OGI0LWI5ZTJkODkyNGVhOA==';

// 記憶體資料庫：用來存使用者的手機通道(subscription)以及他們各自訂的股票門檻
let userMonitors = []; 

// 1. 接收前端傳來的訂閱與多重監控條件
app.post('/api/subscribe', (req, requireRes) => {
    const { subscription, configs } = req.body;
    
    // 如果這個手機通道已經註冊過，就更新他的條件，沒註冊過就推入
    const existIdx = userMonitors.findIndex(m => JSON.stringify(m.subscription) === JSON.stringify(subscription));
    if (existIdx > -1) {
        userMonitors[existIdx].configs = configs;
    } else {
        userMonitors.push({ subscription, configs, triggeredAlerts: {} });
    }
    
    req.res.status(200).json({ success: true });
});

// 2. 輔助函式：去富果抓歷史 K 線，並回傳 X 個月內的最高點與最低點
async function getHistoricalHighLow(symbol, periodMonths) {
    try {
        // 計算出今天的日期與 X 個月前的日期
        const endDate = new Date().toISOString().split('T')[0];
        const startDateObj = new Date();
        startDateObj.setMonth(startDateObj.getMonth() - periodMonths);
        const startDate = startDateObj.toISOString().split('T')[0];

        // 呼叫富果歷史 K 線 API (以日線為基準)
        const url = `https://api.fugle.tw/marketdata/v1.0/stock/historical/candles?symbol=${symbol}&from=${startDate}&to=${endDate}&fields=high,low`;
        const response = await axios.get(url, { headers: { 'X-API-KEY': FUGLE_API_KEY } });
        
        const candles = response.data.candles || [];
        if (candles.length === 0) return null;

        // 從陣列中撈出這段期間的最高值與最低值
        let maxPrice = 0;
        let minPrice = Infinity;

        candles.forEach(c => {
            if (c.high > maxPrice) maxPrice = c.high;
            if (c.low < minPrice) minPrice = c.low;
        });

        return { high: maxPrice, low: minPrice };
    } catch (error) {
        console.error(`無法抓取 ${symbol} 的歷史資料:`, error.message);
        return null;
    }
}

// 3. 輔助函式：抓取目前即時股價
async function getCurrentPrice(symbol) {
    try {
        const url = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote?symbol=${symbol}`;
        const response = await axios.get(url, { headers: { 'X-API-KEY': FUGLE_API_KEY } });
        return response.data.lastTrialPrice || response.data.close || null;
    } catch (error) {
        return null;
    }
}

// 4. 🔥 核心核心：每 5 分鐘自動雲端盯盤與比對排程
setInterval(async () => {
    console.log('⏰ 雲端自動盯盤任務啟動...');
    
    // 遍歷所有使用者註冊的追蹤條件
    for (let user of userMonitors) {
        for (let stock of user.configs) {
            const currentPrice = await getCurrentPrice(stock.symbol);
            if (!currentPrice) continue;

            // 檢查這隻股票底下設定的所有門檻條件
            for (let t of stock.thresholds) {
                const historyData = await getHistoricalHighLow(stock.symbol, t.period);
                if (!historyData) continue;

                let isTriggered = false;
                let msgTitle = '';
                let msgBody = '';
                
                // 建立一個防重複發送的唯一 Key
                const alertKey = `${stock.symbol}_${t.period}_${t.type}_${t.percent}`;

                if (t.type === 'high') {
                    // 計算過往最高點加上百分比後的目標價
                    const targetPrice = historyData.high * (1 + t.percent / 100);
                    if (currentPrice >= targetPrice) {
                        isTriggered = true;
                        msgTitle = `🎯 股票 ${stock.symbol} 飆過門檻！`;
                        msgBody = `目前股價 ${currentPrice} 元，已超越 ${t.period}M內最高點(${historyData.high}元)的 ${t.percent}% (目標門檻: ${targetPrice.toFixed(1)}元)！`;
                    }
                } else if (t.type === 'low') {
                    // 計算過往最低點扣除百分比後的目標價
                    const targetPrice = historyData.low * (1 - t.percent / 100);
                    if (currentPrice <= targetPrice) {
                        isTriggered = true;
                        msgTitle = `📉 股票 ${stock.symbol} 跌破門檻！`;
                        msgBody = `目前股價 ${currentPrice} 元，已低於 ${t.period}M內最低點(${historyData.low}元)的 ${t.percent}% (目標門檻: ${targetPrice.toFixed(1)}元)！`;
                    }
                }

                // 如果符合觸發條件，且今天還沒有為這個條件發過推播 (避免每5分鐘轟炸一次)
                if (isTriggered && !user.triggeredAlerts[alertKey]) {
                    try {
                        await webpush.sendNotification(user.subscription, JSON.stringify({
                            title: msgTitle,
                            body: msgBody
                        }));
                        // 標記為今日已發送
                        user.triggeredAlerts[alertKey] = true;
                        console.log(`🚀 成功送出推播給使用者: ${msgTitle}`);
                    } catch (err) {
                        console.error('推播發送失敗', err);
                    }
                }
            }
        }
    }
}, 5 * 60 * 1000); // 每 5 分鐘跑一次

// 每天午夜 24:00 清空「今日已發送」的標記，讓隔天如果依然符合條件可以繼續提醒
setInterval(() => {
    userMonitors.forEach(user => { user.triggeredAlerts = {}; });
    console.log('🧹 已重設每日發送限制');
}, 24 * 60 * 60 * 1000);

// 提供原本的前端單純查詢當下價格的路由
app.get('/api/price/:symbol', async (req, res) => {
    const price = await getCurrentPrice(req.params.symbol);
    if (price) res.json({ symbol: req.params.symbol, price });
    else res.status(404).json({ error: '無法取得股價' });
});

app.listen(process.env.PORT || 3000, () => console.log('Server running!'));