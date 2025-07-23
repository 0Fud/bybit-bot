// index.js (v4.0 - Versija su Google Sheets prekybos žurnalu)

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';
import { createClient } from 'redis';
import { google } from 'googleapis';
import cron from 'node-cron';

// --- APLIKACIJOS KONFIGŪRACIJA ---
const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID,
    BYBIT_API_KEY,
    BYBIT_API_SECRET,
    FIXED_RISK_USD,
    GOOGLE_SHEET_ID,
    GOOGLE_CREDENTIALS_PATH
} = process.env;

// --- KRITINIŲ KINTAMŲJŲ PATIKRINIMAS ---
const requiredEnvVars = ['BYBIT_API_KEY', 'BYBIT_API_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID', 'FIXED_RISK_USD', 'GOOGLE_SHEET_ID', 'GOOGLE_CREDENTIALS_PATH'];
for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
        console.error(`❌ Trūksta būtino .env kintamojo: ${varName}`);
        process.exit(1);
    }
}

// --- KLIENTŲ INICIALIZAVIMAS ---
const bybitClient = new RestClientV5({ key: BYBIT_API_KEY, secret: BYBIT_API_SECRET, testnet: false });
const redisClient = createClient();
redisClient.on('error', err => console.error('❌ Redis Client Error', err));

// --- PAGALBINĖS FUNKCIJOS ---

const instrumentInfoCache = new Map();

async function getInstrumentInfo(symbol) {
    if (instrumentInfoCache.has(symbol)) return instrumentInfoCache.get(symbol);
    try {
        console.log(`[${symbol}] Gaunama instrumento informacija iš Bybit...`);
        const response = await bybitClient.getInstrumentsInfo({ category: 'linear', symbol });
        if (response.retCode !== 0 || !response.result.list || response.result.list.length === 0) {
            throw new Error(`Nepavyko gauti ${symbol} informacijos: ${response.retMsg}`);
        }
        const info = response.result.list[0];
        const instrumentData = {
            qtyStep: parseFloat(info.lotSizeFilter.qtyStep),
            minOrderQty: parseFloat(info.lotSizeFilter.minOrderQty),
            tickSize: parseFloat(info.priceFilter.tickSize),
        };
        instrumentInfoCache.set(symbol, instrumentData);
        return instrumentData;
    } catch (error) {
        console.error(`❌ Klaida gaunant ${symbol} informaciją:`, error.message);
        return null;
    }
}

function formatByStep(number, step) {
    const decimals = (step.toString().split('.')[1] || []).length;
    return number.toFixed(decimals);
}

const sendTelegramMessage = async (message) => {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHANNEL_ID, text: message, parse_mode: 'Markdown', disable_web_page_preview: true,
        });
    } catch (error) {
        console.error('Klaida siunčiant pranešimą į Telegram:', error.response?.data || error.message);
    }
};

// --- GOOGLE SHEETS INTEGRACIJA ---

/**
 * Prisijungia prie Google Sheets API ir grąžina autentifikuotą klientą.
 * @returns {Promise<object>} Google Sheets API klientas.
 */
async function getSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: GOOGLE_CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    return google.sheets({ version: 'v4', auth: authClient });
}

/**
 * Įrašo naują eilutę į Google Sheets dokumentą.
 * @param {Array<string>} rowData - Duomenų masyvas, kurį reikia įrašyti.
 */
async function appendToSheet(rowData) {
    try {
        const sheets = await getSheetsClient();
        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1!A1', // Rašys į pirmą tuščią eilutę
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [rowData],
            },
        });
        console.log('✅ Duomenys sėkmingai įrašyti į Google Sheets.');
    } catch (error) {
        console.error('❌ Klaida rašant į Google Sheets:', error.message);
        await sendTelegramMessage(`🆘 *Google Sheets Klaida*\n\nNepavyko įrašyti sandorio į žurnalą.\n*Priežastis:* \`${error.message}\``);
    }
}


