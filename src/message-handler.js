// message-handler.js — Roteamento central de mensagens recebidas
const { MSG_TYPES } = require('./protocol');

class MessageHandler {
  constructor(peerEngine, tradeManager, uiBroadcast) {
    this.peerEngine = peerEngine;
    this.tradeManager = tradeManager;
    this.uiBroadcast = uiBroadcast; // Função para enviar eventos para a UI
  }

  // Processar mensagem recebida de um vizinho
  handle(msg, sourceWs) {
    if (!msg || !msg.type) {
      console.warn('[HANDLER] Mensagem inválida recebida:', msg);
      return;
    }

    // Log para UI
    this._logToUi('incoming', msg);

    switch (msg.type) {
      case MSG_TYPES.HELLO:
        // Já tratado pelo NeighborManager
        this._notifyUi('neighbor_update');
        break;

      case MSG_TYPES.SEARCH:
        this.peerEngine.handleSearch(msg, sourceWs);
        break;

      case MSG_TYPES.SEARCH_HIT:
        this.peerEngine.handleSearchHit(msg, sourceWs);
        break;

      case MSG_TYPES.SEARCH_MISS:
        this.peerEngine.handleSearchMiss(msg);
        break;

      case MSG_TYPES.TRADE_OFFER:
        this.tradeManager.handleTradeOffer(msg);
        break;

      case MSG_TYPES.TRADE_ACCEPT:
        this.tradeManager.handleTradeAccept(msg);
        break;

      case MSG_TYPES.TRADE_REJECT:
        this.tradeManager.handleTradeReject(msg);
        break;

      case MSG_TYPES.TRANSFER_CONFIRM:
        this.tradeManager.handleTransferConfirm(msg);
        break;

      default:
        console.warn(`[HANDLER] Tipo desconhecido: ${msg.type}`);
    }
  }

  _notifyUi(event, data) {
    if (this.uiBroadcast) {
      this.uiBroadcast(JSON.stringify({
        type: 'ui_event',
        event: event,
        data: data,
        timestamp: Date.now(),
      }));
    }
  }

  _logToUi(direction, msg) {
    if (this.uiBroadcast) {
      this.uiBroadcast(JSON.stringify({
        type: 'log',
        direction: direction,
        message: msg,
        timestamp: Date.now(),
      }));
    }
  }
}

module.exports = MessageHandler;
