// server.js (v5.0 - Multi-Account & Queue Architecture)

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';
import { createClient } from 'redis';
import { google } from 'googleapis';
import { Queue, Worker } from 'bullmq';

// --- APLIKACIJOS KONFIGŪRACIJA ---
const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID,
    FIXED_RISK_USD,
    GOOGLE_SHEET_ID,
    GOOGLE_CREDENTIALS_PATH,
    REDIS_URL, // pvz., "redis://localhost:6379"
    MAX_SUBACCOUNTS = '11'
} = process.env;

const MAX_SUBACCOUNTS_NUM = parseInt(MAX_SUBACCOUNTS, 10);

// --- KRITINIŲ KINTAMŲJŲ PATIKRINIMAS ---
const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID', 'FIXED_RISK_USD', 'GOOGLE_SHEET_ID', 'GOOGLE_CREDENTIALS_PATH', 'REDIS_URL'];
for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
        console.error(`❌ Trūksta būtino .env kintamojo: ${varName}`);
        process.exit(1);
    }
}

// --- KLIENTŲ INICIALIZAVIMAS ---

// Bybit klientai sub-sąskaitoms
const bybitClients = new Map();

// Redis klientas ir BullMQ eilės konfigūracija
const redisConnection = {
    url: REDIS_URL,
    // BullMQ reikalauja, kad maxretries per reconnect būtų 0, kad išvengti klaidų
    // kai Redis trumpam atsijungia.
    redisOptions: { maxRetriesPerRequest: null, enableReadyCheck: false }
};
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', err => console.error('❌ Redis Client Error', err));

// BullMQ Eilė ir Darbininkas (Worker)
const tradingQueue = new Queue('trading-signals', { connection: redisConnection.url });
const worker = new Worker('trading-signals', handleJob, {
    connection: redisConnection.url,
    limiter: {
        max: 1, // Vykdyti po 1 užduotį
        duration: 150, // Kas 150ms (atitinka ~6.6 užklausų/sek, saugu nuo Bybit 10/sek limito)
    },
});

worker.on('completed', job => console.log(`✅ Užduotis ${job.id} sėkmingai įvykdyta.`));
worker.on('failed', (job, err) => console.error(`❌ Užduotis ${job.id} nepavyko:`, err.message));


// --- PAGALBINĖS FUNKCIJOS ---

const instrumentInfoCache = new Map();

