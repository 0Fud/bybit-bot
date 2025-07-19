// Įkelia kintamuosius iš .env failo
import 'dotenv/config'; 
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';

// --- APLIKACIJOS IR SERVERIO KONFIGŪRACIJA ---
const app = express();
const port = process.env.PORT || 3000; 
app.use(express.json()); // Leidžia apdoroti JSON formato užklausas

// --- KONFIGŪRACIJA IR PREKYBOS TAISYKLĖS ---
const FIXED_RISK_USD = 100.0; // Fiksuota rizika vienam sandoriui
const MIN_SL_PERCENT = 0.0;
const MAX_SL_PERCENT = 10.0;

// --- APLINKOS KINTAMIEJI ---
const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID,
    BYBIT_API_KEY,
    BYBIT_API_SECRET
} = process.env;

// --- BŪSENOS SAUGOJIMAS ---
// Objektas, kuriame saugosime laukiančių (pending) orderių ID pagal tickerį
// Būtinas, kad žinotume, kurį orderį atšaukti gavus 'CANCEL_PENDING'
const pendingOrders = {};

// --- BYBIT KLIENTO INICIALIZAVIMAS ---
const bybitClient = new RestClientV5({
    key: BYBIT_API_KEY,
    secret: BYBIT_API_SECRET,
});

// --- PAGALBINĖS FUNKCIJOS ---
const sendTelegramMessage = async (message) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        console.log("Telegram kintamieji nenustatyti, pranešimas nesiunčiamas.");
        return;
    }
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHANNEL_ID, text: message, parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('Klaida siunčiant pranešimą į Telegram:', error.response?.data || error.message);
    }
};

