require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// 1. 從環境變數讀取 Web Push VAPID 金鑰
const PUBLIC_VAPID_KEY = process.env.PUBLIC_VAPID_KEY;
const PRIVATE_VAPID_KEY = process.env.PRIVATE_VAPID_KEY;

if (PUBLIC_VAPID_KEY && PRIVATE_VAPID_KEY) {
    webpush.setVapidDetails(
        'mailto:willie0eilliw@gmail.com', // 可以換成您的電子信箱
       'BOqI-NMOQANwPM44bvi_XXkbaTaI4htRS4tooJcDD8MY6u2fJwNnnhl_RvjJNsdlXEuiodPQMzJMlhg961gJrzw',
        'aYV7hfV0vnaUaWCmJxB0ZVbuwTh4F_s4Jq7bUtlPD_s'
    );
    console.log('✅ Web Push VAPID 金鑰設定成功');
} else {
    console.warn('⚠️ 警告：缺少 VAPID 金鑰環境變數，推播通知功能將無法運作！');
}

// 儲存所有使用者的追蹤條件與訂閱資訊（記憶體儲存，重啟伺服器會清空）
// 結構說明：
// [
//   {
//     subscription: { endpoint: '...', keys: { ... } },
//     configs: [ { symbol: '0050', periodMonths: 3, type: 'high', percent: 10 }, ... ],
//     triggeredAlerts: { '0050_high_10': true } // 用於避免重覆發送通知
//   }
// ]
let userMonitors = [];

