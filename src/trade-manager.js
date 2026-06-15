// trade-manager.js — Gerencia o ciclo de vida das trocas de figurinhas
//
// Fluxo de uma troca:
//   1. A: proposeTrade()     → envia TRADE_OFFER  → B
//   2. B: handleTradeOffer() → exibe proposta para o usuário de B
//   3. B: acceptTrade()      → envia TRADE_ACCEPT  → A  (atualiza inventário de B)
//   4. A: handleTradeAccept()→ envia TRANSFER_CONFIRM → B (atualiza inventário de A)
//   5. B: handleTransferConfirm() → troca concluída
//
const EventEmitter = require('events');
const {
  buildTradeOffer,
  buildTradeAccept,
  buildTradeReject,
  buildTransferConfirm,
} = require('./protocol');

// Estados possíveis de uma troca (ciclo de vida)
const STATUS = {
  PENDING:   'PENDING',   // aguardando resposta
  ACCEPTED:  'ACCEPTED',  // aceita, inventário atualizado
  REJECTED:  'REJECTED',  // recusada
  CONFIRMED: 'CONFIRMED', // transferência confirmada por ambos
};

class TradeManager extends EventEmitter {
  constructor(peerId, inventory, neighborManager) {
    super();
    this.peerId          = peerId;
    this.inventory       = inventory;
    this.neighborManager = neighborManager;

    this.trades      = new Map(); // Map<trade_id, objeto de troca>
    this.tradeHistory = [];       // histórico das últimas 100 trocas
  }

  // ─── Ações do usuário ─────────────────────────────────────────────────────

  // Propor troca: ofereço minha figurinha, quero a figurinha do outro peer
  proposeTrade(targetPeerId, offerStickerId, wantStickerId, offerQty = 1, wantQty = 1) {
    if (!this.inventory.canTrade(offerStickerId, offerQty)) {
      throw new Error(`Sem ${offerStickerId} disponível para troca`);
    }

    const msg = buildTradeOffer(this.peerId, this.peerId, targetPeerId, offerStickerId, wantStickerId, offerQty, wantQty);

    // Armazenar localmente usando o message_id como identificador da troca
    const trade = {
      trade_id:         msg.message_id,
      initiator:        this.peerId,
      target:           targetPeerId,
      offer_sticker_id: offerStickerId,
      offer_qty:        offerQty,
      want_sticker_id:  wantStickerId,
      want_qty:         wantQty,
      status:           STATUS.PENDING,
      direction:        'outgoing',
    };

    this.trades.set(trade.trade_id, trade);
    this.neighborManager.sendTo(targetPeerId, msg);

    console.log(`[TROCA] Proposta enviada → ${targetPeerId}: ofereço ${offerQty}x${offerStickerId}, quero ${wantQty}x${wantStickerId}`);
    this.emit('trade_proposed', trade);
    return trade;
  }

  // Aceitar uma proposta recebida (chamado pela UI com o trade_id)
  acceptTrade(tradeId) {
    const trade = this._getTrade(tradeId);

    if (!this.inventory.canTrade(trade.want_sticker_id, trade.want_qty)) {
      this.rejectTrade(tradeId, 'Inventário insuficiente');
      throw new Error(`Sem ${trade.want_sticker_id} disponível`);
    }

    // Atualizar inventário: entrego o que o outro quer, recebo o que ele ofereceu
    this.inventory.remove(trade.want_sticker_id, trade.want_qty);
    this.inventory.add(trade.offer_sticker_id, trade.offer_qty);
    trade.status = STATUS.ACCEPTED;

    // Na resposta, offer/want são do ponto de vista do ACEITANTE (invertidos)
    const msg = buildTradeAccept(
      this.peerId, this.peerId, trade.initiator,
      trade.want_sticker_id,    // o que o aceitante envia  (= o que o ofertante queria)
      trade.offer_sticker_id,   // o que o aceitante recebe (= o que o ofertante oferecia)
    );
    this.neighborManager.sendTo(trade.initiator, msg);

    console.log(`[TROCA] ✓ Aceita: ${tradeId}`);
    this.emit('trade_accepted', trade);
    this._saveHistory(trade);
    return trade;
  }

  // Rejeitar uma proposta recebida
  rejectTrade(tradeId, reason = 'Troca recusada') {
    const trade = this._getTrade(tradeId);
    trade.status = STATUS.REJECTED;
    trade.reason = reason;

    const msg = buildTradeReject(
      this.peerId, this.peerId, trade.initiator,
      trade.want_sticker_id,
      trade.offer_sticker_id,
    );
    this.neighborManager.sendTo(trade.initiator, msg);

    console.log(`[TROCA] ✗ Rejeitada: ${tradeId} (${reason})`);
    this.emit('trade_rejected', trade);
    this._saveHistory(trade);
    return trade;
  }

  // ─── Mensagens recebidas da rede ──────────────────────────────────────────

