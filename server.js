// server.js
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. 設定 Web Push 的 VAPID Keys (請替換為你生成的金鑰)
const publicVapidKey = 'BOqI-NMOQANwPM44bvi_XXkbaTaI4htRS4tooJcDD8MY6u2fJwNnnhl_RvjJNsdlXEuiodPQMzJMlhg961gJrzw';
const privateVapidKey = 'aYV7hfV0vnaUaWCmJxB0ZVbuwTh4F_s4Jq7bUtlPD_s';
webpush.setVapidDetails('mailto:your-email@example.com', publicVapidKey, privateVapidKey);

// 2. 儲存使用者的推播訂閱資訊 (雛形先存在記憶體，實務上應存入 MongoDB 或 SQL)
let subscriptions = [];

// 前端 PWA 傳送訂閱資訊到這個 API
app.post('/api/subscribe', (req, res) => {
    const subscription = req.body;
    subscriptions.push(subscription);
    res.status(201).json({ message: '訂閱成功！' });
});

// 3. 呼叫 Fugle API 取得即時股價的函式
async function getStockPrice(symbol) {
    const fugleApiKey = 'NWYzYWU4YWEtNTMxMy00NmNjLWJlNDItZWY0OWMwZGE2NTJmIDI4MmYxODc0LTdmZDktNDIyYy05OGI0LWI5ZTJkODkyNGVhOA==';
    // Fugle WebSocket/REST API 終端 (這裡以 REST API 獲取盤中報價為例)
    const url = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${symbol}`;
    
    try {
        const response = await axios.get(url, {
            headers: { 'X-API-KEY': fugleApiKey }
        });
        // 根據 Fugle API 的 JSON 結構取出最新成交價
        return response.data.lastPrice; 
    } catch (error) {
        console.error(`無法取得 ${symbol} 股價:`, error.message);
        return null;
    }
}

// 4. 設定排程任務 (Cron Job) - 每天早上 9 點到下午 1 點，每 5 分鐘檢查一次
cron.schedule('*/5 9-13 * * 1-5', async () => {
    console.log('啟動盯盤排程...');
    
    const symbol = '00981A';
    const currentPrice = await getStockPrice(symbol);
    
    // 這裡實作你的提醒邏輯，例如：跌破某個價格 (假設跌破 15 元)
    const targetPrice = 15.0; 

    if (currentPrice && currentPrice <= targetPrice) {
        const payload = JSON.stringify({
            title: '📉 股價下跌提醒',
            body: `${symbol} 目前股價 ${currentPrice}，已達到你設定的加倉提醒！`
        });

        // 廣播給所有有訂閱的手機
        subscriptions.forEach(sub => {
            webpush.sendNotification(sub, payload).catch(err => console.error('推播失敗', err));
        });
    }
});

app.get('/api/price/:symbol', async (req, res) => {
    const symbol = req.params.symbol;
    const price = await getStockPrice(symbol); // 呼叫你原本就寫好的 getStockPrice 函式
    
    if (price) {
        res.json({ symbol: symbol, price: price });
    } else {
        res.status(404).json({ error: '無法取得股價' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`伺服器啟動於 port ${PORT}`));

