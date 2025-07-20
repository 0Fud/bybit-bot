// index.js

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';
import { createClient } from 'redis';

// --- APLIKACIJOS, BYBIT IR REDIS KONFIGŪRACIJA ---
const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID,
    BYBIT_API_KEY,
    BYBIT_API_SECRET
} = process.env;

const bybitClient = new RestClientV5({
    key: BYBIT_API_KEY,
    secret: BYBIT_API_SECRET,
    testnet: false // Pakeiskite į true, jei norite testuoti Testnet aplinkoje
});

const redisClient = createClient();
redisClient.on('error', err => console.error('❌ Redis Client Error', err));

// --- PAGALBINĖS FUNKCIJOS ---
const FIXED_RISK_USD = 1.0; // Fiksuota rizika USD per sandorį

const sendTelegramMessage = async (message) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHANNEL_ID,
            text: message,
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error('Klaida siunčiant pranešimą į Telegram:', error.response?.data || error.message);
    }
};


// --- PAGRINDINIS WEBHOOK MARŠRUTAS ---
app.post('/webhook', async (req, res) => {
    console.log('\n--- Gaunamas signalas ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    try {
        if (!data.action) {
            return res.status(200).json({ status: 'ignored', message: 'Veiksmas nenurodytas.' });
        }

        const ticker = data.ticker.replace('.P', '');
        const positionIdx = parseInt(data.positionIdx, 10);
        const redisKey = `${ticker}_${positionIdx}`;
        const side = data.direction === 'long' ? 'Buy' : 'Sell';

        switch (data.action) {

            // 1. Sukuriamas naujas sąlyginis orderis
            case 'NEW_PATTERN': {
                console.log(`[${ticker}] Vykdomas veiksmas: NEW_PATTERN`);
                
                const entryPrice = parseFloat(data.entryPrice);
                const takeProfit = parseFloat(data.takeProfit);

                // Skaičiuojame SL pagal 1:2 R:R, kaip nurodyta plane [cite: 27]
                const profitDistance = Math.abs(takeProfit - entryPrice);
                const riskDistance = profitDistance / 2;
                const stopLoss = data.direction === 'long' ? entryPrice - riskDistance : entryPrice + riskDistance;

                // Pozicijos dydžio skaičiavimas
                const sl_percent = Math.abs(entryPrice - stopLoss) / entryPrice;
                if (sl_percent === 0) throw new Error('Stop Loss negali būti lygus įėjimo kainai.');

                const position_size = FIXED_RISK_USD / (entryPrice * sl_percent);
                
                // Čia reikėtų pridėti apvalinimo logiką pagal instrumento taisykles (qtyStep)
                const qty = position_size.toFixed(3); // Laikinas pavyzdys, pritaikykite pagal poreikį

                const order = {
                    category: 'linear',
                    symbol: ticker,
                    side: side,
                    orderType: 'Market',
                    qty: String(qty),
                    triggerPrice: String(entryPrice),
                    triggerDirection: data.direction === 'long' ? 1 : 2,
                    stopOrderType: 'Market',
                    positionIdx: positionIdx,
                };
                
                console.log('Pateikiamas sąlyginis orderis:', order);
                const orderResponse = await bybitClient.submitOrder(order);

                if (orderResponse.retCode !== 0) {
                    throw new Error(`Bybit klaida (${orderResponse.retCode}): ${orderResponse.retMsg}`);
                }
                
                // Įsimename orderio ID į Redis [cite: 30]
                const orderId = orderResponse.result.orderId;
                await redisClient.set(redisKey, orderId);

                await sendTelegramMessage(`✅ [${ticker}] Pateiktas sąlyginis orderis. ID: ${orderId}`);
                break;
            }

            // 2. Anuliuojamas senas pattern'as ir atšaukiamas orderis
            case 'INVALIDATE_PATTERN': {
                console.log(`[${ticker}] Vykdomas veiksmas: INVALIDATE_PATTERN`);

                const orderId = await redisClient.get(redisKey); // Ieškome ID Redis'e [cite: 32]
                if (!orderId) {
                    console.log(`[${ticker}] Nerastas aktyvus sąlyginis orderis, kurį būtų galima atšaukti.`);
                    break;
                }

                console.log(`[${ticker}] Atšaukiamas orderis su ID: ${orderId}`);
                await bybitClient.cancelOrder({ category: 'linear', symbol: ticker, orderId: orderId });
                
                await redisClient.del(redisKey); // Ištriname iš Redis [cite: 33]
                await sendTelegramMessage(`🗑️ [${ticker}] Atšauktas sąlyginis orderis. ID: ${orderId}`);
                break;
            }

            // 3. Įeinama į poziciją, nustatomas SL/TP
            case 'ENTERED_POSITION': {
                console.log(`[${ticker}] Vykdomas veiksmas: ENTERED_POSITION`);
                
                await redisClient.del(redisKey); // Ištriname iš Redis, nes orderis įvykdytas [cite: 35]

                console.log(`[${ticker}] Nustatomas SL/TP...`);
                await bybitClient.setTradingStop({ // Nustatome SL/TP jau atidarytai pozicijai [cite: 36]
                    category: 'linear',
                    symbol: ticker,
                    positionIdx: positionIdx,
                    stopLoss: String(data.stopLoss),
                    takeProfit: String(data.takeProfit)
                });

                await sendTelegramMessage(`▶️ [${ticker}] Pozicija atidaryta! Nustatytas SL: ${data.stopLoss}, TP: ${data.takeProfit}`);
                break;
            }

            // 4. UŽdaroma pozicija dėl laiko
            case 'CLOSE_BY_AGE': {
                console.log(`[${ticker}] Vykdomas veiksmas: CLOSE_BY_AGE`);
                
                const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol: ticker });
                const position = positions.result.list.find(p => p.positionIdx === positionIdx && parseFloat(p.size) > 0);

                if (!position) {
                    await sendTelegramMessage(`[${ticker}] Bandyta uždaryti pasenusią poziciją, bet ji nerasta.`);
                    break;
                }

                await bybitClient.submitOrder({
                    category: 'linear',
                    symbol: ticker,
                    side: position.side === 'Buy' ? 'Sell' : 'Buy',
                    orderType: 'Market',
                    qty: position.size,
                    reduceOnly: true,
                    positionIdx: positionIdx,
                });

                await sendTelegramMessage(`[${ticker}] Pozicija sėkmingai uždaryta dėl laiko.`);
                break;
            }

            default:
                console.log(`Gautas veiksmas '${data.action}', kuris yra ignoruojamas.`);
        }

        res.status(200).json({ status: 'success', message: `Veiksmas '${data.action}' apdorotas.` });

    } catch (error) {
        console.error('❌ KLAIDA APDOROJANT SIGNALĄ:', error.message);
        await sendTelegramMessage(`❌ KLAIDA: ${error.message}`);
        res.status(500).json({ status: 'error', error: error.message });
    }
});


// --- SERVERIO PALEIDIMAS ---
const startServer = async () => {
    await redisClient.connect();
    app.listen(port, '0.0.0.0', () => {
        const msg = `🚀 Bybit botas (Stateful versija su Redis) paleistas ant porto ${port}`;
        console.log(msg);
        sendTelegramMessage(msg);
    });
};

startServer();