// neighbor-manager.js — Gerenciamento de vizinhos e conexões WebSocket
const WebSocket = require('ws');
const EventEmitter = require('events');
const { buildHello } = require('./protocol');

class NeighborManager extends EventEmitter {
  constructor(config) {
    super();
    this.peerId = config.peer_id;
    this.stickerId = config.sticker_id;
    this.neighborUrls = config.neighbors || [];

    // Map<peerId, { ws, url, direction }>
    this.connections = new Map();
    // Map<url, reconnectTimer>
    this.reconnectTimers = new Map();

    this.RECONNECT_BASE_MS = 3000;
    this.RECONNECT_MAX_MS = 30000;
    this.reconnectAttempts = new Map(); // Map<url, attemptCount>
  }

  // Iniciar conexões com todos os vizinhos configurados
  connectToAll() {
    for (const url of this.neighborUrls) {
      this._connectTo(url);
    }
  }

  // Conectar a um vizinho específico
  _connectTo(url) {
    if (this._isConnectedToUrl(url)) {
      console.log(`[VIZINHOS] Já conectado a ${url}`);
      return;
    }

    console.log(`[VIZINHOS] Conectando a ${url}...`);

    try {
      const ws = new WebSocket(url);

      ws._peerUrl = url;

      ws.on('open', () => {
        console.log(`[VIZINHOS] Conectado a ${url}`);
        this.reconnectAttempts.set(url, 0);

        // Enviar HELLO
        const hello = buildHello(this.peerId, this.stickerId);
        ws.send(JSON.stringify(hello));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          // Se recebemos HELLO, registrar o peer
          if (msg.type === 'HELLO' && msg.peer_id) {
            this._registerConnection(msg.peer_id, ws, url, 'outbound');
          }

          this.emit('message', msg, ws);
        } catch (err) {
          console.error('[VIZINHOS] Erro ao parsear mensagem:', err.message);
        }
      });

      ws.on('close', () => {
        const peerId = this._getPeerIdByWs(ws);
        if (peerId) {
          console.log(`[VIZINHOS] Desconectado de ${peerId} (${url})`);
          this.connections.delete(peerId);
          this.emit('disconnected', peerId);
        }
        this._scheduleReconnect(url);
      });

      ws.on('error', (err) => {
        console.error(`[VIZINHOS] Erro com ${url}:`, err.message);
      });
    } catch (err) {
      console.error(`[VIZINHOS] Falha ao conectar a ${url}:`, err.message);
      this._scheduleReconnect(url);
    }
  }

  // Registrar conexão de entrada (outro nó conectou a este)
  handleIncoming(ws) {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Se recebemos HELLO, registrar o peer
        if (msg.type === 'HELLO' && msg.peer_id) {
          this._registerConnection(msg.peer_id, ws, null, 'inbound');
          // Responder com HELLO
          const hello = buildHello(this.peerId, this.stickerId);
          ws.send(JSON.stringify(hello));
        }

        this.emit('message', msg, ws);
      } catch (err) {
        console.error('[VIZINHOS] Erro ao parsear mensagem (inbound):', err.message);
      }
    });

    ws.on('close', () => {
      const peerId = this._getPeerIdByWs(ws);
      if (peerId) {
        console.log(`[VIZINHOS] Vizinho ${peerId} desconectou`);
        this.connections.delete(peerId);
        this.emit('disconnected', peerId);
      }
    });

    ws.on('error', (err) => {
      console.error('[VIZINHOS] Erro (inbound):', err.message);
    });
  }

  _registerConnection(peerId, ws, url, direction) {
    // Evitar registrar a si mesmo
    if (peerId === this.peerId) return;

    // Se já existe conexão com este peer, substituir apenas se estiver fechada
    if (this.connections.has(peerId)) {
      const existing = this.connections.get(peerId);
      if (existing.ws.readyState === WebSocket.OPEN) {
        return; // Já conectado
      }
    }

    this.connections.set(peerId, { ws, url, direction, peerId });
    console.log(`[VIZINHOS] ✓ Registrado: ${peerId} (${direction})`);
    this.emit('connected', peerId);
  }

  _getPeerIdByWs(ws) {
    for (const [peerId, conn] of this.connections) {
      if (conn.ws === ws) return peerId;
    }
    return null;
  }

  _isConnectedToUrl(url) {
    for (const [, conn] of this.connections) {
      if (conn.url === url && conn.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  _scheduleReconnect(url) {
    if (this.reconnectTimers.has(url)) return;

    const attempts = this.reconnectAttempts.get(url) || 0;
    const delay = Math.min(
      this.RECONNECT_BASE_MS * Math.pow(2, attempts),
      this.RECONNECT_MAX_MS
    );

    console.log(`[VIZINHOS] Reconectando a ${url} em ${delay / 1000}s...`);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(url);
      this.reconnectAttempts.set(url, attempts + 1);
      this._connectTo(url);
    }, delay);

    this.reconnectTimers.set(url, timer);
  }

  // Enviar mensagem para um peer específico
  sendTo(peerId, msg) {
    const conn = this.connections.get(peerId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(msg));
      return true;
    }
    console.warn(`[VIZINHOS] Não é possível enviar para ${peerId}: não conectado`);
    return false;
  }

  // Broadcast para todos os vizinhos, exceto excludePeerId
  broadcast(msg, excludePeerId) {
    let count = 0;
    for (const [peerId, conn] of this.connections) {
      if (peerId === excludePeerId) continue;
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify(msg));
        count++;
      }
    }
    return count;
  }

  // Encaminhar mensagem de volta pelo caminho de onde veio (para SEARCH_HIT)
  sendToWs(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  getConnectedPeers() {
    const peers = [];
    for (const [peerId, conn] of this.connections) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        peers.push({ peer_id: peerId, direction: conn.direction });
      }
    }
    return peers;
  }

  isConnected(peerId) {
    const conn = this.connections.get(peerId);
    return conn && conn.ws.readyState === WebSocket.OPEN;
  }

  // Adicionar vizinho dinamicamente
  addNeighbor(url) {
    if (!this.neighborUrls.includes(url)) {
      this.neighborUrls.push(url);
    }
    this._connectTo(url);
  }

  // Desconectar de todos
  disconnectAll() {
    for (const [, conn] of this.connections) {
      conn.ws.close();
    }
    for (const [, timer] of this.reconnectTimers) {
      clearTimeout(timer);
    }
    this.connections.clear();
    this.reconnectTimers.clear();
  }
}

module.exports = NeighborManager;
