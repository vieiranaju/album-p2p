// peer-engine.js — Motor P2P: roteamento, flood search, deduplicação
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const {
  MSG_TYPES,
  buildSearch,
  buildSearchHit,
  buildSearchMiss,
} = require('./protocol');

class PeerEngine extends EventEmitter {
  constructor(config, inventory, neighborManager, tradeManager) {
    super();
    this.peerId = config.peer_id;
    this.stickerId = config.sticker_id;
    this.defaultTtl = config.default_ttl || 7;
    this.inventory = inventory;
    this.neighborManager = neighborManager;
    this.tradeManager = tradeManager;

    // Deduplicação de buscas: Set<query_id>
    this.processedQueries = new Set();

    // Mapa de roteamento reverso para SEARCH_HIT: query_id -> ws (de onde veio)
    this.queryRoutes = new Map();

    // Resultados de busca pendentes: query_id -> [hits]
    this.searchResults = new Map();

    // Limpar queries antigas a cada 5 minutos
    this.QUERY_EXPIRY_MS = 5 * 60 * 1000;
    setInterval(() => this._cleanupQueries(), this.QUERY_EXPIRY_MS);
  }

  // Iniciar busca por uma figurinha (chamado pela UI)
  search(stickerId) {
    const queryId = uuidv4();
    const msg = buildSearch(this.peerId, stickerId, this.defaultTtl, this.peerId, queryId);

    // Registrar no cache de deduplicação
    this.processedQueries.add(queryId);
    this.queryRoutes.set(queryId, null); // null = eu sou o originador

    // Inicializar resultados
    this.searchResults.set(queryId, []);

    // Verificar inventário local primeiro
    if (this.inventory.has(stickerId)) {
      const hit = {
        peer_id: this.peerId,
        owner_peer_id: this.peerId,
        sticker_id: stickerId,
        quantity: this.inventory.getQuantity(stickerId),
        query_id: queryId,
      };
      this.searchResults.get(queryId).push(hit);
      this.emit('search_hit', hit);
    }

    // Inundar a rede
    const count = this.neighborManager.broadcast(msg);
    console.log(`[BUSCA] Iniciada: ${stickerId} (query: ${queryId.substring(0, 8)}...) → enviada para ${count} vizinhos`);

    this.emit('search_started', { query_id: queryId, sticker_id: stickerId });

    return queryId;
  }

  // Processar mensagem SEARCH recebida (flood)
  handleSearch(msg, sourceWs) {
    const { query_id, sticker_id, ttl, peer_id, origin_peer_id } = msg;

    // 1. Verificar duplicata
    if (this.processedQueries.has(query_id)) {
      console.log(`[BUSCA] Duplicata ignorada: ${query_id.substring(0, 8)}...`);
      return;
    }

    // 2. Registrar query_id
    this.processedQueries.add(query_id);
    this.queryRoutes.set(query_id, sourceWs); // Guardar rota reversa

    console.log(`[BUSCA] Recebida de ${peer_id}: ${sticker_id} (TTL: ${ttl}, query: ${query_id.substring(0, 8)}...)`);

    // 3. Verificar inventário local
    if (this.inventory.has(sticker_id)) {
      const qty = this.inventory.getQuantity(sticker_id);
      const hitMsg = buildSearchHit(this.peerId, query_id, sticker_id, this.peerId, qty);

      // Enviar SEARCH_HIT de volta pelo caminho de onde veio
      this.neighborManager.sendToWs(sourceWs, hitMsg);
      console.log(`[BUSCA] ✓ HIT! Tenho ${qty}x ${sticker_id}`);

      this.emit('search_hit_sent', { query_id, sticker_id, quantity: qty });
    }

    // 4. Se TTL > 1, reencaminhar para vizinhos (exceto remetente)
    if (ttl > 1) {
      const forwardMsg = buildSearch(
        this.peerId,
        sticker_id,
        ttl - 1,
        origin_peer_id,
        query_id
      );

      const senderPeerId = peer_id;
      const count = this.neighborManager.broadcast(forwardMsg, senderPeerId);
      console.log(`[BUSCA] Reencaminhada para ${count} vizinhos (TTL: ${ttl - 1})`);
    } else {
      console.log(`[BUSCA] TTL esgotado para query ${query_id.substring(0, 8)}...`);
    }
  }

  // Processar SEARCH_HIT recebido
  handleSearchHit(msg, sourceWs) {
    const { query_id, sticker_id, owner_peer_id, quantity } = msg;

    console.log(`[BUSCA] ✓ HIT recebido: ${owner_peer_id} tem ${quantity}x ${sticker_id}`);

    // Se eu sou o originador da busca
    const routeWs = this.queryRoutes.get(query_id);
    if (routeWs === null) {
      // Eu originei esta busca — armazenar resultado
      if (!this.searchResults.has(query_id)) {
        this.searchResults.set(query_id, []);
      }
      this.searchResults.get(query_id).push({
        owner_peer_id,
        sticker_id,
        quantity,
        query_id,
      });
      this.emit('search_hit', { owner_peer_id, sticker_id, quantity, query_id });
    } else if (routeWs) {
      // Reencaminhar SEARCH_HIT pelo caminho reverso
      this.neighborManager.sendToWs(routeWs, msg);
      console.log(`[BUSCA] HIT reencaminhado de volta`);
    }
  }

  // Processar SEARCH_MISS
  handleSearchMiss(msg) {
    console.log(`[BUSCA] MISS de ${msg.peer_id}: ${msg.sticker_id}`);
  }

  // Obter resultados de uma busca
  getSearchResults(queryId) {
    return this.searchResults.get(queryId) || [];
  }

  _cleanupQueries() {
    // Limpar queries antigas (simples: limpa tudo periodicamente)
    const size = this.processedQueries.size;
    if (size > 1000) {
      this.processedQueries.clear();
      this.queryRoutes.clear();
      console.log(`[BUSCA] Cache de queries limpo (tinha ${size} entradas)`);
    }
  }
}

module.exports = PeerEngine;
