// trade-manager.js — Lógica de propostas e conclusão de trocas
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const {
  buildTradeOffer,
  buildTradeAccept,
  buildTradeReject,
  buildTransferConfirm,
} = require('./protocol');

// Estados possíveis de uma troca
const TRADE_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  CONFIRMED: 'CONFIRMED',
};

class TradeManager extends EventEmitter {
  constructor(peerId, inventory, neighborManager) {
    super();
    this.peerId = peerId;
    this.inventory = inventory;
    this.neighborManager = neighborManager;

    // Map<trade_id, TradeState>
    this.trades = new Map();
    this.tradeHistory = [];
  }

  // Propor uma troca para outro peer
  proposeTrade(targetPeerId, offerStickerId, offerQty, wantStickerId, wantQty) {
    // Verificar se temos o que estamos oferecendo
    if (!this.inventory.canTrade(offerStickerId, offerQty)) {
      throw new Error(`Inventário insuficiente: não tem ${offerQty}x ${offerStickerId}`);
    }

    const msg = buildTradeOffer(
      this.peerId,
      targetPeerId,
      offerStickerId,
      offerQty,
      wantStickerId,
      wantQty
    );

    const trade = {
      trade_id: msg.trade_id,
      initiator: this.peerId,
      target: targetPeerId,
      offer_sticker_id: offerStickerId,
      offer_qty: offerQty,
      want_sticker_id: wantStickerId,
      want_qty: wantQty,
      status: TRADE_STATUS.PENDING,
      direction: 'outgoing',
      timestamp: Date.now(),
    };

    this.trades.set(msg.trade_id, trade);
    this.neighborManager.sendTo(targetPeerId, msg);

    console.log(`[TROCA] Proposta enviada para ${targetPeerId}: ${offerQty}x ${offerStickerId} por ${wantQty}x ${wantStickerId}`);
    this.emit('trade_proposed', trade);

    return trade;
  }

  // Processar oferta de troca recebida
  handleTradeOffer(msg) {
    const trade = {
      trade_id: msg.trade_id,
      initiator: msg.peer_id,
      target: this.peerId,
      offer_sticker_id: msg.offer_sticker_id,
      offer_qty: msg.offer_qty,
      want_sticker_id: msg.want_sticker_id,
      want_qty: msg.want_qty,
      status: TRADE_STATUS.PENDING,
      direction: 'incoming',
      timestamp: Date.now(),
    };

    this.trades.set(msg.trade_id, trade);

    console.log(`[TROCA] Proposta recebida de ${msg.peer_id}: ${msg.offer_qty}x ${msg.offer_sticker_id} por ${msg.want_qty}x ${msg.want_sticker_id}`);
    this.emit('trade_received', trade);

    return trade;
  }

  // Aceitar uma troca (chamado pela UI)
  acceptTrade(tradeId) {
    const trade = this.trades.get(tradeId);
    if (!trade) throw new Error(`Troca ${tradeId} não encontrada`);
    if (trade.status !== TRADE_STATUS.PENDING) throw new Error(`Troca ${tradeId} não está pendente`);

    // Verificar se temos o que o proponente quer
    if (!this.inventory.canTrade(trade.want_sticker_id, trade.want_qty)) {
      // Rejeitar automaticamente por falta de inventário
      this.rejectTrade(tradeId, 'Inventário insuficiente');
      throw new Error(`Inventário insuficiente: não tem ${trade.want_qty}x ${trade.want_sticker_id}`);
    }

    trade.status = TRADE_STATUS.ACCEPTED;

    // Atualizar inventário: dou o que ele quer, recebo o que ele oferece
    this.inventory.remove(trade.want_sticker_id, trade.want_qty);
    this.inventory.add(trade.offer_sticker_id, trade.offer_qty);

    // Enviar TRADE_ACCEPT
    const acceptMsg = buildTradeAccept(this.peerId, tradeId);
    this.neighborManager.sendTo(trade.initiator, acceptMsg);

    console.log(`[TROCA] ✓ Aceita: ${tradeId}`);
    this.emit('trade_accepted', trade);

    // Registrar no histórico
    this._addToHistory(trade);

    return trade;
  }

  // Rejeitar uma troca
  rejectTrade(tradeId, reason) {
    const trade = this.trades.get(tradeId);
    if (!trade) throw new Error(`Troca ${tradeId} não encontrada`);

    trade.status = TRADE_STATUS.REJECTED;
    trade.reason = reason || 'Troca recusada';

    const rejectMsg = buildTradeReject(this.peerId, tradeId, trade.reason);
    this.neighborManager.sendTo(trade.initiator, rejectMsg);

    console.log(`[TROCA] ✗ Rejeitada: ${tradeId} — ${trade.reason}`);
    this.emit('trade_rejected', trade);

    this._addToHistory(trade);
    return trade;
  }

  // Processar aceitação de troca (resposta a uma proposta que nós fizemos)
  handleTradeAccept(msg) {
    const trade = this.trades.get(msg.trade_id);
    if (!trade) {
      console.warn(`[TROCA] Aceitação para troca desconhecida: ${msg.trade_id}`);
      return null;
    }

    trade.status = TRADE_STATUS.ACCEPTED;

    // Atualizar inventário: dou o que ofereci, recebo o que quero
    this.inventory.remove(trade.offer_sticker_id, trade.offer_qty);
    this.inventory.add(trade.want_sticker_id, trade.want_qty);

    // Enviar TRANSFER_CONFIRM
    const confirmMsg = buildTransferConfirm(this.peerId, msg.trade_id);
    this.neighborManager.sendTo(trade.target, confirmMsg);

    trade.status = TRADE_STATUS.CONFIRMED;

    console.log(`[TROCA] ✓ Troca concluída: ${msg.trade_id}`);
    this.emit('trade_completed', trade);

    this._addToHistory(trade);
    return trade;
  }

  // Processar rejeição de troca
  handleTradeReject(msg) {
    const trade = this.trades.get(msg.trade_id);
    if (!trade) {
      console.warn(`[TROCA] Rejeição para troca desconhecida: ${msg.trade_id}`);
      return null;
    }

    trade.status = TRADE_STATUS.REJECTED;
    trade.reason = msg.reason;

    console.log(`[TROCA] ✗ Proposta rejeitada: ${msg.trade_id} — ${msg.reason}`);
    this.emit('trade_rejected', trade);

    this._addToHistory(trade);
    return trade;
  }

  // Processar confirmação de transferência
  handleTransferConfirm(msg) {
    const trade = this.trades.get(msg.trade_id);
    if (!trade) {
      console.warn(`[TROCA] Confirmação para troca desconhecida: ${msg.trade_id}`);
      return null;
    }

    trade.status = TRADE_STATUS.CONFIRMED;
    console.log(`[TROCA] ✓ Transferência confirmada: ${msg.trade_id}`);
    this.emit('trade_confirmed', trade);

    return trade;
  }

  _addToHistory(trade) {
    this.tradeHistory.push({ ...trade, completed_at: Date.now() });
    // Manter apenas últimas 100 trocas
    if (this.tradeHistory.length > 100) {
      this.tradeHistory = this.tradeHistory.slice(-100);
    }
  }

  getPendingTrades() {
    const pending = [];
    for (const [, trade] of this.trades) {
      if (trade.status === TRADE_STATUS.PENDING) {
        pending.push(trade);
      }
    }
    return pending;
  }

  getTradeHistory() {
    return [...this.tradeHistory];
  }
}

module.exports = TradeManager;
