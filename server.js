// server.js — Entry point: HTTP + WebSocket Server P2P
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// Carregar configuração
let configPath = path.join(__dirname, 'config.json');

// Suporte a --config para testes com múltiplos nós
const configArg = process.argv.find(a => a.startsWith('--config='));
if (configArg) {
  configPath = path.resolve(configArg.split('=')[1]);
}
const portArg = process.argv.find(a => a.startsWith('--port='));

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
if (portArg) {
  config.port = parseInt(portArg.split('=')[1]);
}

console.log('═══════════════════════════════════════════════');
console.log(`  🎴 Sistema de Figurinhas P2P`);
console.log(`  📛 Nó: ${config.peer_id}`);
console.log(`  🖼️  Figurinha: ${config.sticker_id}`);
console.log(`  🔌 Porta: ${config.port}`);
console.log('═══════════════════════════════════════════════');

// Módulos internos
const Inventory = require('./src/inventory');
const NeighborManager = require('./src/neighbor-manager');
const TradeManager = require('./src/trade-manager');
const PeerEngine = require('./src/peer-engine');
const MessageHandler = require('./src/message-handler');

// Inicializar módulos
const inventory = new Inventory(config.sticker_id, 28);
const neighborManager = new NeighborManager(config);

// Configurar Express
const app = express();
app.use(express.json());

// Servir arquivos estáticos da interface
app.use(express.static(path.join(__dirname, 'public')));

// Servir figurinhas PNG
app.use('/stickers', express.static(path.join(__dirname, 'stickers')));

// API REST para a UI

// GET /api/status — Status do nó
app.get('/api/status', (req, res) => {
  res.json({
    peer_id: config.peer_id,
    sticker_id: config.sticker_id,
    port: config.port,
    connected_peers: neighborManager.getConnectedPeers(),
    inventory: inventory.getAll(),
    total_unique: inventory.getTotalUnique(),
    total_count: inventory.getTotalCount(),
  });
});

// GET /api/inventory — Inventário completo
app.get('/api/inventory', (req, res) => {
  res.json(inventory.getAll());
});

// GET /api/neighbors — Lista de vizinhos
app.get('/api/neighbors', (req, res) => {
  res.json({
    configured: config.neighbors,
    connected: neighborManager.getConnectedPeers(),
  });
});

// POST /api/neighbors — Adicionar vizinho
app.post('/api/neighbors', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL do vizinho é obrigatória' });
  }
  neighborManager.addNeighbor(url);
  // Persistir no config
  if (!config.neighbors.includes(url)) {
    config.neighbors.push(url);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }
  res.json({ ok: true, url });
});

// Criar servidor HTTP
const server = http.createServer(app);

// Configurar WebSocket Server para peers P2P
const wssPeer = new WebSocket.Server({ noServer: true });

// Configurar WebSocket Server para UI local
const wssUi = new WebSocket.Server({ noServer: true });

// Clientes UI conectados
const uiClients = new Set();

// Função de broadcast para UI
function uiBroadcast(data) {
  for (const ws of uiClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// Inicializar Trade Manager e Peer Engine
const tradeManager = new TradeManager(config.peer_id, inventory, neighborManager);
const peerEngine = new PeerEngine(config, inventory, neighborManager, tradeManager);
const messageHandler = new MessageHandler(peerEngine, tradeManager, uiBroadcast);

// Eventos do inventário → UI
inventory.on('updated', (items) => {
  uiBroadcast(JSON.stringify({
    type: 'inventory_update',
    data: items,
    total_unique: inventory.getTotalUnique(),
    total_count: inventory.getTotalCount(),
  }));
});

// Eventos dos vizinhos → UI
neighborManager.on('connected', (peerId) => {
  uiBroadcast(JSON.stringify({
    type: 'neighbor_connected',
    data: { peer_id: peerId, peers: neighborManager.getConnectedPeers() },
  }));
});

neighborManager.on('disconnected', (peerId) => {
  uiBroadcast(JSON.stringify({
    type: 'neighbor_disconnected',
    data: { peer_id: peerId, peers: neighborManager.getConnectedPeers() },
  }));
});

// Eventos de busca → UI
peerEngine.on('search_started', (data) => {
  uiBroadcast(JSON.stringify({ type: 'search_started', data }));
});

peerEngine.on('search_hit', (data) => {
  uiBroadcast(JSON.stringify({ type: 'search_hit', data }));
});

peerEngine.on('search_hit_sent', (data) => {
  uiBroadcast(JSON.stringify({ type: 'search_hit_sent', data }));
});

// Eventos de troca → UI
tradeManager.on('trade_received', (data) => {
  uiBroadcast(JSON.stringify({ type: 'trade_received', data }));
});

tradeManager.on('trade_proposed', (data) => {
  uiBroadcast(JSON.stringify({ type: 'trade_proposed', data }));
});

tradeManager.on('trade_accepted', (data) => {
  uiBroadcast(JSON.stringify({ type: 'trade_accepted', data }));
});

tradeManager.on('trade_rejected', (data) => {
  uiBroadcast(JSON.stringify({ type: 'trade_rejected', data }));
});

tradeManager.on('trade_completed', (data) => {
  uiBroadcast(JSON.stringify({ type: 'trade_completed', data }));
});

tradeManager.on('trade_confirmed', (data) => {
  uiBroadcast(JSON.stringify({ type: 'trade_confirmed', data }));
});

// Roteamento de mensagens dos vizinhos
neighborManager.on('message', (msg, ws) => {
  messageHandler.handle(msg, ws);
});

// Handler de conexões P2P (entrada)
wssPeer.on('connection', (ws, req) => {
  const remoteAddr = req.socket.remoteAddress;
  console.log(`[WS] Conexão peer de entrada: ${remoteAddr}`);
  neighborManager.handleIncoming(ws);
});

// Handler de conexões da UI
wssUi.on('connection', (ws) => {
  console.log('[UI] Cliente conectado');
  uiClients.add(ws);

  // Enviar estado inicial
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      peer_id: config.peer_id,
      sticker_id: config.sticker_id,
      inventory: inventory.getAll(),
      total_unique: inventory.getTotalUnique(),
      total_count: inventory.getTotalCount(),
      peers: neighborManager.getConnectedPeers(),
      pending_trades: tradeManager.getPendingTrades(),
      trade_history: tradeManager.getTradeHistory(),
    },
  }));

  // Processar comandos da UI
  ws.on('message', (data) => {
    try {
      const cmd = JSON.parse(data.toString());
      handleUiCommand(cmd, ws);
    } catch (err) {
      console.error('[UI] Erro ao processar comando:', err.message);
      ws.send(JSON.stringify({ type: 'error', data: { message: err.message } }));
    }
  });

  ws.on('close', () => {
    console.log('[UI] Cliente desconectado');
    uiClients.delete(ws);
  });
});

