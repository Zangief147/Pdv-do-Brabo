'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { carregar, salvar, DB_FILE } = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSAO = '2.0.0';
const SESSAO_MS = 12 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ================= utilidades ================= */

const brl = (n) => Math.round(Number(n) * 100) / 100;

function json(res, status, corpo, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(corpo));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    ...extraHeaders,
  });
  res.end(buf);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    let tamanho = 0;
    req.on('data', (chunk) => {
      tamanho += chunk.length;
      if (tamanho > 2e6) {
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

/* ================= autenticação ================= */

function hashSenha(senha, salt) {
  return crypto.scryptSync(String(senha), salt, 64).toString('hex');
}

function criarUsuario(dados) {
  const db = carregar();
  if (!String(dados.login || '').trim()) throw new Error('Login obrigatório');
  if (String(dados.senha || '').length < 4) throw new Error('Senha deve ter ao menos 4 caracteres');
  const login = String(dados.login).trim().toLowerCase();
  if (db.usuarios.some((u) => u.login === login)) throw new Error('Login já cadastrado');
  const salt = crypto.randomBytes(16).toString('hex');
  const usuario = {
    id: db.seqUsuario++,
    nome: String(dados.nome || login).trim(),
    login,
    salt,
    hash: hashSenha(dados.senha, salt),
    role: dados.role === 'admin' ? 'admin' : 'operador',
    ativo: true,
    criadoEm: new Date().toISOString(),
  };
  db.usuarios.push(usuario);
  salvar();
  return usuario;
}

function usuarioJSON(u) {
  return { id: u.id, nome: u.nome, login: u.login, role: u.role, ativo: u.ativo, criadoEm: u.criadoEm };
}

function autenticar(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  const db = carregar();
  const sessao = db.sessoes[token];
  if (!sessao || sessao.expiraEm < Date.now()) {
    if (sessao) {
      delete db.sessoes[token];
      salvar();
    }
    return null;
  }
  const usuario = db.usuarios.find((u) => u.id === sessao.usuarioId && u.ativo);
  return usuario ? { usuario, token } : null;
}

function abrirSessao(usuario) {
  const db = carregar();
  const token = crypto.randomBytes(32).toString('hex');
  db.sessoes[token] = { usuarioId: usuario.id, criadoEm: Date.now(), expiraEm: Date.now() + SESSAO_MS };
  salvar();
  return token;
}

function exigirAdmin(ctx, res) {
  if (ctx.usuario.role !== 'admin') {
    json(res, 403, { erro: 'Apenas administradores podem fazer isso' });
    return false;
  }
  return true;
}

/* ================= caixa ================= */

function dinheiroEsperado() {
  const db = carregar();
  if (!db.caixa.aberto) return 0;
  const inicio = new Date(db.caixa.aberturaEm).getTime();
  let espera = Number(db.caixa.fundo) || 0;
  for (const m of db.caixa.movimentacoes) {
    espera += m.tipo === 'suprimento' ? m.valor : -m.valor;
  }
  for (const v of db.vendas) {
    if (v.canceladaEm) continue;
    if (new Date(v.data).getTime() < inicio) continue;
    for (const p of v.pagamentos) {
      if (p.forma === 'dinheiro') espera += p.valor - (v.troco || 0);
    }
  }
  return brl(espera);
}

function fecharCaixa(operador, dinheiroContado) {
  const db = carregar();
  if (!db.caixa.aberto) throw new Error('Caixa já está fechado');
  const esperado = dinheiroEsperado();
  const contado = Number.isFinite(dinheiroContado) ? brl(dinheiroContado) : null;
  const inicio = new Date(db.caixa.aberturaEm).getTime();
  const doPeriodo = db.vendas.filter((v) => !v.canceladaEm && new Date(v.data).getTime() >= inicio);
  const registro = {
    id: db.seqFechamento++,
    aberturaEm: db.caixa.aberturaEm,
    fechadoEm: new Date().toISOString(),
    abertoPor: db.caixa.abertoPor,
    fechadoPor: operador.nome,
    fundo: brl(db.caixa.fundo),
    movimentacoes: db.caixa.movimentacoes,
    numVendas: doPeriodo.length,
    faturamento: brl(doPeriodo.reduce((s, v) => s + v.total, 0)),
    dinheiroEsperado: esperado,
    dinheiroContado: contado,
    diferenca: contado === null ? null : brl(contado - esperado),
  };
  db.fechamentos.push(registro);
  db.caixa = { aberto: false, fundo: 0, aberturaEm: null, abertoPor: null, movimentacoes: [] };
  salvar();
  return registro;
}

/* ================= venda / relatórios ================= */

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
    cliente: v.cliente || '',
    obs: v.obs || '',
    canceladaEm: v.canceladaEm || null,
    canceladaPor: v.canceladaPor || null,
    motivoCancelamento: v.motivoCancelamento || null,
  };
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

function faixaDatas(query) {
  const de = query.get('de');
  const ate = query.get('ate');
  if (!de || !/^\d{4}-\d{2}-\d{2}$/.test(de)) throw new Error('Parâmetro "de" deve ser YYYY-MM-DD');
  if (!ate || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) throw new Error('Parâmetro "ate" deve ser YYYY-MM-DD');
  const inicio = new Date(`${de}T00:00:00`).getTime();
  const fim = new Date(`${ate}T23:59:59.999`).getTime();
  if (inicio > fim) throw new Error('Período inválido');
  return { inicio, fim, de, ate };
}

function relatorio(inicio, fim) {
  const db = carregar();
  const noPeriodo = db.vendas.filter(
    (v) => new Date(v.data).getTime() >= inicio && new Date(v.data).getTime() <= fim
  );
  const validas = noPeriodo.filter((v) => !v.canceladaEm);
  const canceladas = noPeriodo.filter((v) => v.canceladaEm);
  const porForma = new Map();
  const porDia = new Map();
  const topProdutos = new Map();
  for (const v of validas) {
    const dia = v.data.slice(0, 10);
    per(porDia, dia, v.total, 1);
    for (const p of v.pagamentos) per(porForma, p.forma, p.valor, 0);
    for (const i of v.itens) per(topProdutos, i.nome, i.total, i.qtd);
  }
  const faturamento = brl(validas.reduce((s, v) => s + v.total, 0));
  return {
    de: new Date(inicio).toISOString().slice(0, 10),
    ate: new Date(fim).toISOString().slice(0, 10),
    numVendas: validas.length,
    numCanceladas: canceladas.length,
    faturamento,
    descontos: brl(validas.reduce((s, v) => s + v.desconto, 0)),
    ticketMedio: validas.length ? brl(faturamento / validas.length) : 0,
    porForma: Object.fromEntries([...porForma].map(([forma, d]) => [forma, d.total])),
    porDia: [...porDia.entries()]
      .map(([dia, d]) => ({ dia, total: d.total, vendas: d.num }))
      .sort((a, b) => a.dia.localeCompare(b.dia)),
    topProdutos: [...topProdutos.entries()]
      .map(([nome, d]) => ({ nome, total: d.total, qtd: Math.round(d.num * 1000) / 1000 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20),
    ultimosFechamentos: [...db.fechamentos]
      .sort((a, b) => b.id - a.id)
      .slice(0, 10)
      .map((f) => ({
        id: f.id,
        aberturaEm: f.aberturaEm,
        fechadoEm: f.fechadoEm,
        fechadoPor: f.fechadoPor,
        numVendas: f.numVendas,
        faturamento: f.faturamento,
        dinheiroEsperado: f.dinheiroEsperado,
        dinheiroContado: f.dinheiroContado,
        diferenca: f.diferenca,
      })),
  };

  function per(mapa, chave, total, num) {
    const atual = mapa.get(chave) || { total: 0, num: 0 };
    mapa.set(chave, { total: brl(atual.total + total), num: atual.num + num });
  }
}

function relatorioCSV(inicio, fim) {
  const db = carregar();
  const linhas = [
    ['id', 'data', 'operador', 'cliente', 'subtotal', 'desconto', 'total', 'pagamentos', 'troco', 'status'].join(';'),
  ];
  for (const v of [...db.vendas].sort((a, b) => a.id - b.id)) {
    const t = new Date(v.data).getTime();
    if (t < inicio || t > fim) continue;
    linhas.push(
      [
        v.id,
        new Date(v.data).toLocaleString('pt-BR'),
        v.operador,
        v.cliente || '',
        String(v.subtotal).replace('.', ','),
        String(v.desconto).replace('.', ','),
        String(v.total).replace('.', ','),
        v.pagamentos.map((p) => `${p.forma}:${String(p.valor).replace('.', ',')}`).join('+'),
        String(v.troco).replace('.', ','),
        v.canceladaEm ? 'cancelada' : 'ok',
      ]
        .map((c) => `"${String(c).replaceAll('"', '""')}"`)
        .join(';')
    );
  }
  return '\uFEFF' + linhas.join('\r\n');
}

/* ================= rotas ================= */

function saude() {
  const db = carregar();
  return { ok: true, versao: VERSAO, precisaSetup: db.usuarios.length === 0 };
}

async function rotear(req, res, url) {
  const db = carregar();
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/saude' && method === 'GET') {
    return json(res, 200, saude());
  }

  if (pathname === '/api/setup' && method === 'POST') {
    if (db.usuarios.length > 0) return json(res, 403, { erro: 'Setup já realizado' });
    const corpo = await lerCorpo(req);
    if (!corpo.senha) return json(res, 400, { erro: 'Senha obrigatória' });
    const usuario = criarUsuario({ ...corpo, role: 'admin' });
    return json(res, 201, { token: abrirSessao(usuario), usuario: usuarioJSON(usuario) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const corpo = await lerCorpo(req);
    const login = String(corpo.login || '').trim().toLowerCase();
    const usuario = db.usuarios.find((u) => u.login === login);
    if (!usuario || !usuario.ativo || hashSenha(corpo.senha || '', usuario.salt) !== usuario.hash) {
      return json(res, 401, { erro: 'Login ou senha incorretos' });
    }
    return json(res, 200, { token: abrirSessao(usuario), usuario: usuarioJSON(usuario) });
  }

  const ctx = autenticar(req);
  if (!ctx) return json(res, 401, { erro: 'Não autenticado' });
  const { usuario } = ctx;

  if (pathname === '/api/me' && method === 'GET') {
    return json(res, 200, usuarioJSON(usuario));
  }

  if (pathname === '/api/logout' && method === 'POST') {
    delete db.sessoes[ctx.token];
    salvar();
    return json(res, 204, null);
  }

  if (pathname === '/api/configuracao' && method === 'GET') {
    return json(res, 200, { configuracao: db.configuracao, versao: VERSAO });
  }

  if (pathname === '/api/configuracao' && method === 'PUT') {
    if (!exigirAdmin({ usuario }, res)) return;
    const corpo = await lerCorpo(req);
    if (corpo.loja) {
      for (const chave of ['nome', 'cnpj', 'endereco', 'telefone']) {
        if (typeof corpo.loja[chave] === 'string') db.configuracao.loja[chave] = corpo.loja[chave].trim();
      }
    }
    if (typeof corpo.cupom?.mensagem === 'string') db.configuracao.cupom.mensagem = corpo.cupom.mensagem.trim();
    salvar();
    return json(res, 200, { configuracao: db.configuracao });
  }

  if (pathname === '/api/backup' && method === 'GET') {
    if (!exigirAdmin({ usuario }, res)) return;
    const conteudo = fs.readFileSync(DB_FILE);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="pdv-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'Content-Length': conteudo.length,
    });
    return res.end(conteudo);
  }

  if (pathname === '/api/resumo' && method === 'GET') {
    return json(res, 200, resumo());
  }

  function resumo() {
    const dbLocal = carregar();
    const agora = new Date();
    const inicioDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
    const doDia = dbLocal.vendas.filter((v) => !v.canceladaEm && new Date(v.data).getTime() >= inicioDia);
    const porForma = {};
    for (const v of doDia) {
      for (const p of v.pagamentos) {
        porForma[p.forma] = brl((porForma[p.forma] || 0) + p.valor);
      }
    }
    return {
      aberto: dbLocal.caixa.aberto,
      fundo: brl(dbLocal.caixa.fundo),
      aberturaEm: dbLocal.caixa.aberturaEm,
      abertoPor: dbLocal.caixa.abertoPor,
      dinheiroEsperado: dinheiroEsperado(),
      movimentacoes: dbLocal.caixa.movimentacoes.slice(-50),
      vendas: doDia.length,
      canceladasHoje: dbLocal.vendas.filter((v) => v.canceladaEm && new Date(v.canceladaEm).getTime() >= inicioDia).length,
      faturamento: brl(doDia.reduce((s, v) => s + v.total, 0)),
      porForma,
      estoqueBaixo: dbLocal.produtos.filter((p) => p.estoque <= 3).map(produtoJSON),
    };
  }

  if (pathname === '/api/caixa/abrir' && method === 'POST') {
    if (db.caixa.aberto) return json(res, 400, { erro: 'Caixa já está aberto' });
    const corpo = await lerCorpo(req);
    db.caixa = {
      aberto: true,
      fundo: brl(Math.max(0, Number(corpo.fundo) || 0)),
      aberturaEm: new Date().toISOString(),
      abertoPor: usuario.nome,
      movimentacoes: [],
    };
    salvar();
    return json(res, 200, { aberto: true, fundo: db.caixa.fundo, aberturaEm: db.caixa.aberturaEm, abertoPor: usuario.nome });
  }

  if (pathname === '/api/caixa/fechar' && method === 'POST') {
    try {
      const corpo = await lerCorpo(req);
      const registro = fecharCaixa(usuario, corpo.dinheiroContado);
      return json(res, 200, registro);
    } catch (err) {
      return json(res, 400, { erro: err.message });
    }
  }

  if (pathname === '/api/caixa/movimentacao' && method === 'POST') {
    if (!db.caixa.aberto) return json(res, 400, { erro: 'Caixa fechado' });
    const corpo = await lerCorpo(req);
    const tipo = corpo.tipo === 'suprimento' ? 'suprimento' : 'sangria';
    const valor = brl(Number(corpo.valor));
    if (!Number.isFinite(valor) || valor <= 0) return json(res, 400, { erro: 'Valor inválido' });
    if (tipo === 'sangria' && valor > dinheiroEsperado()) {
      return json(res, 400, { erro: 'Sangria maior que o dinheiro disponível' });
    }
    const mov = { id: db.caixa.movimentacoes.length + 1, tipo, valor, motivo: String(corpo.motivo || '').trim(), usuario: usuario.nome, data: new Date().toISOString() };
    db.caixa.movimentacoes.push(mov);
    salvar();
    return json(res, 201, mov);
  }

  if (pathname === '/api/produtos' && method === 'GET') {
    return json(res, 200, db.produtos.map(produtoJSON));
  }

  if (pathname === '/api/produtos' && method === 'POST') {
    if (!exigirAdmin({ usuario }, res)) return;
    const p = await lerCorpo(req);
    const erro = validarProduto(p);
    if (erro) return json(res, 400, { erro });
    if (db.produtos.some((x) => x.codigo === String(p.codigo).trim())) {
      return json(res, 409, { erro: 'Código já cadastrado' });
    }
    const produto = {
      id: db.seqProduto++,
      codigo: String(p.codigo).trim(),
      nome: String(p.nome).trim(),
      preco: brl(p.preco),
      estoque: Number(p.estoque ?? 0),
      unidade: String(p.unidade || 'UN').trim().toUpperCase(),
      ativo: true,
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
      if (!exigirAdmin({ usuario }, res)) return;
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
      if (!exigirAdmin({ usuario }, res)) return;
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
      if (item.precoUnit !== undefined && brl(item.precoUnit) !== produto.preco) {
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
      id: db.seqVenda++,
      data: new Date().toISOString(),
      itens: itensVenda,
      subtotal,
      desconto,
      total,
      pagamentos,
      troco,
      operador: usuario.nome,
      cliente: String(corpo.cliente || '').trim(),
      obs: String(corpo.obs || '').trim(),
    };
    db.vendas.push(venda);
    salvar();
    return json(res, 201, vendaJSON(venda));
  }

  if ((m = pathname.match(/^\/api\/vendas\/(\d+)\/cancelar$/)) && method === 'POST') {
    if (!exigirAdmin({ usuario }, res)) return;
    const venda = db.vendas.find((v) => v.id === Number(m[1]));
    if (!venda) return json(res, 404, { erro: 'Venda não encontrada' });
    if (venda.canceladaEm) return json(res, 400, { erro: 'Venda já cancelada' });
    const corpo = await lerCorpo(req);
    for (const item of venda.itens) {
      const produto = db.produtos.find((p) => p.id === item.produtoId);
      if (produto) produto.estoque = brl(produto.estoque + item.qtd);
    }
    venda.canceladaEm = new Date().toISOString();
    venda.canceladaPor = usuario.nome;
    venda.motivoCancelamento = String(corpo.motivo || '').trim();
    salvar();
    return json(res, 200, vendaJSON(venda));
  }

  if (pathname === '/api/relatorios' && method === 'GET') {
    if (!exigirAdmin({ usuario }, res)) return;
    try {
      const { inicio, fim, de, ate } = faixaDatas(url.searchParams);
      const r = relatorio(inicio, fim);
      r.de = de;
      r.ate = ate;
      return json(res, 200, r);
    } catch (err) {
      return json(res, 400, { erro: err.message });
    }
  }

  if (pathname === '/api/relatorios/csv' && method === 'GET') {
    if (!exigirAdmin({ usuario }, res)) return;
    try {
      const { inicio, fim } = faixaDatas(url.searchParams);
      const csv = relatorioCSV(inicio, fim);
      return json(res, 200, { csv }, {
        'Content-Disposition': `attachment; filename="vendas-${url.searchParams.get('de')}_a_${url.searchParams.get('ate')}.csv"`,
      });
    } catch (err) {
      return json(res, 400, { erro: err.message });
    }
  }

  if (pathname === '/api/operadores' && method === 'GET') {
    if (!exigirAdmin({ usuario }, res)) return;
    return json(res, 200, db.usuarios.map(usuarioJSON));
  }

  if (pathname === '/api/operadores' && method === 'POST') {
    if (!exigirAdmin({ usuario }, res)) return;
    try {
      const dados = await lerCorpo(req);
      const novo = criarUsuario(dados);
      return json(res, 201, usuarioJSON(novo));
    } catch (err) {
      return json(res, 400, { erro: err.message });
    }
  }

  if ((m = pathname.match(/^\/api\/operadores\/(\d+)$/))) {
    if (!exigirAdmin({ usuario }, res)) return;
    const id = Number(m[1]);
    const alvo = db.usuarios.find((u) => u.id === id);
    if (!alvo) return json(res, 404, { erro: 'Operador não encontrado' });

    if (method === 'PUT') {
      const corpo = await lerCorpo(req);
      if (typeof corpo.nome === 'string') alvo.nome = corpo.nome.trim() || alvo.nome;
      if (typeof corpo.role === 'string') {
        if (alvo.id === usuario.id && corpo.role !== 'admin') {
          return json(res, 400, { erro: 'Você não pode remover seu próprio acesso de administrador' });
        }
        alvo.role = corpo.role === 'admin' ? 'admin' : 'operador';
      }
      if (typeof corpo.ativo === 'boolean') {
        if (alvo.id === usuario.id && !corpo.ativo) {
          return json(res, 400, { erro: 'Você não pode desativar a si mesmo' });
        }
        alvo.ativo = corpo.ativo;
        if (!corpo.ativo) {
          for (const [tok, s] of Object.entries(db.sessoes)) {
            if (s.usuarioId === alvo.id) delete db.sessoes[tok];
          }
        }
      }
      if (corpo.senha) {
        if (String(corpo.senha).length < 4) return json(res, 400, { erro: 'Senha deve ter ao menos 4 caracteres' });
        alvo.salt = crypto.randomBytes(16).toString('hex');
        alvo.hash = hashSenha(corpo.senha, alvo.salt);
        for (const [tok, s] of Object.entries(db.sessoes)) {
          if (s.usuarioId === alvo.id) delete db.sessoes[tok];
        }
      }
      salvar();
      return json(res, 200, usuarioJSON(alvo));
    }

    if (method === 'DELETE') {
      if (alvo.id === usuario.id) return json(res, 400, { erro: 'Você não pode excluir a si mesmo' });
      db.usuarios = db.usuarios.filter((u) => u.id !== id);
      for (const [tok, s] of Object.entries(db.sessoes)) {
        if (s.usuarioId === id) delete db.sessoes[tok];
      }
      salvar();
      return json(res, 204, null);
    }
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Porta ${PORT} já está em uso. Encerre o outro PDV ou use: PORT=<outra> node server.js`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PDV v${VERSAO} rodando em http://localhost:${PORT}`);
});
