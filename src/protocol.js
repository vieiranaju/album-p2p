// protocol.js — Constantes e builders de mensagens do protocolo P2P
const { v4: uuidv4 } = require('uuid');

// Tipos de mensagem
const MSG_TYPES = {
  HELLO: 'HELLO',
  SEARCH: 'SEARCH',
  SEARCH_HIT: 'SEARCH_HIT',
  SEARCH_MISS: 'SEARCH_MISS',
  TRADE_OFFER: 'TRADE_OFFER',
  TRADE_ACCEPT: 'TRADE_ACCEPT',
  TRADE_REJECT: 'TRADE_REJECT',
  TRANSFER_CONFIRM: 'TRANSFER_CONFIRM',
};

// Builders de mensagens

function buildHello(peerId, stickerId) {
  return {
    type: MSG_TYPES.HELLO,
    peer_id: peerId,
    sticker_id: stickerId,
    timestamp: Date.now(),
  };
}

function buildSearch(peerId, stickerId, ttl, originPeerId, queryId) {
  return {
    type: MSG_TYPES.SEARCH,
    peer_id: peerId,
    query_id: queryId || uuidv4(),
    sticker_id: stickerId,
    ttl: ttl,
    origin_peer_id: originPeerId || peerId,
    timestamp: Date.now(),
  };
}

function buildSearchHit(peerId, queryId, stickerId, ownerPeerId, quantity) {
  return {
    type: MSG_TYPES.SEARCH_HIT,
    peer_id: peerId,
    query_id: queryId,
    sticker_id: stickerId,
    owner_peer_id: ownerPeerId,
    quantity: quantity,
    timestamp: Date.now(),
  };
}

function buildSearchMiss(peerId, queryId, stickerId) {
  return {
    type: MSG_TYPES.SEARCH_MISS,
    peer_id: peerId,
    query_id: queryId,
    sticker_id: stickerId,
    timestamp: Date.now(),
  };
}

function buildTradeOffer(peerId, targetPeerId, offerStickerId, offerQty, wantStickerId, wantQty) {
  return {
    type: MSG_TYPES.TRADE_OFFER,
    peer_id: peerId,
    target_peer_id: targetPeerId,
    trade_id: uuidv4(),
    offer_sticker_id: offerStickerId,
    offer_qty: offerQty,
    want_sticker_id: wantStickerId,
    want_qty: wantQty,
    timestamp: Date.now(),
  };
}

function buildTradeAccept(peerId, tradeId) {
  return {
    type: MSG_TYPES.TRADE_ACCEPT,
    peer_id: peerId,
    trade_id: tradeId,
    timestamp: Date.now(),
  };
}

function buildTradeReject(peerId, tradeId, reason) {
  return {
    type: MSG_TYPES.TRADE_REJECT,
    peer_id: peerId,
    trade_id: tradeId,
    reason: reason || 'Troca recusada',
    timestamp: Date.now(),
  };
}

function buildTransferConfirm(peerId, tradeId) {
  return {
    type: MSG_TYPES.TRANSFER_CONFIRM,
    peer_id: peerId,
    trade_id: tradeId,
    timestamp: Date.now(),
  };
}

module.exports = {
  MSG_TYPES,
  buildHello,
  buildSearch,
  buildSearchHit,
  buildSearchMiss,
  buildTradeOffer,
  buildTradeAccept,
  buildTradeReject,
  buildTransferConfirm,
};
