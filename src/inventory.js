// inventory.js — Gerenciamento do inventário de figurinhas
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INVENTORY_FILE = path.join(DATA_DIR, 'inventory.json');

class Inventory extends EventEmitter {
  constructor(stickerId, initialQty = 28) {
    super();
    this.stickerId = stickerId;
    this.initialQty = initialQty;
    this.items = {}; // { sticker_id: quantity }
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(INVENTORY_FILE)) {
        const data = fs.readFileSync(INVENTORY_FILE, 'utf-8');
        this.items = JSON.parse(data);
        console.log('[INVENTÁRIO] Carregado do disco:', this.items);
      } else {
        // Inventário inicial: 28 cópias da figurinha do aluno
        this.items = { [this.stickerId]: this.initialQty };
        this._save();
        console.log('[INVENTÁRIO] Criado com', this.initialQty, 'cópias de', this.stickerId);
      }
    } catch (err) {
      console.error('[INVENTÁRIO] Erro ao carregar:', err.message);
      this.items = { [this.stickerId]: this.initialQty };
      this._save();
    }
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(INVENTORY_FILE, JSON.stringify(this.items, null, 2), 'utf-8');
    } catch (err) {
      console.error('[INVENTÁRIO] Erro ao salvar:', err.message);
    }
  }

  has(stickerId) {
    return (this.items[stickerId] || 0) > 0;
  }

  getQuantity(stickerId) {
    return this.items[stickerId] || 0;
  }

  getAll() {
    return { ...this.items };
  }

  getTotalUnique() {
    return Object.keys(this.items).filter(k => this.items[k] > 0).length;
  }

  getTotalCount() {
    return Object.values(this.items).reduce((sum, q) => sum + q, 0);
  }

  canTrade(stickerId, qty = 1) {
    return this.getQuantity(stickerId) >= qty;
  }

  add(stickerId, qty = 1) {
    if (qty <= 0) throw new Error('Quantidade deve ser positiva');
    this.items[stickerId] = (this.items[stickerId] || 0) + qty;
    this._save();
    this.emit('updated', this.getAll());
    console.log(`[INVENTÁRIO] +${qty} ${stickerId} (total: ${this.items[stickerId]})`);
  }

  remove(stickerId, qty = 1) {
    if (qty <= 0) throw new Error('Quantidade deve ser positiva');
    const current = this.items[stickerId] || 0;
    if (current < qty) {
      throw new Error(`Inventário insuficiente: ${stickerId} tem ${current}, precisa ${qty}`);
    }
    this.items[stickerId] = current - qty;
    if (this.items[stickerId] === 0) {
      delete this.items[stickerId];
    }
    this._save();
    this.emit('updated', this.getAll());
    console.log(`[INVENTÁRIO] -${qty} ${stickerId} (total: ${this.items[stickerId] || 0})`);
  }

  // Reset do inventário (para testes)
  reset() {
    this.items = { [this.stickerId]: this.initialQty };
    this._save();
    this.emit('updated', this.getAll());
    console.log('[INVENTÁRIO] Reset para estado inicial');
  }
}

module.exports = Inventory;