// 【路由 1】 接收前端傳來的訂閱與多重監控條件
app.post('/api/subscribe', (req, res) => {
    try {
        const { subscription, configs } = req.body;

        if (!subscription || !configs) {
            return res.status(400).json({ success: false, message: '缺少必要參數' });
        }
        
        // 尋找此瀏覽器訂閱是否已存在
        const existIdx = userMonitors.findIndex(m => JSON.stringify(m.subscription) === JSON.stringify(subscription));
        
        if (existIdx > -1) {
            // 已存在則更新其監控設定
            userMonitors[existIdx].configs = configs;
            console.log(`[Subscription] 更新了現有使用者的監控條件，目前共有 ${configs.length} 個條件`);
        } else {
            // 新使用者則推入陣列
            userMonitors.push({ 
                subscription, 
                configs, 
                triggeredAlerts: {} 
            });
            console.log('[Subscription] 新增了全新的使用者訂閱與監控條件');
        }
        
        return res.status(200).json({ success: true, message: '後端已成功同步您的多重條件設定！' });
    } catch (error) {
        console.error('處理訂閱 API 時發生錯誤:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 【路由 2】 輔助 API：供前端即時查詢目前的股價（防呆測試用）
app.get('/api/price/:symbol', async (req, res) => {
    const { symbol } = req.params;
    try {
        const quoteUrl = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${symbol}`;
        const response = await axios.get(quoteUrl, {
            headers: { 'X-API-KEY': process.env.FUGLE_API_KEY }
        });
        
        // 確保在盤中、盤後、試撮期間都能抓到合理的當前價格
        const currentPrice = response.data.closePrice || response.data.lastPrice || response.data.referencePrice;
        
        return res.json({ symbol, price: currentPrice, name: response.data.name });
    } catch (error) {
        console.error(`查詢 ${symbol} 即時股價失敗:`, error.message);
        return res.status(500).json({ error: '無法取得股價數據' });
    }
});

// 【核心邏輯】 背景定期執行排程（比對價格並推播）
async function checkMonitors() {
    console.log(`\n⏰ [${new Date().toLocaleTimeString()}] 開始執行自動股價排程監測...`);
    
    if (userMonitors.length === 0) {
        console.log('目前沒有任何使用者訂閱監測。');
        return;
    }

    // 當次排程快取，避免在同一次檢查中對富果 API 重複請求相同的股票
    const priceCache = {};    // 格式: { '0050': 120 }
    const historyCache = {};  // 格式: { '0050_3': { high: 130, low: 100 } }

    for (let user of userMonitors) {
        for (let config of user.configs) {
            const { symbol, periodMonths, type, percent } = config;
            // 建立唯一的警報辨識 Key，防止同一個條件被連環轟炸發送
            const alertKey = `${symbol}_${type}_${percent}`;

            try {
                // 步驟 A：取得即時價格
                if (!priceCache[symbol]) {
                    const quoteUrl = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${symbol}`;
                    const res = await axios.get(quoteUrl, {
                        headers: { 'X-API-KEY': process.env.FUGLE_API_KEY }
                    });
                    priceCache[symbol] = res.data.closePrice || res.data.lastPrice || res.data.referencePrice;
                }
                const currentPrice = priceCache[symbol];
                if (!currentPrice) {
                    console.log(`無法取得股票 ${symbol} 的當前股價，跳過此條件。`);
                    continue;
                }

                // 步驟 B：取得歷史高低點
                const cacheKey = `${symbol}_${periodMonths}`;
                if (!historyCache[cacheKey]) {
                    const endDate = new Date().toISOString().split('T')[0];
                    const start = new Date();
                    start.setMonth(start.getMonth() - parseInt(periodMonths));
                    const startDate = start.toISOString().split('T')[0];

                    const candlesUrl = `https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${symbol}?from=${startDate}&to=${endDate}&fields=high,low`;
                    const res = await axios.get(candlesUrl, {
                        headers: { 'X-API-KEY': process.env.FUGLE_API_KEY }
                    });
                    
                    // 富果 v1.0 歷史 K 線陣列存放在 response.data.data 中
                    const candles = res.data.data || [];
                    if (candles.length > 0) {
                        const highs = candles.map(c => c.high).filter(h => h != null);
                        const lows = candles.map(c => c.low).filter(l => l != null);
                        historyCache[cacheKey] = {
                            high: Math.max(...highs),
                            low: Math.min(...lows)
                        };
                    } else {
                        historyCache[cacheKey] = null;
                    }
                }

                const history = historyCache[cacheKey];
                if (!history) {
                    console.log(`無法取得股票 ${symbol} 的歷史 K 線數據，跳過此條件。`);
                    continue;
                }

                // 步驟 C：條件判定與門檻計算
                let isTriggered = false;
                let message = '';

                if (type === 'high') {
                    // 超過最高點的 X % (例如：歷史最高點 100，10% 門檻就是 110)
                    const threshold = history.high * (1 + parseFloat(percent) / 100);
                    if (currentPrice >= threshold) {
                        isTriggered = true;
                        message = `📈【台股高點警報】股票 ${symbol} 目前市價 ${currentPrice}，已超過近 ${periodMonths} 個月最高點 (${history.high}) 的 ${percent}%（設定門檻：${threshold.toFixed(2)}）！`;
                    }
                } else if (type === 'low') {
                    // 低於最低點的 X % (例如：歷史最低點 100，8% 門檻就是 92)
                    const threshold = history.low * (1 - parseFloat(percent) / 100);
                    if (currentPrice <= threshold) {
                        isTriggered = true;
                        message = `📉【台股低點警報】股票 ${symbol} 目前市價 ${currentPrice}，已低於近 ${periodMonths} 個月最低點 (${history.low}) 的 ${percent}%（設定門檻：${threshold.toFixed(2)}）！`;
                    }
                }

                // 步驟 D：發送推播通知
                if (isTriggered) {
                    // 如果這個條件在之前的檢查中「尚未被觸發」，才發送通知（避免重覆轟炸）
                    if (!user.triggeredAlerts[alertKey]) {
                        user.triggeredAlerts[alertKey] = true; // 標記為已發送
                        
                        const payload = JSON.stringify({
                            title: '🔔 策略盯盤提醒',
                            body: message,
                            icon: '/icon-192.png'
                        });

                        await webpush.sendNotification(user.subscription, payload);
                        console.log(`[Push Sent] 成功發送推播給使用者: ${message}`);
                    }
                } else {
                    // 當股價回歸到門檻以內時，解除標記，未來若再次跨過門檻能再次發送通知
                    if (user.triggeredAlerts[alertKey]) {
                        user.triggeredAlerts[alertKey] = false;
                        console.log(`[Alert Reset] 股票 ${symbol} 價格已回到正常範圍，重設警報狀態。`);
                    }
                }

            } catch (err) {
                console.error(`❌ 監控股票 ${symbol} 時發生錯誤:`, err.message);
            }
        }
    }
}

// 設定每 5 分鐘自動執行一次價格檢查排程（5 * 60 * 1000 毫秒）
setInterval(checkMonitors, 5 * 60 * 1000);

// 啟動伺服器並綁定 Render 所需的環境變數 PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 後端盯盤伺服器已成功啟動，正監聽 Port: ${PORT}`);
});
