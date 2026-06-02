export class OrderManager {
  constructor() {
    this.activeOrders = new Map();
    this.completedTrades = [];
    this.totalProfit = 0;
    this.wins = 0;
    this.losses = 0;
  }

  addOrder(orderId, { pair, side, price, amount, timestamp, sellTarget, phase, buyPrice, state }) {
    const order = {
      id: orderId,
      pair,
      side,
      price,
      amount,
      state: state ?? "OPEN",
      buyPrice: buyPrice ?? null,
      sellTarget: sellTarget ?? null,
      phase: phase ?? null,
      timestamp,
      lastChecked: timestamp
    };
    this.activeOrders.set(orderId, order);
    return order;
  }

  updateOrderState(orderId, newState) {
    const order = this.activeOrders.get(orderId);
    if (!order) {
      return null;
    }
    order.state = newState;
    order.lastChecked = Date.now();
    return order;
  }

  updateOrder(orderId, updates) {
    const order = this.activeOrders.get(orderId);
    if (!order) {
      return null;
    }
    Object.assign(order, updates);
    order.lastChecked = Date.now();
    return order;
  }

  removeOrder(orderId) {
    return this.activeOrders.delete(orderId);
  }

  recordCompletedTrade({ pair, buyPrice, sellPrice, amount, profit, timestamp }) {
    const tradeId = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${pair}-${timestamp}-${Math.floor(Math.random() * 10000)}`;
    const trade = {
      id: tradeId,
      pair,
      buyPrice,
      sellPrice,
      amount,
      profit,
      timestamp
    };

    this.completedTrades.unshift(trade);
    this.completedTrades = this.completedTrades.slice(0, 200);
    this.totalProfit += profit;
    if (profit >= 0) {
      this.wins += 1;
    } else {
      this.losses += 1;
    }

    return trade;
  }

  getStats() {
    const totalTrades = this.wins + this.losses;
    const winRate = totalTrades === 0 ? 0 : (this.wins / totalTrades) * 100;
    return {
      totalTrades,
      totalProfit: this.totalProfit,
      activeCount: this.activeOrders.size,
      winRate
    };
  }

  toJSON() {
    return {
      activeOrders: Array.from(this.activeOrders.values()),
      completedTrades: this.completedTrades,
      totalProfit: this.totalProfit,
      wins: this.wins,
      losses: this.losses
    };
  }

  loadFromJSON(data) {
    if (!data) {
      return;
    }
    this.activeOrders = new Map(
      (data.activeOrders || []).map((order) => [order.id, order])
    );
    this.completedTrades = data.completedTrades || [];
    this.totalProfit = data.totalProfit || 0;
    this.wins = data.wins || 0;
    this.losses = data.losses || 0;
  }
}
