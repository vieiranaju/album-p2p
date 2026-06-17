// neighbor-manager.js — Gerencia conexões WebSocket com outros peers da rede
const WebSocket = require('ws');
const EventEmitter = require('events');
const { buildHello } = require('./protocol');

const RECONNECT_DELAY_MS = 3000; // Tempo de espera antes de tentar reconectar

class NeighborManager extends EventEmitter {
  constructor(config) {
    super();
    this.peerId = config.peer_id;

    // Map<peerId, { ws, url, direction }>
    // Guarda a conexão WebSocket de cada vizinho conhecido
    this.peers = new Map();
  }

  // Conectar a todos os vizinhos listados no config
  connectToAll(urls) {
    for (const url of urls) {
      this._connect(url);
    }
  }

  // Abrir conexão de saída para um vizinho pelo URL
  _connect(url) {
    if (this._isOpen(url)) return;

    console.log(`[VIZINHOS] Conectando a ${url}...`);
    const ws = new WebSocket(url);

    ws.on('open',    ()    => this._onOpen(ws, url));
    ws.on('message', (raw) => this._onMessage(ws, raw, url, 'outbound'));
    ws.on('close',   ()    => this._onClose(ws, url));
    ws.on('error',   (err) => console.error(`[VIZINHOS] Erro em ${url}: ${err.message}`));
  }

  // Registrar uma conexão de entrada (outro peer conectou a este nó)
  acceptIncoming(ws) {
    ws.on('message', (raw) => this._onMessage(ws, raw, null, 'inbound'));
    ws.on('close',   ()    => this._onClose(ws, null));
    ws.on('error',   (err) => console.error(`[VIZINHOS] Erro (entrada): ${err.message}`));
  }

  // --- Handlers internos ---

  _onOpen(ws, url) {
    console.log(`[VIZINHOS] Conectado a ${url}`);
    ws.send(JSON.stringify(buildHello(this.peerId)));
  }

  _onMessage(ws, raw, url, direction) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error('[VIZINHOS] Mensagem inválida (não é JSON)');
      return;
    }

    // O HELLO identifica quem está do outro lado — registrar a conexão
    if (msg.type === 'HELLO' && msg.sender_peer_id) {
      this._register(msg.sender_peer_id, ws, url, direction);

      // Conexões de entrada exigem que respondamos com HELLO
      if (direction === 'inbound') {
        ws.send(JSON.stringify(buildHello(this.peerId)));
      }
    }

    this.emit('message', msg, ws);
  }

  _onClose(ws, url) {
    // Encontrar e remover o peer que desconectou
    for (const [peerId, peer] of this.peers) {
      if (peer.ws === ws) {
        console.log(`[VIZINHOS] Desconectado: ${peerId}`);
        this.peers.delete(peerId);
        this.emit('disconnected', { peer_id: peerId, peers: this.getConnectedPeers() });
        break;
      }
    }

    // Reconectar automaticamente apenas em conexões de saída
    if (url) {
      setTimeout(() => this._connect(url), RECONNECT_DELAY_MS);
    }
  }

  _register(peerId, ws, url, direction) {
    if (peerId === this.peerId) return; // Não registrar a si mesmo

    const alreadyRegistered = this._isOpen(null, peerId);

    if (!alreadyRegistered) {
      // Novo peer: registrar no Map
      this.peers.set(peerId, { ws, url, direction });
      console.log(`[VIZINHOS] ✓ ${peerId} registrado (${direction})`);
    } else {
      // Peer já registrado (ex: conexão simultânea outbound+inbound):
      // não substituímos a entrada, mas sempre emitimos 'connected'
      // para garantir que a UI fique atualizada
      console.log(`[VIZINHOS] ↺ ${peerId} HELLO duplicado (${direction}), atualizando UI`);
    }

    // Sempre emitir 'connected' para manter a UI sincronizada
    this.emit('connected', { peer_id: peerId, peers: this.getConnectedPeers() });
  }

  // Verifica se já há conexão aberta para uma URL ou peerId
  _isOpen(url, peerId) {
    for (const [id, peer] of this.peers) {
      const open = peer.ws.readyState === WebSocket.OPEN;
      if (peerId && id === peerId && open) return true;
      if (url && peer.url === url && open) return true;
    }
    return false;
  }

  // --- API pública ---

  // Enviar mensagem para um peer pelo seu ID
  sendTo(peerId, msg) {
    const peer = this.peers.get(peerId);
    if (peer?.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(JSON.stringify(msg));
      return true;
    }
    console.warn(`[VIZINHOS] Não conectado a ${peerId}`);
    return false;
  }

  // Enviar mensagem diretamente por um WebSocket (usado para roteamento reverso de SEARCH_HIT)
  sendToWs(ws, msg) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // Adicionar vizinho em tempo de execução (via UI ou API)
  addNeighbor(url) {
    this._connect(url);
  }

  // Lista de peers atualmente conectados
  getConnectedPeers() {
    const result = [];
    for (const [peerId, peer] of this.peers) {
      if (peer.ws.readyState === WebSocket.OPEN) {
        result.push({ peer_id: peerId, direction: peer.direction });
      }
    }
    return result;
  }

  // Fechar todas as conexões (chamado no shutdown)
  disconnectAll() {
    for (const peer of this.peers.values()) peer.ws.close();
    this.peers.clear();
  }
}

module.exports = NeighborManager;
