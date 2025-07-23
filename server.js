// index.js (v4.4 - Pridėta CLOSE_BY_AGE funkcija)

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

async function getSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: GOOGLE_CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    return google.sheets({ version: 'v4', auth: authClient });
}

async function appendToSheet(rowData) {
    try {
        const sheets = await getSheetsClient();
        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1!A1',
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
                    const tradeContext = {
                        orderId, ticker, direction: data.direction,
                        entryPrice: order.triggerPrice, stopLoss: formatByStep(stopLoss, instrument.tickSize),
                        takeProfit: formatByStep(takeProfit, instrument.tickSize),
                        patternName: data.patternName || 'Nenurodyta',
                    };
                    await redisClient.set(redisKey, JSON.stringify(tradeContext));
                    const positionValueUSD = parseFloat(qty) * entryPrice;
                    const successMessage = `✅ *Pateiktas Sąlyginis Orderis*\n\n` +
                                           `*Pora:* \`${ticker}\`\n` +
                                           `*Kryptis:* ${data.direction.toUpperCase()}\n` +
                                           `*Pattern:* \`${tradeContext.patternName}\`\n` +
                                           `*Rizika:* $${parseFloat(FIXED_RISK_USD).toFixed(2)}\n\n` +
                                           `*Įėjimas:* \`${tradeContext.entryPrice}\`\n` +
                                           `*Stop Loss:* \`${tradeContext.stopLoss}\`\n` +
                                           `*Take Profit:* \`${tradeContext.takeProfit}\`\n\n` +
                                           `*Dydis:* \`${qty} ${ticker.replace('USDT', '')}\` (~$${positionValueUSD.toFixed(2)})\n` +
                                           `*Orderio ID:* \`${orderId}\``;
                    await sendTelegramMessage(successMessage);
                } else {
                    const errorMessage = `❌ *Orderis ATMestas*\n\n` +
                                         `*Pora:* \`${ticker}\`\n` +
                                         `*Kryptis:* ${data.direction.toUpperCase()}\n` +
                                         `*Bandytas Dydis:* \`${qty}\`\n\n` +
                                         `*Bybit Klaida (${orderResponse.retCode}):*\n` +
                                         `\`${orderResponse.retMsg}\``;
                    await sendTelegramMessage(errorMessage);
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
                    pnlPercent = -pnlPercent;
                }

                const rowData = [
                    new Date().toISOString(), tradeContext.ticker, tradeContext.direction.toUpperCase(),
                    tradeContext.patternName, data.outcome, tradeContext.entryPrice,
                    data.closePrice, pnlPercent.toFixed(2) + '%',
                ];

                await appendToSheet(rowData);
                await redisClient.del(redisKey);
                
                const pnlMessage = `📈 *Sandoris Užfiksuotas Žurnale*\n\n` +
                                   `*Pora:* \`${tradeContext.ticker}\`\n` +
                                   `*Rezultatas:* \`${data.outcome}\`\n` +
                                   `*P/L:* \`${pnlPercent.toFixed(2)}%\``;
                await sendTelegramMessage(pnlMessage);
                break;
            }

            case 'INVALIDATE_PATTERN': {
                console.log(`[${ticker}] Vykdomas veiksmas: INVALIDATE_PATTERN`);
                const tradeContextJSON = await redisClient.get(redisKey);
                if (!tradeContextJSON) {
                    console.log(`[${ticker}] Nerastas aktyvus sąlyginis orderis, kurį būtų galima atšaukti.`);
                    await sendTelegramMessage(`ℹ️ [${ticker}] Gautas INVALIDATE signalas, bet aktyvus sąlyginis orderis nerastas. Jokių veiksmų nesiimta.`);
                    break;
                }
                const tradeContext = JSON.parse(tradeContextJSON);
                const orderId = tradeContext.orderId;

                console.log(`[${ticker}] Atšaukiamas orderis su ID: ${orderId}`);
                const cancelResponse = await bybitClient.cancelOrder({ category: 'linear', symbol: ticker, orderId: orderId });

                if (cancelResponse.retCode === 0) {
                    await redisClient.del(redisKey);
                    await sendTelegramMessage(`🗑️ *Sąlyginis Orderis Atšauktas*\n\n*Pora:* \`${ticker}\`\n*Orderio ID:* \`${orderId}\``);
                } else {
                    await sendTelegramMessage(`⚠️ *Klaida Atšaukiant Orderį*\n\n*Pora:* \`${ticker}\`\n*Orderio ID:* \`${orderId}\`\n*Bybit Atsakymas:* \`${cancelResponse.retMsg}\``);
                }
                break;
            }

            case 'ENTERED_POSITION': {
                console.log(`[${ticker}] Vykdomas veiksmas: ENTERED_POSITION`);
                
                const tradeContextJSON = await redisClient.get(redisKey);
                if (!tradeContextJSON) {
                     console.log(`[${ticker}] Gautas ENTERED_POSITION, bet nerasta aktyvaus sandorio Redis'e.`);
                }

                console.log(`[${ticker}] Nustatomas SL/TP...`);
                const setStopResponse = await bybitClient.setTradingStop({
                    category: 'linear', symbol: ticker, positionIdx: positionIdx,
                    stopLoss: String(data.stopLoss), takeProfit: String(data.takeProfit)
                });

                if (setStopResponse.retCode === 0) {
                    await sendTelegramMessage(`▶️ *Pozicija Atidaryta ir Apsaugota*\n\n` +
                                              `*Pora:* \`${ticker}\`\n` +
                                              `*SL/TP Nustatytas:* Taip\n` +
                                              `*Stop Loss:* \`${data.stopLoss}\`\n` +
                                              `*Take Profit:* \`${data.takeProfit}\``);
                } else {
                     await sendTelegramMessage(`‼️ *KRITINĖ KLAIDA*\n\n` +
                                               `*Pora:* \`${ticker}\`\n` +
                                               `*Problema:* Pozicija atidaryta, BET nepavyko nustatyti SL/TP!\n` +
                                               `*Bybit Atsakymas:* \`${setStopResponse.retMsg}\`\n\n` +
                                               `*REIKALINGAS RANKINIS ĮSIKIŠIMAS!*`);
                }
                break;
            }

            case 'CLOSE_BY_AGE': {
                console.log(`[${ticker}] Vykdomas veiksmas: CLOSE_BY_AGE`);
                const tradeContextJSON = await redisClient.get(redisKey);
                if (!tradeContextJSON) {
                    await sendTelegramMessage(`⚠️ *Uždarymo Klaida* [${ticker}]\n\nGautas CLOSE_BY_AGE signalas, bet nerasta aktyvaus sandorio. Galbūt jau buvo uždarytas.`);
                    break;
                }
                const tradeContext = JSON.parse(tradeContextJSON);

                // 1. Get current position size from Bybit
                const positionInfo = await bybitClient.getPositionInfo({ category: 'linear', symbol: ticker });
                const activePosition = positionInfo.result.list.find(p => p.positionIdx === positionIdx && parseFloat(p.size) > 0);

                if (!activePosition) {
                    await sendTelegramMessage(`ℹ️ *Informacija* [${ticker}]\n\nGautas CLOSE_BY_AGE signalas, bet pozicija biržoje nerasta. Tikriausiai jau uždaryta.`);
                    // Clean up Redis just in case
                    await redisClient.del(redisKey);
                    break;
                }

                const positionSize = activePosition.size;
                const closingSide = activePosition.side === 'Buy' ? 'Sell' : 'Buy';

                // 2. Submit a closing market order
                console.log(`[${ticker}] Uždarinėjama pozicija (${positionSize}) dėl laiko...`);
                const closeOrderResponse = await bybitClient.submitOrder({
                    category: 'linear',
                    symbol: ticker,
                    side: closingSide,
                    orderType: 'Market',
                    qty: positionSize,
                    reduceOnly: true,
                    positionIdx: positionIdx,
                });

                if (closeOrderResponse.retCode !== 0) {
                    await sendTelegramMessage(`‼️ *KRITINĖ KLAIDA* [${ticker}]\n\nNepavyko uždaryti pozicijos dėl laiko.\n*Bybit Atsakymas:* \`${closeOrderResponse.retMsg}\`\n\n*REIKALINGAS RANKINIS ĮSIKIŠIMAS!*`);
                    break; // Stop further execution
                }
                
                await sendTelegramMessage(`⏳ *Pozicija Uždaroma Dėl Laiko*\n\n*Pora:* \`${ticker}\`\nPateiktas uždarymo orderis. Laukiami galutiniai rezultatai...`);

                // 3. Log the trade (best effort)
                // Give a moment for the order to execute and price to update
                await new Promise(resolve => setTimeout(resolve, 2000)); 

                const tickerInfo = await bybitClient.getTickers({ category: 'linear', symbol: ticker });
                const approxClosePrice = tickerInfo.result.list[0].lastPrice;

                const entryPrice = parseFloat(tradeContext.entryPrice);
                let pnlPercent = ((parseFloat(approxClosePrice) - entryPrice) / entryPrice) * 100;
                if (tradeContext.direction === 'short') {
                    pnlPercent = -pnlPercent;
                }

                const rowData = [
                    new Date().toISOString(),
                    tradeContext.ticker,
                    tradeContext.direction.toUpperCase(),
                    tradeContext.patternName,
                    'CLOSED_BY_AGE', // New outcome
                    tradeContext.entryPrice,
                    approxClosePrice,
                    pnlPercent.toFixed(2) + '%',
                ];

                await appendToSheet(rowData);
                await redisClient.del(redisKey);

                await sendTelegramMessage(`📈 *Sandoris Užfiksuotas Žurnale*\n\n` +
                                   `*Pora:* \`${tradeContext.ticker}\`\n` +
                                   `*Rezultatas:* \`CLOSED_BY_AGE\`\n` +
                                   `*P/L (apytikslis):* \`${pnlPercent.toFixed(2)}%\``);
                break;
            }
        }
        res.status(200).json({ status: 'success' });
    } catch (error) {
        console.error('❌ KLAIDA APDOROJANT SIGNALĄ:', error.message);
        await sendTelegramMessage(`🆘 *Boto Vidinė Klaida*\n\n*Problema:* \`${error.message}\`\n*Gauti Duomenys:* \`${JSON.stringify(req.body)}\``);
        res.status(500).json({ status: 'error', error: error.message });
    }
});


// --- SERVERIO PALEIDIMAS ---
const startServer = async () => {
    try {
        await redisClient.connect();
        console.log("✅ Sėkmingai prisijungta prie Redis.");
        app.listen(port, '0.0.0.0', () => {
            const msg = `🚀 Bybit botas (v4.4 - su CLOSE_BY_AGE) paleistas ant porto ${port}`;
            console.log(msg);
            sendTelegramMessage(msg);
        });
    } catch (err) {
        console.error("❌ Kritinė klaida paleidžiant serverį:", err);
        process.exit(1);
    }
};

startServer();