// --- PAGRINDINIS WEBHOOK MARŠRUTAS ---
app.post('/webhook', async (req, res) => {
    console.log('\n--- Gaunamas signalas ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    try {
        if (!data.action || !data.ticker) return res.status(200).json({ status: 'ignored' });

        const ticker = data.ticker.replace('.P', '');
        const positionIdx = parseInt(data.positionIdx, 10);
        const redisKey = `${ticker}_${positionIdx}`;

        switch (data.action) {
            case 'NEW_PATTERN': {
                const instrument = await getInstrumentInfo(ticker);
                if (!instrument) throw new Error(`Kritinė klaida: nepavyko gauti ${ticker} prekybos taisyklių.`);

                const entryPrice = parseFloat(data.entryPrice);
                const takeProfit = parseFloat(data.takeProfit);
                const profitDistance = Math.abs(takeProfit - entryPrice);
                const riskDistance = profitDistance / 2;
                const stopLoss = data.direction === 'long' ? entryPrice - riskDistance : entryPrice + riskDistance;

                const sl_percent = Math.abs(entryPrice - stopLoss) / entryPrice;
                if (sl_percent === 0) throw new Error('Stop Loss negali būti lygus įėjimo kainai.');

                const position_size_raw = parseFloat(FIXED_RISK_USD) / (entryPrice * sl_percent);
                const qty = formatByStep(position_size_raw, instrument.qtyStep);

                if (parseFloat(qty) < instrument.minOrderQty) {
                    const errorMsg = `Apskaičiuotas kiekis (${qty}) yra mažesnis už minimalų leidžiamą (${instrument.minOrderQty}).`;
                    await sendTelegramMessage(`⚠️ *ATMestas Sandoris* [${ticker}]\n\n*Priežastis:* ${errorMsg}`);
                    throw new Error(errorMsg);
                }

                const order = {
                    category: 'linear', symbol: ticker, side: data.direction === 'long' ? 'Buy' : 'Sell',
                    orderType: 'Market', qty: String(qty), triggerPrice: formatByStep(entryPrice, instrument.tickSize),
                    triggerDirection: data.direction === 'long' ? 1 : 2, positionIdx: positionIdx,
                };
                
                const orderResponse = await bybitClient.submitOrder(order);

                if (orderResponse.retCode === 0) {
                    const orderId = orderResponse.result.orderId;
                    // Išsaugome visą sandorio kontekstą Redis'e
                    const tradeContext = {
                        orderId, ticker, direction: data.direction,
                        entryPrice: order.triggerPrice, stopLoss: formatByStep(stopLoss, instrument.tickSize),
                        takeProfit: formatByStep(takeProfit, instrument.tickSize),
                        patternName: data.patternName || 'Nenurodyta', // Svarbu!
                    };
                    await redisClient.set(redisKey, JSON.stringify(tradeContext));
                    
                    // ... (pranešimo siuntimas į Telegram, kaip ir anksčiau) ...

                } else {
                    // ... (klaidos pranešimo siuntimas, kaip ir anksčiau) ...
                    throw new Error(`Bybit klaida: ${orderResponse.retMsg}`);
                }
                break;
            }

            case 'TRADE_CLOSED': {
                console.log(`[${ticker}] Vykdomas veiksmas: TRADE_CLOSED`);
                const tradeContextJSON = await redisClient.get(redisKey);

                if (!tradeContextJSON) {
                    console.log(`[${ticker}] Gautas TRADE_CLOSED, bet nerasta aktyvaus sandorio Redis'e. Ignoruojama.`);
                    break;
                }

                const tradeContext = JSON.parse(tradeContextJSON);
                const closePrice = parseFloat(data.closePrice);
                const entryPrice = parseFloat(tradeContext.entryPrice);
                
                let pnlPercent = ((closePrice - entryPrice) / entryPrice) * 100;
                if (tradeContext.direction === 'short') {
                    pnlPercent = -pnlPercent; // Apverčiame P/L short pozicijai
                }

                const rowData = [
                    new Date().toISOString(),        // Data
                    tradeContext.ticker,             // Pora
                    tradeContext.direction.toUpperCase(), // Kryptis
                    tradeContext.patternName,        // Pattern Pavadinimas
                    data.outcome,                    // Statusas (SL_HIT, TP1_HIT)
                    tradeContext.entryPrice,         // Įėjimo Kaina
                    data.closePrice,                 // Uždarymo Kaina
                    pnlPercent.toFixed(2) + '%',     // P/L (%)
                ];

                await appendToSheet(rowData);
                await redisClient.del(redisKey); // Išvalome įrašą iš Redis

                await sendTelegramMessage(`📈 *Sandoris Užfiksuotas Žurnale*\n\n` +
                                          `*Pora:* \`${tradeContext.ticker}\`\n` +
                                          `*Rezultatas:* ${data.outcome}\n` +
                                          `*P/L:* ${pnlPercent.toFixed(2)}%`);
                break;
            }

            // ... (kiti 'case' blokai: INVALIDATE_PATTERN, ENTERED_POSITION, etc. lieka nepakitę) ...
        }
        res.status(200).json({ status: 'success' });
    } catch (error) {
        console.error('❌ KLAIDA APDOROJANT SIGNALĄ:', error.message);
        await sendTelegramMessage(`🆘 *Boto Vidinė Klaida*\n\n*Problema:* \`${error.message}\`\n*Gauti Duomenys:* \`${JSON.stringify(req.body)}\``);
        res.status(500).json({ status: 'error', error: error.message });
    }
});


// --- SERVERIO PALEIDIMAS IR LAIKO PLANUOKLIS ---
const startServer = async () => {
    try {
        await redisClient.connect();
        console.log("✅ Sėkmingai prisijungta prie Redis.");
        app.listen(port, '0.0.0.0', () => {
            const msg = `🚀 Bybit botas (v4.0 su Google Sheets) paleistas ant porto ${port}`;
            console.log(msg);
            sendTelegramMessage(msg);
        });

        // Savaitės ataskaitos suplanavimas (kol kas tuščias, įgyvendinsime vėliau)
        // cron.schedule('0 21 * * 0', () => { // Kiekvieną sekmadienį 21:00
        //     console.log('Generuojama savaitės ataskaita...');
        //     // Čia bus ataskaitos generavimo logika
        // });

    } catch (err) {
        console.error("❌ Kritinė klaida paleidžiant serverį:", err);
        process.exit(1);
    }
};

startServer();
