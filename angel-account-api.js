// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI v7.0 · Angel One Account Endpoints
// ═══════════════════════════════════════════════════════════════════════════
import axios from "axios";

function headers(jwt, apiKey) {
  return {
    "Authorization": `Bearer ${jwt}`,
    "Content-Type": "application/json", "Accept": "application/json",
    "X-UserType": "USER", "X-SourceID": "WEB",
    "X-ClientLocalIP": "192.168.1.1", "X-ClientPublicIP": "103.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": apiKey,
  };
}

export async function fetchBalance(jwt, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getRMS",
      { headers: headers(jwt, apiKey), timeout: 10000 }
    );
    const d = res.data?.data || {};
    return {
      availableCash:   parseFloat(d.availablecash || 0),
      utilisedMargin:  parseFloat(d.utiliseddebits || 0),
      netAvailable:    parseFloat(d.net || 0),
      collateral:      parseFloat(d.collateral || 0),
      realisedMTM:     parseFloat(d.m2mrealised || 0),
      unrealisedMTM:   parseFloat(d.m2munrealised || 0),
      openingBalance:  parseFloat(d.openingbalance || 0),
    };
  } catch (e) {
    return { availableCash: 0, utilisedMargin: 0, error: e.message };
  }
}

export async function fetchHoldings(jwt, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/portfolio/v1/getHolding",
      { headers: headers(jwt, apiKey), timeout: 10000 }
    );
    const raw = res.data?.data || [];
    const enriched = raw.map(h => {
      const avg = parseFloat(h.averageprice || 0);
      const ltp = parseFloat(h.ltp || 0);
      const qty = parseInt(h.quantity || 0);
      const invested = avg * qty;
      const current = ltp * qty;
      const pnl = current - invested;
      return {
        symbol: h.tradingsymbol?.replace("-EQ", ""),
        exchange: h.exchange, quantity: qty,
        avgPrice: avg, ltp,
        invested: parseFloat(invested.toFixed(2)),
        currentVal: parseFloat(current.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPct: invested > 0 ? parseFloat(((pnl/invested)*100).toFixed(2)) : 0,
        product: h.product,
      };
    });
    const totals = {
      totalInvested: enriched.reduce((s,h) => s+h.invested, 0),
      totalCurrentVal: enriched.reduce((s,h) => s+h.currentVal, 0),
      totalPnL: enriched.reduce((s,h) => s+h.pnl, 0),
      count: enriched.length,
    };
    totals.totalPnLPct = totals.totalInvested > 0
      ? parseFloat(((totals.totalPnL/totals.totalInvested)*100).toFixed(2)) : 0;
    return { holdings: enriched, ...totals };
  } catch (e) {
    return { holdings: [], totalInvested: 0, totalCurrentVal: 0, totalPnL: 0, count: 0, error: e.message };
  }
}

export async function fetchPositions(jwt, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getPosition",
      { headers: headers(jwt, apiKey), timeout: 10000 }
    );
    return (res.data?.data || []).map(p => ({
      symbol: p.tradingsymbol?.replace("-EQ",""),
      exchange: p.exchange, productType: p.producttype,
      netQty: parseInt(p.netqty || 0),
      buyAvg: parseFloat(p.buyavgprice || 0),
      ltp: parseFloat(p.ltp || 0),
      pnl: parseFloat(p.pnl || 0),
    })).filter(p => p.netQty !== 0);
  } catch (e) { return []; }
}

export async function fetchProfile(jwt, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getProfile",
      { headers: headers(jwt, apiKey), timeout: 10000 }
    );
    const d = res.data?.data || {};
    return {
      clientCode: d.clientcode, name: d.name,
      email: d.email, mobile: d.mobileno,
      exchanges: d.exchanges || [], lastLogin: d.lastlogintime,
    };
  } catch (e) { return { error: e.message }; }
}

export async function fetchOrderBook(jwt, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getOrderBook",
      { headers: headers(jwt, apiKey), timeout: 10000 }
    );
    return (res.data?.data || []).map(o => ({
      orderId: o.orderid,
      symbol: o.tradingsymbol?.replace("-EQ",""),
      side: o.transactiontype,
      quantity: parseInt(o.quantity || 0),
      price: parseFloat(o.price || 0),
      avgPrice: parseFloat(o.averageprice || 0),
      status: o.status,
      productType: o.producttype,
      orderTime: o.ordertime,
      rejectReason: o.text || null,
    }));
  } catch (e) { return []; }
}

export function addAccountEndpoints(app, state, auth) {
  const apiKey = process.env.ANGEL_API_KEY;

  app.get("/api/account/dashboard", auth, async (req, res) => {
    if (!state.angelAuth) return res.status(500).json({ error: "Not authenticated" });
    try {
      const [balance, holdings, positions, profile, orderBook] = await Promise.all([
        fetchBalance(state.angelAuth, apiKey),
        fetchHoldings(state.angelAuth, apiKey),
        fetchPositions(state.angelAuth, apiKey),
        fetchProfile(state.angelAuth, apiKey),
        fetchOrderBook(state.angelAuth, apiKey),
      ]);
      const totalAccountValue = (balance.availableCash || 0) + (holdings.totalCurrentVal || 0);
      const dayPnL = (balance.realisedMTM || 0) + (balance.unrealisedMTM || 0);
      res.json({
        profile, balance, holdings, positions, orderBook,
        metrics: {
          totalAccountValue: parseFloat(totalAccountValue.toFixed(2)),
          dayPnL: parseFloat(dayPnL.toFixed(2)),
          openOrders: orderBook.filter(o => o.status === "open").length,
          completedOrders: orderBook.filter(o => o.status === "complete").length,
          positionsCount: positions.length,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/account/balance", auth, async (req, res) => {
    res.json(await fetchBalance(state.angelAuth, apiKey));
  });
  app.get("/api/account/holdings", auth, async (req, res) => {
    res.json(await fetchHoldings(state.angelAuth, apiKey));
  });
  app.get("/api/account/positions", auth, async (req, res) => {
    res.json(await fetchPositions(state.angelAuth, apiKey));
  });
  app.get("/api/account/orders", auth, async (req, res) => {
    res.json(await fetchOrderBook(state.angelAuth, apiKey));
  });
  app.get("/api/live/prices", auth, (req, res) => {
    const prices = {};
    state.livePrices.forEach((v, k) => { prices[k] = v; });
    res.json({ prices, count: Object.keys(prices).length });
  });
  app.get("/api/account/capital", auth, async (req, res) => {
    const balance = await fetchBalance(state.angelAuth, apiKey);
    res.json({
      availableToTrade: balance.availableCash,
      deployedInTrades: balance.utilisedMargin,
      totalCapital: state.capital,
      riskPerTrade: parseFloat((state.capital * 0.01).toFixed(2)),
      dailyLossCap: parseFloat((state.capital * 0.02).toFixed(2)),
    });
  });
}
