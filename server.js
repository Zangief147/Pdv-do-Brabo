'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { carregar, salvar } = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function json(res, status, corpo) {
  const buf = Buffer.from(JSON.stringify(corpo));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    let tamanho = 0;
    req.on('data', (chunk) => {
      tamanho += chunk.length;
      if (tamanho > 1e6) {
        reject(new Error('Corpo muito grande'));
        req.destroy();
        return;
      }
      dados += chunk;
    });
    req.on('end', () => {
      try {
        resolve(dados ? JSON.parse(dados) : {});
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

const brl = (n) => Math.round(Number(n) * 100) / 100;

function validarProduto(p) {
  if (!p || typeof p !== 'object') return 'Payload inválido';
  if (!String(p.codigo || '').trim()) return 'Código obrigatório';
  if (!String(p.nome || '').trim()) return 'Nome obrigatório';
  const preco = Number(p.preco);
  if (!Number.isFinite(preco) || preco < 0) return 'Preço inválido';
  const estoque = Number(p.estoque ?? 0);
  if (!Number.isFinite(estoque) || estoque < 0) return 'Estoque inválido';
  return null;
}

function produtoJSON(p) {
  return {
    id: p.id,
    codigo: p.codigo,
    nome: p.nome,
    preco: p.preco,
    estoque: p.estoque,
    unidade: p.unidade || 'UN',
  };
}

function vendaJSON(v) {
  return {
    id: v.id,
    data: v.data,
    itens: v.itens,
    subtotal: v.subtotal,
    desconto: v.desconto,
    total: v.total,
    pagamentos: v.pagamentos,
    troco: v.troco,
    operador: v.operador,
  };
}

function proximoId(chave) {
  const db = carregar();
  return db[chave]++;
}

function resumoDia(agora = new Date()) {
  const db = carregar();
  const inicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
  const doDia = db.vendas.filter((v) => new Date(v.data).getTime() >= inicio);
  const porForma = {};
  for (const v of doDia) {
    for (const p of v.pagamentos) {
      porForma[p.forma] = brl((porForma[p.forma] || 0) + p.valor);
    }
  }
  return {
    aberto: db.caixa.aberto,
    fundoTroco: db.caixa.fundo,
    aberturaEm: db.caixa.aberturaEm,
    vendas: doDia.length,
    faturamento: brl(doDia.reduce((s, v) => s + v.total, 0)),
    porForma,
    estoqueBaixo: db.produtos.filter((p) => p.estoque <= 3).map(produtoJSON),
  };
}

async function rotear(req, res, url) {
  const db = carregar();
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/resumo' && method === 'GET') {
    return json(res, 200, resumoDia());
  }

  if (pathname === '/api/caixa/abrir' && method === 'POST') {
    if (db.caixa.aberto) return json(res, 400, { erro: 'Caixa já está aberto' });
    const corpo = await lerCorpo(req);
    db.caixa = { aberto: true, fundo: brl(corpo.fundo || 0), aberturaEm: new Date().toISOString() };
    salvar();
    return json(res, 200, db.caixa);
  }

  if (pathname === '/api/caixa/fechar' && method === 'POST') {
    if (!db.caixa.aberto) return json(res, 400, { erro: 'Caixa já está fechado' });
    const r = resumoDia();
    db.caixa = { aberto: false, fundo: 0, aberturaEm: null };
    salvar();
    return json(res, 200, r);
  }

  if (pathname === '/api/produtos' && method === 'GET') {
    return json(res, 200, db.produtos.map(produtoJSON));
  }

  if (pathname === '/api/produtos' && method === 'POST') {
    const p = await lerCorpo(req);
    const erro = validarProduto(p);
    if (erro) return json(res, 400, { erro });
    if (db.produtos.some((x) => x.codigo === String(p.codigo).trim())) {
      return json(res, 409, { erro: 'Código já cadastrado' });
    }
    const produto = {
      id: proximoId('seqProduto'),
      codigo: String(p.codigo).trim(),
      nome: String(p.nome).trim(),
      preco: brl(p.preco),
      estoque: Number(p.estoque ?? 0),
      unidade: String(p.unidade || 'UN').trim().toUpperCase(),
    };
    db.produtos.push(produto);
    salvar();
    return json(res, 201, produtoJSON(produto));
  }

  let m;
  if ((m = pathname.match(/^\/api\/produtos\/(\d+)$/))) {
    const id = Number(m[1]);
    const idx = db.produtos.findIndex((x) => x.id === id);
    if (idx === -1) return json(res, 404, { erro: 'Produto não encontrado' });

    if (method === 'PUT') {
      const p = await lerCorpo(req);
      const erro = validarProduto(p);
      if (erro) return json(res, 400, { erro });
      if (db.produtos.some((x) => x.id !== id && x.codigo === String(p.codigo).trim())) {
        return json(res, 409, { erro: 'Código já cadastrado' });
      }
      db.produtos[idx] = {
        ...db.produtos[idx],
        codigo: String(p.codigo).trim(),
        nome: String(p.nome).trim(),
        preco: brl(p.preco),
        estoque: Number(p.estoque ?? 0),
        unidade: String(p.unidade || 'UN').trim().toUpperCase(),
      };
      salvar();
      return json(res, 200, produtoJSON(db.produtos[idx]));
    }

    if (method === 'DELETE') {
      db.produtos.splice(idx, 1);
      salvar();
      return json(res, 204, null);
    }
  }

  if (pathname === '/api/produtos/busca' && method === 'GET') {
    const termo = (url.searchParams.get('q') || '').trim().toLowerCase();
    const resultados = db.produtos.filter(
      (p) => p.codigo.toLowerCase() === termo || p.nome.toLowerCase().includes(termo)
    );
    return json(res, 200, resultados.map(produtoJSON));
  }

  if (pathname === '/api/vendas' && method === 'GET') {
    const limite = Math.min(Number(url.searchParams.get('limite')) || 100, 500);
    const vendas = [...db.vendas].sort((a, b) => b.id - a.id).slice(0, limite);
    return json(res, 200, vendas.map(vendaJSON));
  }

  if (pathname === '/api/vendas' && method === 'POST') {
    if (!db.caixa.aberto) return json(res, 400, { erro: 'Abra o caixa antes de vender' });
    const corpo = await lerCorpo(req);
    const itens = Array.isArray(corpo.itens) ? corpo.itens : [];
    if (!itens.length) return json(res, 400, { erro: 'Venda sem itens' });

    const processados = [];
    for (const item of itens) {
      const produto = db.produtos.find((p) => p.id === Number(item.produtoId));
      if (!produto) return json(res, 400, { erro: `Produto ${item.produtoId} não encontrado` });
      const qtd = Number(item.qtd);
      if (!Number.isFinite(qtd) || qtd <= 0) return json(res, 400, { erro: 'Quantidade inválida' });
      if (produto.estoque < qtd) {
        return json(res, 400, { erro: `Estoque insuficiente para "${produto.nome}" (disponível: ${produto.estoque})` });
      }
      if (typeof item.precoUnit !== 'undefined' && brl(item.precoUnit) !== produto.preco) {
        return json(res, 400, { erro: `Preço alterado para "${produto.nome}". Atualize o carrinho.` });
      }
      processados.push({ produto, qtd });
    }

    const itensVenda = processados.map(({ produto, qtd }) => ({
      produtoId: produto.id,
      codigo: produto.codigo,
      nome: produto.nome,
      unidade: produto.unidade,
      qtd,
      precoUnit: produto.preco,
      total: brl(qtd * produto.preco),
    }));

    const subtotal = brl(itensVenda.reduce((s, i) => s + i.total, 0));
    const desconto = brl(Number(corpo.desconto) || 0);
    if (desconto < 0 || desconto > subtotal) return json(res, 400, { erro: 'Desconto inválido' });
    const total = brl(subtotal - desconto);

    const pagamentos = (Array.isArray(corpo.pagamentos) ? corpo.pagamentos : []).map((p) => ({
      forma: String(p.forma || 'dinheiro'),
      valor: brl(p.valor),
    }));
    const somaPago = brl(pagamentos.reduce((s, p) => s + p.valor, 0));
    if (somaPago < total) return json(res, 400, { erro: 'Valor pago menor que o total' });
    const troco = brl(somaPago - total);

    for (const { produto, qtd } of processados) produto.estoque = brl(produto.estoque - qtd);

    const venda = {
      id: proximoId('seqVenda'),
      data: new Date().toISOString(),
      itens: itensVenda,
      subtotal,
      desconto,
      total,
      pagamentos,
      troco,
      operador: String(corpo.operador || 'Operador').trim(),
    };
    db.vendas.push(venda);
    salvar();
    return json(res, 201, vendaJSON(venda));
  }

  return json(res, 404, { erro: 'Rota não encontrada' });
}

function servirArquivo(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const arquivo = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!arquivo.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Proibido');
    return;
  }
  fs.readFile(arquivo, (err, dados) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(arquivo).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(dados);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await rotear(req, res, url);
    return servirArquivo(res, url.pathname);
  } catch (err) {
    return json(res, 400, { erro: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PDV rodando em http://localhost:${PORT}`);
});
