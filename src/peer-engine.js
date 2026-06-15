// peer-engine.js — Busca de figurinhas por inundação (flood search)
//
// Como funciona o flood search:
//  1. Nó A inicia: gera um query_id único e envia SEARCH para todos os vizinhos com TTL=7
//  2. Cada nó que recebe SEARCH verifica se já processou aquele query_id (deduplicação)
//  3. Se não processou: verifica inventário local e repassa para vizinhos com TTL-1
//  4. Quem tiver a figurinha envia SEARCH_HIT de volta pelo caminho que veio
//  5. O HIT é roteado de volta até chegar ao nó A que iniciou a busca
//
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const { buildSearch, buildSearchHit } = require('./protocol');

const DEFAULT_TTL = 7; // Número máximo de saltos na rede

class PeerEngine extends EventEmitter {
  constructor(config, inventory, neighborManager) {
    super();
    this.peerId      = config.peer_id;
    this.ttl         = config.default_ttl || DEFAULT_TTL;
    this.inventory   = inventory;
    this.neighbors   = neighborManager;

    // query_id → ws de origem (null = eu sou o originador)
    // Serve tanto para deduplicação quanto para roteamento reverso dos HITs
    this.queryRoutes = new Map();

    // query_id → lista de resultados (só para buscas que eu iniciei)
    this.searchResults = new Map();

    // Limpar cache quando ficar muito grande
    setInterval(() => this._cleanCache(), 5 * 60 * 1000);
  }

  // Iniciar uma busca (chamado pela UI)
  search(stickerId) {
    const queryId = uuidv4();

    // Registrar antes de enviar para ignorar qualquer eco de volta
    this.queryRoutes.set(queryId, null); // null = sou o originador
    this.searchResults.set(queryId, []);

    // Verificar primeiro no próprio inventário
    if (this.inventory.has(stickerId)) {
      const qty = this.inventory.getQuantity(stickerId);
      this._addResult(queryId, { owner_peer_id: this.peerId, sticker_id: stickerId, query_id: queryId, quantity: qty });
    }

    // Enviar SEARCH para cada vizinho com receiver_peer_id preenchido (obrigatório na spec)
    for (const { peer_id } of this.neighbors.getConnectedPeers()) {
      this.neighbors.sendTo(peer_id, buildSearch(this.peerId, this.peerId, peer_id, stickerId, this.ttl, queryId));
    }

    // Timeout: se nenhum resultado aparecer em 8s, notificar a UI
    setTimeout(() => {
      const results = this.searchResults.get(queryId);
      if (results && results.length === 0) {
        console.log(`[BUSCA] Timeout sem resultados: ${stickerId} (${queryId.slice(0, 8)}...)`);
        this.emit('search_no_results', { query_id: queryId, sticker_id: stickerId });
      }
    }, 8000);

    console.log(`[BUSCA] Iniciada: ${stickerId} (query: ${queryId.slice(0, 8)}...)`);
    this.emit('search_started', { query_id: queryId, sticker_id: stickerId });
    return queryId;
  }

  // Processar SEARCH recebido de um vizinho
  handleSearch(msg, sourceWs) {
    const { query_id, sticker_id, ttl, sender_peer_id, origin_peer_id } = msg;

    // Descartar se já processamos esta busca (regra de deduplicação)
    if (this.queryRoutes.has(query_id)) {
      console.log(`[BUSCA] Duplicata ignorada: ${query_id.slice(0, 8)}...`);
      return;
    }

    // Guardar rota reversa para poder enviar o HIT de volta
    this.queryRoutes.set(query_id, sourceWs);
    console.log(`[BUSCA] Recebida de ${sender_peer_id}: ${sticker_id} (TTL: ${ttl})`);

    // Se temos a figurinha, responder com SEARCH_HIT pelo mesmo caminho que veio
    if (this.inventory.has(sticker_id)) {
      const qty = this.inventory.getQuantity(sticker_id);
      const hit = buildSearchHit(this.peerId, this.peerId, origin_peer_id, query_id, sticker_id, qty);
      this.neighbors.sendToWs(sourceWs, hit);
      console.log(`[BUSCA] ✓ HIT! Tenho ${sticker_id} (${qty}x)`);
      this.emit('search_hit_sent', { query_id, sticker_id, quantity: qty });
    }

    // Repassar para os outros vizinhos se ainda há TTL (exceto para quem nos enviou)
    if (ttl > 1) {
      for (const { peer_id } of this.neighbors.getConnectedPeers()) {
        if (peer_id === sender_peer_id) continue; // não devolver para quem enviou
        this.neighbors.sendTo(peer_id, buildSearch(origin_peer_id, this.peerId, peer_id, sticker_id, ttl - 1, query_id));
      }
      console.log(`[BUSCA] Repassada com TTL ${ttl - 1}`);
    }
  }

  // Processar SEARCH_HIT recebido
  handleSearchHit(msg, sourceWs) {
    const { query_id, sticker_id, origin_peer_id, quantity } = msg;

    const routeWs = this.queryRoutes.get(query_id);

    if (routeWs === null) {
      // Eu iniciei esta busca — armazenar resultado e notificar UI
      const result = { owner_peer_id: origin_peer_id, sticker_id, query_id, quantity: quantity || 0 };
      this._addResult(query_id, result);
      this.emit('search_hit', result);
    } else if (routeWs) {
      // Não sou o originador — encaminhar HIT de volta pelo caminho reverso
      this.neighbors.sendToWs(routeWs, msg);
      console.log(`[BUSCA] HIT de ${origin_peer_id} encaminhado de volta`);
    }
  }

  // SEARCH_MISS é opcional na spec — apenas logar
  handleSearchMiss(msg) {
    console.log(`[BUSCA] MISS de ${msg.sender_peer_id}: não tem ${msg.sticker_id}`);
  }

  // Resultados acumulados de uma busca iniciada por este nó
  getSearchResults(queryId) {
    return this.searchResults.get(queryId) || [];
  }

  _addResult(queryId, hit) {
    if (!this.searchResults.has(queryId)) this.searchResults.set(queryId, []);
    this.searchResults.get(queryId).push(hit);
    console.log(`[BUSCA] Resultado: ${hit.origin_peer_id} tem ${hit.sticker_id}`);
  }

  _cleanCache() {
    if (this.queryRoutes.size > 1000) {
      this.queryRoutes.clear();
      this.searchResults.clear();
      console.log('[BUSCA] Cache de queries limpo');
    }
  }
}

module.exports = PeerEngine;