// Funkcija gauna instrumento info. Naudoja pirmą veikiantį klientą, nes info nėra specifinė sąskaitai.
async function getInstrumentInfo(symbol) {
    if (instrumentInfoCache.has(symbol)) return instrumentInfoCache.get(symbol);
    try {
        const mainClient = bybitClients.get(1) || Array.from(bybitClients.values())[0];
        if (!mainClient) throw new Error("Nėra sukonfigūruotų Bybit klientų.");

        console.log(`[${symbol}] Gaunama instrumento informacija iš Bybit...`);
        const response = await mainClient.getInstrumentsInfo({ category: 'linear', symbol });
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

// --- WEBHOOK MARŠRUTAS (TIK PRIDEDA UŽDUOTĮ Į EILĘ) ---
app.post('/webhook', async (req, res) => {
    console.log('\n--- Gaunamas signalas, dedamas į eilę ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    if (!data.action || !data.ticker) {
        return res.status(200).json({ status: 'ignored', message: 'Missing action or ticker.' });
    }

    try {
        await tradingQueue.add('signal', data);
        res.status(202).json({ status: 'accepted', message: 'Signal queued for processing.' });
    } catch (error) {
        console.error('❌ KLAIDA DEDANT Į EILĘ:', error.message);
        await sendTelegramMessage(`🆘 *Boto Vidinė Klaida*\n\n*Problema:* Nepavyko pridėti signalo į eilę.\n*Priežastis:* \`${error.message}\``);
        res.status(500).json({ status: 'error', error: 'Failed to queue signal.' });
    }
});


// --- EILĖS DARBININKO (WORKER) LOGIKA ---
async function handleJob(job) {
    console.log(`\n--- Pradedama vykdyti užduotis ${job.id} ---`);
    const data = job.data;
    console.log('Apdorojami duomenys:', data);

    try {
        const ticker = data.ticker.replace('.P', '');
        const positionIdx = parseInt(data.positionIdx, 10);

        switch (data.action) {
            case 'NEW_PATTERN': {
                const instrument = await getInstrumentInfo(ticker);
                if (!instrument) throw new Error(`Kritinė klaida: nepavyko gauti ${ticker} prekybos taisyklių.`);

                let tradePlaced = false;
                for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
                    const subAccountId = i;
                    const bybitClient = bybitClients.get(subAccountId);
                    if (!bybitClient) continue; // Praleisti, jei ši sub-sąskaita nesukonfigūruota

                    const redisKey = `${ticker}_${positionIdx}_sub${subAccountId}`;
                    const existingTrade = await redisClient.get(redisKey);

                    if (!existingTrade) {
                        // Rasta laisva sub-sąskaita, bandoma atidaryti sandorį
                        console.log(`[Sub-${subAccountId}] Laisva, bandoma atidaryti ${ticker}...`);

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
                            await sendTelegramMessage(`⚠️ *ATMestas Sandoris* [${ticker}] [Sub-${subAccountId}]\n\n*Priežastis:* ${errorMsg}`);
                            console.log(`[Sub-${subAccountId}] ${errorMsg}`);
                            tradePlaced = true; // Pažymime, kad nereikia siųsti "visos sąskaitos užimtos" pranešimo
                            break; // Nutraukiame, nes kitose sąskaitose bus ta pati problema
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
                                patternName: data.patternName || 'Nenurodyta', qty: qty, subAccountId
                            };
                            await redisClient.set(redisKey, JSON.stringify(tradeContext));
                            
                            const positionValueUSD = parseFloat(qty) * entryPrice;
                            const successMessage = `[Sub-${subAccountId}] ✅ *Pateiktas Sąlyginis Orderis*\n\n` +
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
                            tradePlaced = true;
                            break; // Sėkmingai pateikėm, išeinam iš ciklo
                        } else {
                            const errorMessage = `[Sub-${subAccountId}] ❌ *Orderis ATMestas*\n\n` +
                                                 `*Pora:* \`${ticker}\`\n` +
                                                 `*Bybit Klaida (${orderResponse.retCode}):*\n` +
                                                 `\`${orderResponse.retMsg}\``;
                            await sendTelegramMessage(errorMessage);
                            // Nenutraukiame ciklo, galbūt kita sąskaita veiks
                        }
                    }
                }

                if (!tradePlaced) {
                    await sendTelegramMessage(`⚠️ *Visos Sąskaitos Užimtos*\n\n*Pora:* \`${ticker}\`\nNebuvo rastos laisvos sub-sąskaitos naujam sandoriui. Signalas praleistas.`);
                }
                break;
            }

            // Visi kiti veiksmai ieško aktyvaus sandorio per visas sub-sąskaitas
            default: {
                let tradeFound = false;
                for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
                    const subAccountId = i;
                    const bybitClient = bybitClients.get(subAccountId);
                    if (!bybitClient) continue;

                    const redisKey = `${ticker}_${positionIdx}_sub${subAccountId}`;
                    const tradeContextJSON = await redisClient.get(redisKey);

                    if (tradeContextJSON) {
                        const tradeContext = JSON.parse(tradeContextJSON);
                        tradeFound = true;
                        
                        console.log(`[Sub-${subAccountId}] Radome aktyvų sandorį ${ticker}. Vykdomas veiksmas: ${data.action}`);

                        switch (data.action) {
                            case 'TRADE_CLOSED': {
                                const closePrice = parseFloat(data.closePrice);
                                const entryPrice = parseFloat(tradeContext.entryPrice);
                                const qty = parseFloat(tradeContext.qty);
                                let pnlPercent = ((closePrice - entryPrice) / entryPrice) * 100;
                                let pnlUSD = (closePrice - entryPrice) * qty;
                                if (tradeContext.direction === 'short') {
                                    pnlPercent = -pnlPercent;
                                    pnlUSD = -pnlUSD;
                                }
                                const rowData = [
                                    new Date().toISOString(), tradeContext.ticker, tradeContext.direction.toUpperCase(),
                                    tradeContext.patternName, data.outcome, tradeContext.entryPrice,
                                    data.closePrice, pnlPercent.toFixed(2) + '%', pnlUSD.toFixed(2)
                                ];
                                await appendToSheet(rowData);
                                await redisClient.del(redisKey);
                                const pnlMessage = `[Sub-${subAccountId}] 📈 *Sandoris Užfiksuotas Žurnale*\n\n` +
                                                   `*Pora:* \`${tradeContext.ticker}\`\n` +
                                                   `*Rezultatas:* \`${data.outcome}\`\n` +
                                                   `*P/L:* \`${pnlPercent.toFixed(2)}%\` (\`${pnlUSD.toFixed(2)} USD\`)`;
                                await sendTelegramMessage(pnlMessage);
                                break;
                            }
                            case 'INVALIDATE_PATTERN': {
                                const orderId = tradeContext.orderId;
                                const cancelResponse = await bybitClient.cancelOrder({ category: 'linear', symbol: ticker, orderId: orderId });
                                if (cancelResponse.retCode === 0) {
                                    await redisClient.del(redisKey);
                                    await sendTelegramMessage(`[Sub-${subAccountId}] 🗑️ *Sąlyginis Orderis Atšauktas*\n\n*Pora:* \`${ticker}\`\n*Orderio ID:* \`${orderId}\``);
                                } else {
                                    await sendTelegramMessage(`[Sub-${subAccountId}] ⚠️ *Klaida Atšaukiant Orderį*\n\n*Pora:* \`${ticker}\`\n*Bybit Atsakymas:* \`${cancelResponse.retMsg}\``);
                                }
                                break;
                            }
                            case 'ENTERED_POSITION': {
                                const setStopResponse = await bybitClient.setTradingStop({
                                    category: 'linear', symbol: ticker, positionIdx: positionIdx,
                                    stopLoss: String(data.stopLoss), takeProfit: String(data.takeProfit)
                                });
                                let balanceMessage = '';
                                try {
                                    const balanceResponse = await bybitClient.getWalletBalance({ accountType: 'UNIFIED' });
                                    if (balanceResponse.retCode === 0 && balanceResponse.result.list.length > 0) {
                                        const equity = parseFloat(balanceResponse.result.list[0].totalEquity);
                                        balanceMessage = `\n💰 *Balansas:* \`$${equity.toFixed(2)}\``;
                                    }
                                } catch (balanceError) { console.error('Klaida gaunant sąskaitos balansą:', balanceError.message); }

                                if (setStopResponse.retCode === 0) {
                                    await sendTelegramMessage(`[Sub-${subAccountId}] ▶️ *Pozicija Atidaryta ir Apsaugota*\n\n` +
                                                              `*Pora:* \`${ticker}\`\n` +
                                                              `*SL/TP Nustatytas:* Taip` + balanceMessage);
                                } else {
                                     await sendTelegramMessage(`[Sub-${subAccountId}] ‼️ *KRITINĖ KLAIDA*\n\n` +
                                                               `*Pora:* \`${ticker}\`\n` +
                                                               `*Problema:* Nepavyko nustatyti SL/TP!\n` +
                                                               `*Bybit Atsakymas:* \`${setStopResponse.retMsg}\`\n\n` +
                                                               `*REIKALINGAS RANKINIS ĮSIKIŠIMAS!*`);
                                }
                                break;
                            }
                            case 'CLOSE_BY_AGE': {
                                const positionInfo = await bybitClient.getPositionInfo({ category: 'linear', symbol: ticker });
                                const activePosition = positionInfo.result.list.find(p => p.positionIdx === positionIdx && parseFloat(p.size) > 0);
                                if (!activePosition) {
                                    await sendTelegramMessage(`[Sub-${subAccountId}] ℹ️ *Informacija* [${ticker}]\n\nGautas CLOSE_BY_AGE signalas, bet pozicija biržoje nerasta. Tikriausiai jau uždaryta.`);
                                    await redisClient.del(redisKey);
                                    break;
                                }
                                const closeOrderResponse = await bybitClient.submitOrder({
                                    category: 'linear', symbol: ticker, side: activePosition.side === 'Buy' ? 'Sell' : 'Buy',
                                    orderType: 'Market', qty: activePosition.size, reduceOnly: true, positionIdx: positionIdx,
                                });
                                if (closeOrderResponse.retCode !== 0) {
                                    await sendTelegramMessage(`[Sub-${subAccountId}] ‼️ *KRITINĖ KLAIDA* [${ticker}]\n\nNepavyko uždaryti pozicijos dėl laiko.\n*Bybit Atsakymas:* \`${closeOrderResponse.retMsg}\`\n\n*REIKALINGAS RANKINIS ĮSIKIŠIMAS!*`);
                                    break;
                                }
                                await sendTelegramMessage(`[Sub-${subAccountId}] ⏳ *Pozicija Uždaroma Dėl Laiko*\n\n*Pora:* \`${ticker}\``);
                                // Logika įrašymui į Sheets (supaprastinta, nes tiksli kaina nežinoma iškart)
                                await new Promise(resolve => setTimeout(resolve, 2000));
                                const tickerInfo = await bybitClient.getTickers({ category: 'linear', symbol: ticker });
                                const approxClosePrice = parseFloat(tickerInfo.result.list[0].lastPrice);
                                const entryPrice = parseFloat(tradeContext.entryPrice);
                                const qty = parseFloat(tradeContext.qty);
                                let pnlPercent = ((approxClosePrice - entryPrice) / entryPrice) * 100;
                                let pnlUSD = (approxClosePrice - entryPrice) * qty;
                                if (tradeContext.direction === 'short') { pnlPercent = -pnlPercent; pnlUSD = -pnlUSD; }
                                const rowData = [
                                    new Date().toISOString(), tradeContext.ticker, tradeContext.direction.toUpperCase(),
                                    tradeContext.patternName, 'CLOSED_BY_AGE', tradeContext.entryPrice,
                                    approxClosePrice.toString(), pnlPercent.toFixed(2) + '%', pnlUSD.toFixed(2)
                                ];
                                await appendToSheet(rowData);
                                await redisClient.del(redisKey);
                                await sendTelegramMessage(`[Sub-${subAccountId}] 📈 *Sandoris Užfiksuotas Žurnale (Pagal Laiką)*\n\n` +
                                                          `*Pora:* \`${tradeContext.ticker}\`\n*P/L (apytikslis):* \`${pnlPercent.toFixed(2)}%\` (\`${pnlUSD.toFixed(2)} USD\`)`);
                                break;
                            }
                        }
                        break; // Radom ir apdorojom, išeinam iš sub-sąskaitų ciklo
                    }
                }
                if (!tradeFound && data.action !== 'NEW_PATTERN') {
                     console.log(`[${ticker}] Gautas ${data.action} signalas, bet nerasta aktyvaus sandorio jokioje sub-sąskaitoje. Ignoruojama.`);
                }
            }
        }
    } catch (error) {
        console.error(`❌ KLAIDA APDOROJANT UŽDUOTĮ ${job.id}:`, error.message, error.stack);
        await sendTelegramMessage(`🆘 *Boto Vidinė Klaida (Worker)*\n\n*Problema:* \`${error.message}\`\n*Apdoroti Duomenys:* \`${JSON.stringify(job.data)}\``);
        // Svarbu išmesti klaidą, kad BullMQ žinotų, jog užduotis nepavyko
        throw error;
    }
}