  // Recebemos uma proposta de troca
  handleTradeOffer(msg) {
    const trade = {
      trade_id:         msg.message_id,     // usamos o message_id para identificar a troca
      initiator:        msg.origin_peer_id,
      target:           this.peerId,
      offer_sticker_id: msg.offer_sticker_id,
      offer_qty:        msg.offer_qty || 1,
      want_sticker_id:  msg.want_sticker_id,
      want_qty:         msg.want_qty  || 1,
      status:           STATUS.PENDING,
      direction:        'incoming',
    };

    this.trades.set(trade.trade_id, trade);
    console.log(`[TROCA] Proposta recebida ← ${msg.origin_peer_id}: oferece ${trade.offer_qty}x${msg.offer_sticker_id}, quer ${trade.want_qty}x${msg.want_sticker_id}`);
    this.emit('trade_received', trade);
    return trade;
  }

  // O outro peer aceitou nossa proposta
  handleTradeAccept(msg) {
    // Como a spec não inclui trade_id na resposta, identificamos pelo par de figurinhas.
    // No ACCEPT: want=o que ele envia (= nosso offer), offer=o que ele recebe (= nosso want)
    const trade = this._findPending(msg.want_sticker_id, msg.offer_sticker_id, msg.origin_peer_id);
    if (!trade) return console.warn(`[TROCA] ACCEPT sem proposta correspondente de ${msg.origin_peer_id}`);

    // Atualizar inventário: entrego o que ofereci, recebo o que queria
    this.inventory.remove(trade.offer_sticker_id, trade.offer_qty);
    this.inventory.add(trade.want_sticker_id, trade.want_qty);

    // Confirmar que nossa parte está concluída
    const msg2 = buildTransferConfirm(
      this.peerId, this.peerId, trade.target,
      trade.offer_sticker_id,
      trade.want_sticker_id,
    );
    this.neighborManager.sendTo(trade.target, msg2);

    trade.status = STATUS.CONFIRMED;
    console.log(`[TROCA] ✓ Concluída com ${trade.target}`);
    this.emit('trade_completed', trade);
    this._saveHistory(trade);
    return trade;
  }

  // O outro peer rejeitou nossa proposta
  handleTradeReject(msg) {
    const trade = this._findPending(msg.want_sticker_id, msg.offer_sticker_id, msg.origin_peer_id);
    if (!trade) return console.warn(`[TROCA] REJECT sem proposta correspondente de ${msg.origin_peer_id}`);

    trade.status = STATUS.REJECTED;
    console.log(`[TROCA] ✗ Rejeitada por ${msg.origin_peer_id}`);
    this.emit('trade_rejected', trade);
    this._saveHistory(trade);
    return trade;
  }

  // O ofertante confirmou que concluiu — troca finalizada para o aceitante
  handleTransferConfirm(msg) {
    // Busca a troca pelo par de figurinhas e pelo peer envolvido.
    // A troca do aceitante já está com status ACCEPTED (não PENDING), então usamos _findByCounterpart.
    const trade = this._findByCounterpart(msg.origin_peer_id);
    if (!trade) return console.warn(`[TROCA] CONFIRM sem proposta correspondente de ${msg.origin_peer_id}`);

    trade.status = STATUS.CONFIRMED;
    this._saveHistory(trade);
    console.log(`[TROCA] ✓ Confirmação recebida de ${msg.origin_peer_id}`);
    this.emit('trade_confirmed', trade);
    return trade;
  }

  // ─── Helpers internos ─────────────────────────────────────────────────────

  _getTrade(tradeId) {
    const trade = this.trades.get(tradeId);
    if (!trade) throw new Error(`Troca não encontrada: ${tradeId}`);
    if (trade.status !== STATUS.PENDING) throw new Error(`Troca ${tradeId} não está pendente`);
    return trade;
  }

  // Como as respostas do protocolo não têm trade_id, identificamos a troca pelo
  // par de figurinhas e pelo peer envolvido
  _findPending(offerStickerId, wantStickerId, counterpartPeerId) {
    for (const trade of this.trades.values()) {
      if (
        trade.status           === STATUS.PENDING &&
        trade.offer_sticker_id === offerStickerId &&
        trade.want_sticker_id  === wantStickerId  &&
        (trade.initiator === counterpartPeerId || trade.target === counterpartPeerId)
      ) {
        return trade;
      }
    }
    return null;
  }

  // Busca uma troca ACCEPTED pelo peer contraparte (usado pelo aceitante ao receber TRANSFER_CONFIRM)
  _findByCounterpart(counterpartPeerId) {
    for (const trade of this.trades.values()) {
      if (
        trade.status === STATUS.ACCEPTED &&
        (trade.initiator === counterpartPeerId || trade.target === counterpartPeerId)
      ) {
        return trade;
      }
    }
    return null;
  }

  _saveHistory(trade) {
    // Evitar duplicatas no histórico
    const exists = this.tradeHistory.some(h => h.trade_id === trade.trade_id);
    if (!exists) {
      this.tradeHistory.push({ ...trade, completed_at: Date.now() });
      if (this.tradeHistory.length > 100) {
        this.tradeHistory = this.tradeHistory.slice(-100);
      }
    }
  }

  // ─── Consultas ────────────────────────────────────────────────────────────

  getPendingTrades() {
    return [...this.trades.values()].filter(t => t.status === STATUS.PENDING);
  }

  getTradeHistory() {
    return [...this.tradeHistory];
  }
}

module.exports = TradeManager;
