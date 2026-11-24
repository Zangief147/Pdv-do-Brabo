'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const padrao = () => ({
  produtos: [],
  vendas: [],
  seqProduto: 1,
  seqVenda: 1,
  clientes: [],
  seqCliente: 1,
  ordens: [],
  seqOS: 1,
  usuarios: [],
  seqUsuario: 1,
  sessoes: {},
  caixa: { aberto: false, fundo: 0, aberturaEm: null, abertoPor: null, movimentacoes: [] },
  fechamentos: [],
  seqFechamento: 1,
  configuracao: {
    loja: { nome: '', cnpj: '', endereco: '', telefone: '' },
    cupom: { mensagem: 'Obrigado pela preferência! Volte sempre.' },
  },
});

let db = null;

function migrar(dados) {
  const base = padrao();
  const d = { ...base, ...dados };
  for (const chaveLista of ['produtos', 'vendas', 'usuarios', 'fechamentos', 'clientes', 'ordens']) {
    if (!Array.isArray(d[chaveLista])) d[chaveLista] = [];
  }
  for (const chaveNum of ['seqProduto', 'seqVenda', 'seqUsuario', 'seqFechamento', 'seqCliente', 'seqOS']) {
    if (!Number.isInteger(d[chaveNum])) d[chaveNum] = base[chaveNum];
  }
  if (!d.sessoes || typeof d.sessoes !== 'object') d.sessoes = {};
  if (!d.caixa || typeof d.caixa !== 'object') d.caixa = base.caixa;
  if (!Array.isArray(d.caixa.movimentacoes)) d.caixa.movimentacoes = [];
  if (!d.caixas || typeof d.caixas !== 'object' || Array.isArray(d.caixas)) d.caixas = {};
  if (d.caixa.aberto && !d.caixas.legado) {
    d.caixas.legado = d.caixa;
  }
  if (!d.configuracao || typeof d.configuracao !== 'object') d.configuracao = base.configuracao;
  if (!d.configuracao.loja || typeof d.configuracao.loja !== 'object') d.configuracao.loja = base.configuracao.loja;
  if (!d.configuracao.cupom || typeof d.configuracao.cupom !== 'object') d.configuracao.cupom = base.configuracao.cupom;
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

module.exports = { carregar, salvar, DB_FILE, DATA_DIR };
