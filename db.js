'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const padrao = {
  produtos: [],
  vendas: [],
  seqProduto: 1,
  seqVenda: 1,
  caixa: { aberto: false, fundo: 0, aberturaEm: null },
};

let db = null;

function migrar(dados) {
  const d = { ...padrao, ...dados };
  d.produtos = Array.isArray(d.produtos) ? d.produtos : [];
  d.vendas = Array.isArray(d.vendas) ? d.vendas : [];
  if (!d.caixa || typeof d.caixa !== 'object') d.caixa = { ...padrao.caixa };
  return d;
}

function carregar() {
  if (db) return db;
  try {
    db = migrar(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch {
    db = migrar({});
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    salvar();
  }
  return db;
}

function salvar() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

module.exports = { carregar, salvar };