// Comandos da UI
function handleUiCommand(cmd, ws) {
  switch (cmd.action) {
    case 'search': {
      const queryId = peerEngine.search(cmd.sticker_id);
      ws.send(JSON.stringify({
        type: 'search_initiated',
        data: { query_id: queryId, sticker_id: cmd.sticker_id },
      }));
      break;
    }

    case 'trade_propose': {
      try {
        const trade = tradeManager.proposeTrade(
          cmd.target_peer_id,
          cmd.offer_sticker_id,
          cmd.offer_qty || 1,
          cmd.want_sticker_id,
          cmd.want_qty || 1,
        );
        ws.send(JSON.stringify({ type: 'trade_proposed', data: trade }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', data: { message: err.message } }));
      }
      break;
    }

    case 'trade_accept': {
      try {
        tradeManager.acceptTrade(cmd.trade_id);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', data: { message: err.message } }));
      }
      break;
    }

    case 'trade_reject': {
      try {
        tradeManager.rejectTrade(cmd.trade_id, cmd.reason);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', data: { message: err.message } }));
      }
      break;
    }

    case 'add_neighbor': {
      neighborManager.addNeighbor(cmd.url);
      if (!config.neighbors.includes(cmd.url)) {
        config.neighbors.push(cmd.url);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      }
      ws.send(JSON.stringify({ type: 'neighbor_added', data: { url: cmd.url } }));
      break;
    }

    case 'get_status': {
      ws.send(JSON.stringify({
        type: 'status',
        data: {
          peer_id: config.peer_id,
          sticker_id: config.sticker_id,
          inventory: inventory.getAll(),
          total_unique: inventory.getTotalUnique(),
          total_count: inventory.getTotalCount(),
          peers: neighborManager.getConnectedPeers(),
          pending_trades: tradeManager.getPendingTrades(),
          trade_history: tradeManager.getTradeHistory(),
        },
      }));
      break;
    }

    case 'get_search_results': {
      const results = peerEngine.getSearchResults(cmd.query_id);
      ws.send(JSON.stringify({
        type: 'search_results',
        data: { query_id: cmd.query_id, results },
      }));
      break;
    }

    default:
      console.warn(`[UI] Comando desconhecido: ${cmd.action}`);
      ws.send(JSON.stringify({ type: 'error', data: { message: `Comando desconhecido: ${cmd.action}` } }));
  }
}

// Upgrade HTTP → WebSocket (diferenciar entre peer e UI)
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://localhost:${config.port}`);

  if (pathname === '/ws/ui') {
    wssUi.handleUpgrade(request, socket, head, (ws) => {
      wssUi.emit('connection', ws, request);
    });
  } else {
    // Qualquer outra rota WS é tratada como peer P2P
    wssPeer.handleUpgrade(request, socket, head, (ws) => {
      wssPeer.emit('connection', ws, request);
    });
  }
});

// Iniciar servidor
server.listen(config.port, () => {
  console.log(`\n🌐 Servidor HTTP:  http://localhost:${config.port}`);
  console.log(`🔗 WebSocket P2P:  ws://localhost:${config.port}/ws/peer`);
  console.log(`🖥️  WebSocket UI:   ws://localhost:${config.port}/ws/ui`);
  console.log(`📂 Figurinhas:     http://localhost:${config.port}/stickers/`);
  console.log(`\n📋 Inventário inicial:`, inventory.getAll());
  console.log(`👥 Vizinhos configurados: ${config.neighbors.length}`);

  // Conectar aos vizinhos configurados
  if (config.neighbors.length > 0) {
    console.log('\n🔄 Conectando aos vizinhos...');
    neighborManager.connectToAll();
  } else {
    console.log('\n⚠️  Nenhum vizinho configurado. Adicione via interface ou config.json');
  }

  console.log('\n✅ Sistema pronto!\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Encerrando...');
  neighborManager.disconnectAll();
  server.close(() => {
    console.log('Servidor encerrado.');
    process.exit(0);
  });
});