// --- PAGRINDINIS MARŠRUTAS (WEBHOOK HANDLER) ---
app.post('/webhook', async (req, res) => {
    console.log('--- Naujas signalas ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    try {
        // Tikriname, ar API raktai nustatyti
        if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
            throw new Error('Kritinė konfigūracijos klaida: API raktai nėra nustatyti .env faile.');
        }

        // Tikriname, ar yra 'action' laukas
        if (!data.action) {
            console.log("Signalas neturi 'action' lauko. Ignoruojama.");
            return res.status(200).json({ status: 'ignored', message: 'No action specified.' });
        }

        // Išvalome tickerį, jei jis turi '.P' priesagą
        let ticker = data.ticker;
        if (ticker && ticker.endsWith('.P')) {
            ticker = ticker.slice(0, -2);
        }

        // Veiksmų skirstytuvas (Router)
        switch (data.action) {
            
            // --- 1. SĄLYGINIO ORDERIO SUKŪRIMAS ---
            case 'OPEN_CONDITIONAL': {
                const entry_price = parseFloat(data.entryPrice);
                const sl_price = parseFloat(data.stopLoss);
                const side = data.direction === 'long' ? 'Buy' : 'Sell';

                // Rizikos patikrinimas
                const sl_percent = Math.abs(entry_price - sl_price) / entry_price;
                if (sl_percent * 100 < MIN_SL_PERCENT || sl_percent * 100 > MAX_SL_PERCENT) {
                    throw new Error(`Signalas ${ticker} atmestas. SL plotis ${ (sl_percent * 100).toFixed(2)}% neatitinka kriterijų.`);
                }

                // Pozicijos dydžio skaičiavimas
                const position_size_in_asset = FIXED_RISK_USD / (entry_price * sl_percent);
                const position_size_rounded = position_size_in_asset.toFixed(3); // Pakeiskite skaičių po kablelio pagal poreikį

                if (parseFloat(position_size_rounded) <= 0) {
                    throw new Error(`Signalas ${ticker} atmestas. Apskaičiuotas pozicijos dydis per mažas.`);
                }

                console.log(`Ruosiamas sąlyginis orderis: ${side} ${position_size_rounded} ${ticker} ties kaina ${entry_price}`);
                
                const orderResponse = await bybitClient.submitOrder({
                    category: 'linear',
                    symbol: ticker,
                    side: side,
                    orderType: 'Market', // Sąlyginis RINKOS orderis
                    qty: position_size_rounded,
                    triggerPrice: String(entry_price),
                    triggerDirection: side === 'Buy' ? 1 : 2, // 1: Kaina kyla iki trigger, 2: Kaina krenta iki trigger
                    positionIdx: data.positionIdx, // **HEDGE MODE**
                });

                if (orderResponse.retCode !== 0) {
                    throw new Error(`Bybit klaida kuriant sąlyginį orderį: ${orderResponse.retMsg}`);
                }
                
                // Išsaugome orderio ID, kad galėtume jį atšaukti
                pendingOrders[ticker] = orderResponse.result.orderId;
                console.log(`Sąlyginis orderis ${ticker} sukurtas. ID: ${pendingOrders[ticker]}`);
                await sendTelegramMessage(`✅ Sąlyginis orderis *${ticker}* (${side}) sukurtas. Laukiama kainos: ${entry_price}`);
                break;
            }

            // --- 2. STOP-LOSS / TAKE-PROFIT NUSTATYMAS ---
            case 'SET_SL_TP': {
                console.log(`Nustatomas SL/TP pozicijai ${ticker}`);
                const sl_price = parseFloat(data.stopLoss);
                const tp_price = parseFloat(data.takeProfit);

                const response = await bybitClient.setTradingStop({
                    category: 'linear',
                    symbol: ticker,
                    stopLoss: String(sl_price),
                    takeProfit: String(tp_price),
                    positionIdx: data.positionIdx, // **HEDGE MODE**
                });

                if (response.retCode !== 0) {
                    throw new Error(`Bybit klaida nustatant SL/TP: ${response.retMsg}`);
                }
                await sendTelegramMessage(`✅ Pozicijai *${ticker}* sėkmingai nustatytas SL: ${sl_price} ir TP: ${tp_price}.`);
                break;
            }

            // --- 3. PELNO FIKSAVIMAS ARBA UŽDARYMAS DĖL SENUMO ---
            case 'TAKE_PROFIT':
            case 'CLOSE_EXISTING': {
                const reason = data.action === 'TAKE_PROFIT' ? 'pasiektas pelno tikslas' : 'signalas paseno';
                console.log(`Uždaroma pozicija ${ticker}, nes ${reason}`);

                // Gauname atidarytos pozicijos duomenis, kad žinotume jos dydį
                const positions = await bybitClient.getPositions({ category: 'linear', symbol: ticker });
                const position = positions.result.list.find(p => p.positionIdx === data.positionIdx);

                if (!position || parseFloat(position.size) === 0) {
                    throw new Error(`Nerasta aktyvi pozicija ${ticker}, kurią būtų galima uždaryti.`);
                }
                
                const side = position.side === 'Buy' ? 'Sell' : 'Buy'; // Priešinga pusė uždarymui
                const size = position.size;

                const orderResponse = await bybitClient.submitOrder({
                    category: 'linear',
                    symbol: ticker,
                    side: side,
                    orderType: 'Market',
                    qty: size,
                    reduceOnly: true, // **SVARBU**: Tik uždaro poziciją, neatidaro naujos
                    positionIdx: data.positionIdx, // **HEDGE MODE**
                });

                if (orderResponse.retCode !== 0) {
                    throw new Error(`Bybit klaida uždarant poziciją: ${orderResponse.retMsg}`);
                }
                await sendTelegramMessage(`✅ Pozicija *${ticker}* sėkmingai uždaryta, nes ${reason}.`);
                break;
            }
            
            // --- 4. LAUKIANČIO ORDERIO ATŠAUKIMAS ---
            case 'CANCEL_PENDING': {
                const orderIdToCancel = pendingOrders[ticker];
                if (!orderIdToCancel) {
                    throw new Error(`Nerastas joks laukiantis orderis simboliui ${ticker}, kurį būtų galima atšaukti.`);
                }

                console.log(`Atšaukiamas laukiantis orderis ${orderIdToCancel} simboliui ${ticker}`);
                const response = await bybitClient.cancelOrder({
                    category: 'linear',
                    symbol: ticker,
                    orderId: orderIdToCancel,
                });

                if (response.retCode !== 0) {
                    // Klaida 140025 reiškia, kad orderis jau neegzistuoja (pvz., buvo įvykdytas) - tai nėra tikra klaida
                    if (response.retCode === 140025) {
                        console.log(`Orderis ${orderIdToCancel} jau buvo įvykdytas arba atšauktas.`);
                        await sendTelegramMessage(`⚠️ Bandyta atšaukti *${ticker}* orderį, bet jis jau buvo įvykdytas arba atšauktas.`);
                    } else {
                        throw new Error(`Bybit klaida atšaukiant orderį: ${response.retMsg}`);
                    }
                } else {
                    await sendTelegramMessage(`✅ Laukiantis orderis *${ticker}* sėkmingai atšauktas.`);
                }
                
                // Išvalome orderio ID iš atminties
                delete pendingOrders[ticker];
                break;
            }

            default:
                console.log(`Gauta nepalaikoma komanda: ${data.action}`);
                break;
        }

        res.status(200).json({ status: 'success', message: `Action '${data.action}' processed.` });

    } catch (error) {
        console.error('Klaida apdorojant signalą:', error.message);
        await sendTelegramMessage(`❌ Įvyko klaida: ${error.message}`);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// --- SERVERIO PALEIDIMAS ---
app.listen(port, '0.0.0.0', () => {
    const msg = `🚀 Bybit botas paleistas ir laukia signalų per http://0.0.0.0:${port}/webhook`;
    console.log(msg);
    sendTelegramMessage(msg);
});