// --- SERVERIO PALEIDIMAS ---
const startServer = async () => {
    try {
        // 1. Sukurti Bybit klientus
        let initializedClients = 0;
        for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
            const apiKey = process.env[`BYBIT_API_KEY_${i}`];
            const apiSecret = process.env[`BYBIT_API_SECRET_${i}`];
            if (apiKey && apiSecret) {
                bybitClients.set(i, new RestClientV5({ key: apiKey, secret: apiSecret, testnet: false }));
                initializedClients++;
            }
        }
        if (initializedClients === 0) {
            console.error(`❌ Kritinė klaida: Nerasta jokių BYBIT_API_KEY_n / BYBIT_API_SECRET_n porų .env faile.`);
            process.exit(1);
        }
        console.log(`✅ Sėkmingai inicializuota ${initializedClients} iš ${MAX_SUBACCOUNTS_NUM} galimų Bybit klientų.`);

        // 2. Prisijungti prie Redis
        await redisClient.connect();
        console.log("✅ Sėkmingai prisijungta prie Redis.");

        // 3. Paleisti web serverį
        app.listen(port, '0.0.0.0', () => {
            const msg = `🚀 Bybit botas (v5.0 - Multi-Account & Queue) paleistas ant porto ${port}\n- Aktyvuota ${initializedClients} sub-sąskaitų.\n- Eilės sistema veikia.`;
            console.log(msg);
            sendTelegramMessage(msg);
        });
    } catch (err) {
        console.error("❌ Kritinė klaida paleidžiant serverį:", err);
        process.exit(1);
    }
};

startServer();
