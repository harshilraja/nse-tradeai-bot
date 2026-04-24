// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI · Angel One Account Data Fetcher
// Adds REST endpoints for balance, holdings, positions, live prices
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";

// ─── ANGEL API HEADERS ─────────────────────────────────────────────────────
function angelHeaders(jwtToken, apiKey) {
  return {
    "Authorization":    `Bearer ${jwtToken}`,
    "Content-Type":     "application/json",
    "Accept":           "application/json",
    "X-UserType":       "USER",
    "X-SourceID":       "WEB",
    "X-ClientLocalIP":  "192.168.1.1",
    "X-ClientPublicIP": "103.0.0.1",
    "X-MACAddress":     "00:00:00:00:00:00",
    "X-PrivateKey":     apiKey,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. BALANCE / RMS
// ═══════════════════════════════════════════════════════════════════════════
export async function fetchBalance(jwtToken, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getRMS",
      { headers: angelHeaders(jwtToken, apiKey), timeout: 10000 }
    );
    const d = res.data?.data || {};
    return {
      availableCash:   parseFloat(d.availablecash || 0),
      utilisedMargin:  parseFloat(d.utiliseddebits || 0),
      availableLimit:  parseFloat(d.net || 0),
      collateral:      parseFloat(d.collateral || 0),
      realisedMTM:     parseFloat(d.m2mrealised || 0),
      unrealisedMTM:   parseFloat(d.m2munrealised || 0),
      intradayPayin:   parseFloat(d.availableintradaypayin || 0),
      openingBalance:  parseFloat(d.openingbalance || 0),
    };
  } catch (e) {
    console.error("fetchBalance error:", e.message);
    return {
      availableCash: 0, utilisedMargin: 0, availableLimit: 0,
      realisedMTM: 0, unrealisedMTM: 0, openingBalance: 0,
      error: e.message
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. HOLDINGS
// ═══════════════════════════════════════════════════════════════════════════
export async function fetchHoldings(jwtToken, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/portfolio/v1/getHolding",
      { headers: angelHeaders(jwtToken, apiKey), timeout: 10000 }
    );
    const holdings = res.data?.data || [];

    const enriched = holdings.map(h => {
      const avgPrice = parseFloat(h.averageprice || 0);
      const ltp = parseFloat(h.ltp || 0);
      const qty = parseInt(h.quantity || 0);
      const invested = avgPrice * qty;
      const currentVal = ltp * qty;
      const pnl = currentVal - invested;
      const pnlPct = invested ? (pnl / invested) * 100 : 0;

      return {
        symbol: h.tradingsymbol,
        exchange: h.exchange,
        quantity: qty,
        avgPrice,
        ltp,
        invested: parseFloat(invested.toFixed(2)),
        currentVal: parseFloat(currentVal.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPct: parseFloat(pnlPct.toFixed(2)),
        product: h.product,
        isin: h.isin,
      };
    });

    const totalInvested = enriched.reduce((s, h) => s + h.invested, 0);
    const totalCurrentVal = enriched.reduce((s, h) => s + h.currentVal, 0);
    const totalPnL = totalCurrentVal - totalInvested;
    const totalPnLPct = totalInvested ? (totalPnL / totalInvested) * 100 : 0;

    return {
      holdings: enriched,
      totalInvested: parseFloat(totalInvested.toFixed(2)),
      totalCurrentVal: parseFloat(totalCurrentVal.toFixed(2)),
      totalPnL: parseFloat(totalPnL.toFixed(2)),
      totalPnLPct: parseFloat(totalPnLPct.toFixed(2)),
      count: enriched.length,
    };
  } catch (e) {
    console.error("fetchHoldings error:", e.message);
    return {
      holdings: [], totalInvested: 0, totalCurrentVal: 0,
      totalPnL: 0, totalPnLPct: 0, count: 0, error: e.message
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. POSITIONS
// ═══════════════════════════════════════════════════════════════════════════
export async function fetchPositions(jwtToken, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getPosition",
      { headers: angelHeaders(jwtToken, apiKey), timeout: 10000 }
    );
    const positions = res.data?.data || [];

    return positions.map(p => ({
      symbol: p.tradingsymbol,
      exchange: p.exchange,
      productType: p.producttype,
      netQty: parseInt(p.netqty || 0),
      buyQty: parseInt(p.buyqty || 0),
      sellQty: parseInt(p.sellqty || 0),
      buyAvg: parseFloat(p.buyavgprice || 0),
      sellAvg: parseFloat(p.sellavgprice || 0),
      ltp: parseFloat(p.ltp || 0),
      pnl: parseFloat(p.pnl || 0),
      unrealised: parseFloat(p.unrealised || 0),
      realised: parseFloat(p.realised || 0),
    })).filter(p => p.netQty !== 0 || p.realised !== 0);
  } catch (e) {
    console.error("fetchPositions error:", e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. PROFILE
// ═══════════════════════════════════════════════════════════════════════════
export async function fetchProfile(jwtToken, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getProfile",
      { headers: angelHeaders(jwtToken, apiKey), timeout: 10000 }
    );
    const d = res.data?.data || {};
    return {
      clientCode: d.clientcode,
      name: d.name,
      email: d.email,
      mobile: d.mobileno,
      exchanges: d.exchanges || [],
      products: d.products || [],
      lastLogin: d.lastlogintime,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. ORDER BOOK
// ═══════════════════════════════════════════════════════════════════════════
export async function fetchOrderBook(jwtToken, apiKey) {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getOrderBook",
      { headers: angelHeaders(jwtToken, apiKey), timeout: 10000 }
    );
    const orders = res.data?.data || [];

    return orders.map(o => ({
      orderId: o.orderid,
      symbol: o.tradingsymbol,
      side: o.transactiontype,
      quantity: parseInt(o.quantity || 0),
      price: parseFloat(o.price || 0),
      avgPrice: parseFloat(o.averageprice || 0),
      status: o.status,
      orderType: o.ordertype,
      productType: o.producttype,
      exchange: o.exchange,
      orderTime: o.ordertime,
      updateTime: o.updatetime,
      filledShares: parseInt(o.filledshares || 0),
      unfilledShares: parseInt(o.unfilledshares || 0),
      rejectReason: o.text || null,
    }));
  } catch (e) {
    console.error("fetchOrderBook error:", e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. REST API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════
export function addAccountEndpoints(app, state, auth) {
  const apiKey = process.env.ANGEL_API_KEY;

  // UNIFIED DASHBOARD
  app.get("/api/account/dashboard", auth, async (req, res) => {
    if (!state.angelAuth) return res.status(500).json({ error: "Angel not authenticated" });

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
        profile,
        balance,
        holdings,
        positions,
        orderBook,
        metrics: {
          totalAccountValue: parseFloat(totalAccountValue.toFixed(2)),
          dayPnL: parseFloat(dayPnL.toFixed(2)),
          openOrders: orderBook.filter(o => o.status === "open").length,
          completedOrders: orderBook.filter(o => o.status === "complete").length,
          rejectedOrders: orderBook.filter(o => o.status === "rejected").length,
          positionsCount: positions.length,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // BALANCE ONLY
  app.get("/api/account/balance", auth, async (req, res) => {
    const balance = await fetchBalance(state.angelAuth, apiKey);
    res.json(balance);
  });

  // HOLDINGS ONLY
  app.get("/api/account/holdings", auth, async (req, res) => {
    const holdings = await fetchHoldings(state.angelAuth, apiKey);
    res.json(holdings);
  });

  // POSITIONS ONLY
  app.get("/api/account/positions", auth, async (req, res) => {
    const positions = await fetchPositions(state.angelAuth, apiKey);
    res.json(positions);
  });

  // ORDER BOOK
  app.get("/api/account/orders", auth, async (req, res) => {
    const orders = await fetchOrderBook(state.angelAuth, apiKey);
    res.json(orders);
  });

  // LIVE WATCHLIST PRICES (from WebSocket cache)
  app.get("/api/live/prices", auth, (req, res) => {
    const prices = {};
    state.livePrices.forEach((val, sym) => { prices[sym] = val; });
    res.json({ prices, count: Object.keys(prices).length });
  });

  app.get("/api/account/health", auth, async (req, res) => {
    const { getBalanceHealth } = await import("./balance-guard.js");
    const health = await getBalanceHealth(state.angelAuth, apiKey);
    res.json(health);
  });

  // CAPITAL SUMMARY
  app.get("/api/account/capital", auth, async (req, res) => {
    const balance = await fetchBalance(state.angelAuth, apiKey);
    const holdings = await fetchHoldings(state.angelAuth, apiKey);

    const tradingBuffer = balance.availableCash || 0;

    res.json({
      availableToTrade: tradingBuffer,
      deployedInTrades: balance.utilisedMargin,
      deployedInHoldings: holdings.totalCurrentVal,
      totalAccountValue: tradingBuffer + balance.utilisedMargin + holdings.totalCurrentVal,
      dayPnL: (balance.realisedMTM || 0) + (balance.unrealisedMTM || 0),
      canOpenNewTrade: tradingBuffer > 5000,
      riskBudget: {
        perTrade: 1000,
        maxPositions: 3,
        availableBudget: Math.min(tradingBuffer / 1000 * 1000, 3000),
      }
    });
  });
}
