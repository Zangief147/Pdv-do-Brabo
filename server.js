'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { carregar, salvar, DB_FILE, DATA_DIR } = require('./db');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSAO = '4.1.0';
const SESSAO_MS = 12 * 60 * 60 * 1000;
const LOGIN_MAX_TENTATIVAS = Number(process.env.PDV_LOGIN_MAX_TENTATIVAS) || 8;
const LOGIN_JANELA_MS = Number(process.env.PDV_LOGIN_JANELA_MS) || 5 * 60 * 1000;
const BACKUPS_DIR = path.join(__dirname, 'data', 'backups');
const AUDITORIA_FILE = path.join(DATA_DIR, 'auditoria.log');
const MAX_BACKUPS = 30;
const tentativasLogin = new Map();

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

function audit(usuario, acao, detalhe = {}) {
  try {
    fs.appendFileSync(AUDITORIA_FILE, JSON.stringify({
      data: new Date().toISOString(),
      usuario: usuario ? usuario.nome : '-',
      acao,
      ...detalhe,
    }) + '\n');
  } catch {}
}

function lerAuditoria(limite = 100) {
  try {
    const linhas = fs.readFileSync(AUDITORIA_FILE, 'utf8').trim().split('\n');
    return linhas.slice(-limite).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return { data: null, usuario: '?', acao: l }; }
    });
  } catch {
    return [];
  }
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

/* ================= caixas (um por operador) ================= */

function caixaDe(usuarioId, criar = true) {
  const db = carregar();
  if (!db.caixas) db.caixas = {};
  if (!db.caixas[usuarioId] && criar) {
    db.caixas[usuarioId] = { aberto: false, fundo: 0, aberturaEm: null, abertoPor: null, movimentacoes: [] };
  }
  return db.caixas[usuarioId];
}

function caixaJSON(c) {
  return {
    aberto: c.aberto,
    fundo: brl(c.fundo),
    aberturaEm: c.aberturaEm,
    abertoPor: c.abertoPor,
    movimentacoes: c.movimentacoes.slice(-50),
  };
}

function dinheiroEsperado(usuarioId) {
  const db = carregar();
  const caixa = caixaDe(usuarioId, false);
  if (!caixa || !caixa.aberto) return 0;
  const inicio = new Date(caixa.aberturaEm).getTime();
  let espera = Number(caixa.fundo) || 0;
  for (const m of caixa.movimentacoes) {
    espera += m.tipo === 'suprimento' ? m.valor : -m.valor;
  }
  for (const v of db.vendas) {
    if (v.canceladaEm) continue;
    if (v.usuarioId !== usuarioId) continue;
    if (new Date(v.data).getTime() < inicio) continue;
    for (const p of v.pagamentos) {
      if (p.forma === 'dinheiro') espera += p.valor - (v.troco || 0);
    }
  }
  return brl(espera);
}

function fecharCaixa(operador, dinheiroContado) {
  const db = carregar();
  const caixa = caixaDe(operador.id, false);
  if (!caixa || !caixa.aberto) throw new Error('Seu caixa já está fechado');
  const esperado = dinheiroEsperado(operador.id);
  const contado = Number.isFinite(dinheiroContado) ? brl(dinheiroContado) : null;
  const inicio = new Date(caixa.aberturaEm).getTime();
  const doPeriodo = db.vendas.filter(
    (v) => v.usuarioId === operador.id && !v.canceladaEm && new Date(v.data).getTime() >= inicio
  );
  const registro = {
    id: db.seqFechamento++,
    aberturaEm: caixa.aberturaEm,
    fechadoEm: new Date().toISOString(),
    abertoPor: caixa.abertoPor,
    fechadoPor: operador.nome,
    fundo: brl(caixa.fundo),
    movimentacoes: caixa.movimentacoes,
    numVendas: doPeriodo.length,
    faturamento: brl(doPeriodo.reduce((s, v) => s + v.total, 0)),
    dinheiroEsperado: esperado,
    dinheiroContado: contado,
    diferenca: contado === null ? null : brl(contado - esperado),
  };
  db.fechamentos.push(registro);
  db.caixas[operador.id] = { aberto: false, fundo: 0, aberturaEm: null, abertoPor: null, movimentacoes: [] };
  salvar();
  backupAuto(registro.id);
  return registro;
}

function backupAuto(rotulo) {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const nome = `caixa-${rotulo}-${new Date().toISOString().replace(/[:]/g, '-')}.json`;
    fs.copyFileSync(DB_FILE, path.join(BACKUPS_DIR, nome));
    const arquivos = fs.readdirSync(BACKUPS_DIR).sort();
    while (arquivos.length > MAX_BACKUPS) {
      fs.unlinkSync(path.join(BACKUPS_DIR, arquivos.shift()));
    }
  } catch {}
}

/* ================= entidades ================= */

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
    custo: brl(p.custo || 0),
    estoque: p.estoque,
    unidade: p.unidade || 'UN',
  };
}

function osJSON(o) {
  return {
    id: o.id,
    cliente: o.cliente,
    aparelho: o.aparelho,
    descricao: o.descricao || '',
    valor: brl(o.valor || 0),
    status: o.status,
    criadoEm: o.criadoEm,
    atualizadaEm: o.atualizadaEm,
  };
}

function clienteJSON(c) {
  return {
    id: c.id,
    nome: c.nome,
    telefone: c.telefone || '',
    obs: c.obs || '',
    saldo: brl(c.saldo),
    criadoEm: c.criadoEm,
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
  if (p.custo !== undefined && (!Number.isFinite(Number(p.custo)) || Number(p.custo) < 0)) return 'Custo inválido';
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
    const lucroVenda = v.itens.reduce((ls, i) => ls + (i.total - i.qtd * (i.custoUnit || 0)), 0);
    per(porDia, dia, v.total, 1, lucroVenda);
    for (const p of v.pagamentos) per(porForma, p.forma, p.valor, 0);
    for (const i of v.itens) per(topProdutos, i.nome, i.total, i.qtd);
  }
  const faturamento = brl(validas.reduce((s, v) => s + v.total, 0));
  const lucro = brl(validas.reduce((s, v) => s + v.itens.reduce(
    (ls, i) => ls + (i.total - (i.qtd * (i.custoUnit || 0))), 0), 0));
  return {
    de: new Date(inicio).toISOString().slice(0, 10),
    ate: new Date(fim).toISOString().slice(0, 10),
    numVendas: validas.length,
    numCanceladas: canceladas.length,
    faturamento,
    lucroEstimado: lucro,
    descontos: brl(validas.reduce((s, v) => s + v.desconto, 0)),
    ticketMedio: validas.length ? brl(faturamento / validas.length) : 0,
    porForma: Object.fromEntries([...porForma].map(([forma, d]) => [forma, d.total])),
    porDia: [...porDia.entries()]
      .map(([dia, d]) => ({ dia, total: d.total, vendas: d.num, lucro: d.lucro || 0 }))
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

  function per(mapa, chave, total, num, lucroItem = 0) {
    const atual = mapa.get(chave) || { total: 0, num: 0, lucro: 0 };
    mapa.set(chave, {
      total: brl(atual.total + total),
      num: atual.num + num,
      lucro: brl(atual.lucro + lucroItem),
    });
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
    audit(usuario, 'setup', { novo: usuario.login });
    return json(res, 201, { token: abrirSessao(usuario), usuario: usuarioJSON(usuario) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'desconhecido';
    const agora = Date.now();
    const estadoIp = tentativasLogin.get(ip);
    if (estadoIp && estadoIp.reset > agora && estadoIp.n >= LOGIN_MAX_TENTATIVAS) {
      const segundos = Math.ceil((estadoIp.reset - agora) / 1000);
      return json(res, 429, { erro: `Muitas tentativas. Tente de novo em ${segundos}s` });
    }
    const corpo = await lerCorpo(req);
    const login = String(corpo.login || '').trim().toLowerCase();
    const usuario = db.usuarios.find((u) => u.login === login);
    if (!usuario || !usuario.ativo || hashSenha(corpo.senha || '', usuario.salt) !== usuario.hash) {
      const estado = estadoIp && estadoIp.reset > agora ? estadoIp : { n: 0, reset: agora + LOGIN_JANELA_MS };
      estado.n += 1;
      tentativasLogin.set(ip, estado);
      const restam = Math.max(0, LOGIN_MAX_TENTATIVAS - estado.n);
      return json(res, 401, { erro: restam > 0 ? `Login ou senha incorretos (${restam} tentativas restantes)` : 'Muitas tentativas. Aguarde antes de tentar novamente' });
    }
    tentativasLogin.delete(ip);
    audit(usuario, 'login', { ip });
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
      if (corpo.loja.logo !== undefined) {
        const logo = String(corpo.loja.logo || '');
        if (logo && !/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/.test(logo)) {
          return json(res, 400, { erro: 'Logo deve ser um arquivo de imagem' });
        }
        if (logo.length > 400000) return json(res, 400, { erro: 'Logo muito grande (máximo ~300KB)' });
        db.configuracao.loja.logo = logo;
      }
    }
    if (typeof corpo.cupom?.mensagem === 'string') db.configuracao.cupom.mensagem = corpo.cupom.mensagem.trim();
    salvar();
    audit(usuario, 'config-alterada');
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

  if (pathname === '/api/auditoria' && method === 'GET') {
    if (!exigirAdmin({ usuario }, res)) return;
    const limite = Math.min(Number(url.searchParams.get('limite')) || 100, 500);
    return json(res, 200, lerAuditoria(limite));
  }

  function resumo() {
    const dbLocal = carregar();
    const propria = caixaDe(usuario.id, false);
    const agora = new Date();
    const inicioDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
    const doDia = dbLocal.vendas.filter((v) => !v.canceladaEm && new Date(v.data).getTime() >= inicioDia);
    const porForma = {};
    for (const v of doDia) {
      for (const p of v.pagamentos) {
        porForma[p.forma] = brl((porForma[p.forma] || 0) + p.valor);
      }
    }
    const caixasAbertos = [];
    for (const [uid, caixa] of Object.entries(dbLocal.caixas || {})) {
      if (caixa.aberto) {
        caixasAbertos.push({
          usuarioId: Number(uid),
          abertoPor: caixa.abertoPor,
          fundo: brl(caixa.fundo),
          dinheiro: dinheiroEsperado(Number(uid)),
          aberturaEm: caixa.aberturaEm,
        });
      }
    }
    return {
      caixa: caixaJSON(propria || { aberto: false, fundo: 0 }),
      aberto: !!propria?.aberto,
      fundo: brl(propria?.fundo || 0),
      aberturaEm: propria?.aberturaEm || null,
      abertoPor: propria?.abertoPor || null,
      dinheiroEsperado: dinheiroEsperado(usuario.id),
      caixasAbertos,
      movimentacoes: propria?.movimentacoes.slice(-50) || [],
      vendas: doDia.length,
      canceladasHoje: dbLocal.vendas.filter((v) => v.canceladaEm && new Date(v.canceladaEm).getTime() >= inicioDia).length,
      faturamento: brl(doDia.reduce((s, v) => s + v.total, 0)),
      porForma,
      estoqueBaixo: dbLocal.produtos.filter((p) => p.estoque <= 3).map(produtoJSON),
    };
  }

  if (pathname === '/api/resumo' && method === 'GET') {
    return json(res, 200, resumo());
  }

  if (pathname === '/api/caixa/abrir' && method === 'POST') {
    const propria = caixaDe(usuario.id);
    if (propria.aberto) return json(res, 400, { erro: 'Seu caixa já está aberto' });
    const corpo = await lerCorpo(req);
    Object.assign(propria, {
      aberto: true,
      fundo: brl(Math.max(0, Number(corpo.fundo) || 0)),
      aberturaEm: new Date().toISOString(),
      abertoPor: usuario.nome,
      movimentacoes: [],
    });
    salvar();
    audit(usuario, 'caixa-aberto', { fundo: propria.fundo });
    return json(res, 200, caixaJSON(propria));
  }

  if (pathname === '/api/caixa/fechar' && method === 'POST') {
    try {
      const corpo = await lerCorpo(req);
      const registro = fecharCaixa(usuario, corpo.dinheiroContado);
      audit(usuario, 'caixa-fechado', { diferenca: registro.diferenca, numVendas: registro.numVendas });
      return json(res, 200, registro);
    } catch (err) {
      return json(res, 400, { erro: err.message });
    }
  }

  if (pathname === '/api/caixa/movimentacao' && method === 'POST') {
    const propria = caixaDe(usuario.id, false);
    if (!propria || !propria.aberto) return json(res, 400, { erro: 'Seu caixa está fechado' });
    const corpo = await lerCorpo(req);
    const tipo = corpo.tipo === 'suprimento' ? 'suprimento' : 'sangria';
    const valor = brl(Number(corpo.valor));
    if (!Number.isFinite(valor) || valor <= 0) return json(res, 400, { erro: 'Valor inválido' });
    if (tipo === 'sangria' && valor > dinheiroEsperado(usuario.id)) {
      return json(res, 400, { erro: 'Sangria maior que o dinheiro disponível' });
    }
    const mov = { id: propria.movimentacoes.length + 1, tipo, valor, motivo: String(corpo.motivo || '').trim(), usuario: usuario.nome, data: new Date().toISOString() };
    propria.movimentacoes.push(mov);
    salvar();
    audit(usuario, `caixa-${tipo}`, { valor, motivo: mov.motivo });
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
      custo: brl(Number(p.custo) || 0),
      estoque: Number(p.estoque ?? 0),
      unidade: String(p.unidade || 'UN').trim().toUpperCase(),
      ativo: true,
    };
    db.produtos.push(produto);
    salvar();
    audit(usuario, 'produto-criado', { codigo: produto.codigo });
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
        custo: brl(Number(p.custo ?? db.produtos[idx].custo) || 0),
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
      audit(usuario, 'produto-excluido', { id });
      return json(res, 204, null);
    }
  }

  if ((m = pathname.match(/^\/api\/produtos\/(\d+)\/entrada$/)) && method === 'POST') {
    if (!exigirAdmin({ usuario }, res)) return;
    const produto = db.produtos.find((x) => x.id === Number(m[1]));
    if (!produto) return json(res, 404, { erro: 'Produto não encontrado' });
    const corpo = await lerCorpo(req);
    const qtd = Number(corpo.qtd);
    if (!Number.isFinite(qtd) || qtd <= 0) return json(res, 400, { erro: 'Quantidade inválida' });
    produto.estoque = brl(produto.estoque + qtd);
    salvar();
    audit(usuario, 'entrada-estoque', { produto: produto.codigo, qtd });
    return json(res, 200, produtoJSON(produto));
  }

  if (pathname === '/api/produtos/importar' && method === 'POST') {
    if (!exigirAdmin({ usuario }, res)) return;
    const corpo = await lerCorpo(req);
    const linhas = String(corpo.csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!linhas.length) return json(res, 400, { erro: 'CSV vazio' });
    if (linhas[0].toLowerCase().includes('codigo')) linhas.shift();
    if (linhas.length > 1000) return json(res, 400, { erro: 'Limite de 1000 linhas por importação' });
    let criados = 0;
    let atualizados = 0;
    const erros = [];
    linhas.forEach((linha, i) => {
      const [codigo, nome, preco, estoque, unidade, custo] = linha.split(/[;,\t]/).map((f) => (f || '').trim());
      if (!codigo || !nome || !Number.isFinite(Number(preco))) {
        erros.push({ linha: i + 1, motivo: 'código, nome e preço numérico são obrigatórios' });
        return;
      }
      const dados = {
        codigo,
        nome,
        preco: brl(preco),
        estoque: Number.isFinite(Number(estoque)) ? Number(estoque) : 0,
        unidade: (unidade || 'UN').toUpperCase(),
        custo: brl(Number(custo) || 0),
      };
      const existente = db.produtos.find((x) => x.codigo === codigo);
      if (existente) {
        Object.assign(existente, dados);
        atualizados += 1;
      } else {
        db.produtos.push({ id: db.seqProduto++, ativo: true, ...dados });
        criados += 1;
      }
    });
    salvar();
    audit(usuario, 'produtos-importados', { criados, atualizados, erros: erros.length });
    return json(res, 200, { criados, atualizados, erros });
  }

  if (pathname === '/api/produtos/busca' && method === 'GET') {
    const termo = (url.searchParams.get('q') || '').trim().toLowerCase();
    const resultados = db.produtos.filter(
      (p) => p.codigo.toLowerCase() === termo || p.nome.toLowerCase().includes(termo)
    );
    return json(res, 200, resultados.map(produtoJSON));
  }

  if (pathname === '/api/clientes' && method === 'GET') {
    return json(res, 200, [...db.clientes]
      .sort((a, b) => a.nome.localeCompare(b.nome))
      .map(clienteJSON));
  }

  if (pathname === '/api/clientes' && method === 'POST') {
    const corpo = await lerCorpo(req);
    if (!String(corpo.nome || '').trim()) return json(res, 400, { erro: 'Nome obrigatório' });
    const cliente = {
      id: db.seqCliente++,
      nome: String(corpo.nome).trim(),
      telefone: String(corpo.telefone || '').trim(),
      obs: String(corpo.obs || '').trim(),
      saldo: 0,
      movimentos: [],
      criadoEm: new Date().toISOString(),
    };
    db.clientes.push(cliente);
    salvar();
    return json(res, 201, clienteJSON(cliente));
  }

  if ((m = pathname.match(/^\/api\/clientes\/(\d+)$/))) {
    const cliente = db.clientes.find((c) => c.id === Number(m[1]));
    if (!cliente) return json(res, 404, { erro: 'Cliente não encontrado' });

    if (method === 'GET') {
      return json(res, 200, { ...clienteJSON(cliente), movimentos: cliente.movimentos.slice(-50).reverse() });
    }

    if (method === 'PUT') {
      const corpo = await lerCorpo(req);
      if (typeof corpo.nome === 'string' && corpo.nome.trim()) cliente.nome = corpo.nome.trim();
      if (typeof corpo.telefone === 'string') cliente.telefone = corpo.telefone.trim();
      if (typeof corpo.obs === 'string') cliente.obs = corpo.obs.trim();
      salvar();
      return json(res, 200, clienteJSON(cliente));
    }

    if (method === 'DELETE') {
      if (!exigirAdmin({ usuario }, res)) return;
      if (cliente.saldo > 0.005) return json(res, 400, { erro: 'Cliente tem fiado em aberto' });
      db.clientes = db.clientes.filter((c) => c.id !== cliente.id);
      salvar();
      return json(res, 204, null);
    }
  }

  if ((m = pathname.match(/^\/api\/clientes\/(\d+)\/receber$/)) && method === 'POST') {
    const cliente = db.clientes.find((c) => c.id === Number(m[1]));
    if (!cliente) return json(res, 404, { erro: 'Cliente não encontrado' });
    const corpo = await lerCorpo(req);
    const valor = brl(Number(corpo.valor));
    if (!Number.isFinite(valor) || valor <= 0) return json(res, 400, { erro: 'Valor inválido' });
    if (valor > brl(cliente.saldo) + 0.005) return json(res, 400, { erro: 'Valor maior que a dívida' });
    const forma = String(corpo.forma || 'dinheiro');
    cliente.saldo = brl(cliente.saldo - valor);
    cliente.movimentos.push({ data: new Date().toISOString(), tipo: 'credito', valor, forma, motivo: String(corpo.motivo || 'Recebimento').trim() });
    const propria = caixaDe(usuario.id, false);
    if (forma === 'dinheiro' && propria && propria.aberto) {
      propria.movimentacoes.push({
        id: propria.movimentacoes.length + 1,
        tipo: 'suprimento',
        valor,
        motivo: `Recebimento fiado: ${cliente.nome}`,
        usuario: usuario.nome,
        data: new Date().toISOString(),
      });
    }
    salvar();
    audit(usuario, 'fiado-recebido', { cliente: cliente.nome, valor, forma });
    return json(res, 200, clienteJSON(cliente));
  }


  if (pathname === '/api/os' && method === 'GET') {
    const status = url.searchParams.get('status');
    const lista = [...db.ordens].sort((a, b) => b.id - a.id);
    const filtradas = status ? lista.filter((o) => o.status === status) : lista;
    return json(res, 200, filtradas.map(osJSON));
  }

  if (pathname === '/api/os' && method === 'POST') {
    const corpo = await lerCorpo(req);
    const cliente = String(corpo.cliente || '').trim();
    const aparelho = String(corpo.aparelho || '').trim();
    if (!cliente) return json(res, 400, { erro: 'Cliente obrigatório' });
    if (!aparelho) return json(res, 400, { erro: 'Aparelho/item obrigatório' });
    const valor = brl(Number(corpo.valor) || 0);
    if (!Number.isFinite(valor) || valor < 0) return json(res, 400, { erro: 'Valor inválido' });
    const os = {
      id: db.seqOS++,
      cliente,
      aparelho,
      descricao: String(corpo.descricao || '').trim(),
      valor,
      status: 'aberta',
      criadoEm: new Date().toISOString(),
      atualizadaEm: new Date().toISOString(),
    };
    db.ordens.push(os);
    salvar();
    audit(usuario, 'os-criada', { id: os.id, cliente });
    return json(res, 201, osJSON(os));
  }

  if ((m = pathname.match(/^\/api\/os\/(\d+)$/))) {
    const id = Number(m[1]);
    const os = db.ordens.find((o) => o.id === id);
    if (!os) return json(res, 404, { erro: 'Ordem de serviço não encontrada' });

    if (method === 'PUT') {
      const corpo = await lerCorpo(req);
      if (typeof corpo.cliente === 'string' && corpo.cliente.trim()) os.cliente = corpo.cliente.trim();
      if (typeof corpo.aparelho === 'string' && corpo.aparelho.trim()) os.aparelho = corpo.aparelho.trim();
      if (typeof corpo.descricao === 'string') os.descricao = corpo.descricao.trim();
      if (corpo.valor !== undefined) {
        const valor = brl(Number(corpo.valor));
        if (!Number.isFinite(valor) || valor < 0) return json(res, 400, { erro: 'Valor inválido' });
        os.valor = valor;
      }
      if (corpo.status !== undefined) {
        if (!['aberta', 'em_andamento', 'pronta', 'entregue', 'cancelada'].includes(corpo.status)) {
          return json(res, 400, { erro: 'Status inválido' });
        }
        os.status = corpo.status;
      }
      os.atualizadaEm = new Date().toISOString();
      salvar();
      audit(usuario, 'os-alterada', { id, status: os.status });
      return json(res, 200, osJSON(os));
    }

    if (method === 'DELETE') {
      if (!exigirAdmin({ usuario }, res)) return;
      db.ordens = db.ordens.filter((o) => o.id !== id);
      salvar();
      audit(usuario, 'os-excluida', { id });
      return json(res, 204, null);
    }
  }

  if (pathname === '/api/vendas' && method === 'GET') {
    const limite = Math.min(Number(url.searchParams.get('limite')) || 100, 500);
    const vendas = [...db.vendas].sort((a, b) => b.id - a.id).slice(0, limite);
    return json(res, 200, vendas.map(vendaJSON));
  }

  if (pathname === '/api/vendas' && method === 'POST') {
    const propria = caixaDe(usuario.id, false);
    if (!propria || !propria.aberto) return json(res, 400, { erro: 'Abra o seu caixa antes de vender' });
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
      custoUnit: produto.custo || 0,
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
    const temFiado = pagamentos.some((p) => p.forma === 'fiado');
    let clienteFiado = null;
    if (temFiado) {
      clienteFiado = db.clientes.find((c) => c.id === Number(corpo.clienteId));
      if (!clienteFiado) return json(res, 400, { erro: 'Venda fiado exige cliente cadastrado' });
    }
    const somaPago = brl(pagamentos.reduce((s, p) => s + p.valor, 0));
    if (somaPago < total) return json(res, 400, { erro: 'Valor pago menor que o total' });
    const troco = brl(somaPago - total);
    const dinheiroPago = brl(pagamentos.filter((p) => p.forma === 'dinheiro').reduce((s, p) => s + p.valor, 0));
    if (temFiado && troco > dinheiroPago + 0.005) {
      return json(res, 400, { erro: 'Troco não pode ser financiado com fiado' });
    }

    for (const { produto, qtd } of processados) produto.estoque = brl(produto.estoque - qtd);

    if (clienteFiado) {
      const valorFiado = brl(pagamentos.filter((p) => p.forma === 'fiado').reduce((s, p) => s + p.valor, 0));
      clienteFiado.saldo = brl(clienteFiado.saldo + valorFiado);
      clienteFiado.movimentos.push({ data: new Date().toISOString(), tipo: 'debito', valor: valorFiado, motivo: 'Venda fiado (será vinculada)' });
    }

    const venda = {
      id: db.seqVenda++,
      data: new Date().toISOString(),
      usuarioId: usuario.id,
      itens: itensVenda,
      subtotal,
      desconto,
      total,
      pagamentos,
      troco,
      operador: usuario.nome,
      cliente: clienteFiado ? clienteFiado.nome : String(corpo.cliente || '').trim(),
      clienteId: clienteFiado ? clienteFiado.id : null,
      obs: String(corpo.obs || '').trim(),
    };
    if (clienteFiado) {
      const mov = clienteFiado.movimentos[clienteFiado.movimentos.length - 1];
      mov.motivo = `Venda #${venda.id}`;
      mov.vendaId = venda.id;
    }
    db.vendas.push(venda);
    salvar();
    audit(usuario, 'venda', { id: venda.id, total, desconto });
    return json(res, 201, vendaJSON(venda));
  }

  if ((m = pathname.match(/^\/api\/vendas\/(\d+)\/cancelar$/)) && method === 'POST') {
    if (!exigirAdmin({ usuario }, res)) return;
    const venda = db.vendas.find((v) => v.id === Number(m[1]));
    if (!venda) return json(res, 404, { erro: 'Venda não encontrada' });
    if (venda.canceladaEm) return json(res, 400, { erro: 'Venda já cancelada' });
    const corpo = await lerCorpo(req);
    const valorFiado = brl(venda.pagamentos.filter((p) => p.forma === 'fiado').reduce((s, p) => s + p.valor, 0));
    if (valorFiado > 0 && venda.clienteId) {
      const cliente = db.clientes.find((c) => c.id === venda.clienteId);
      if (cliente) {
        cliente.saldo = brl(cliente.saldo - valorFiado);
        cliente.movimentos.push({ data: new Date().toISOString(), tipo: 'credito', valor: valorFiado, motivo: `Cancelamento da venda #${venda.id}` });
      }
    }
    for (const item of venda.itens) {
      const produto = db.produtos.find((p) => p.id === item.produtoId);
      if (produto) produto.estoque = brl(produto.estoque + item.qtd);
    }
    venda.canceladaEm = new Date().toISOString();
    venda.canceladaPor = usuario.nome;
    venda.motivoCancelamento = String(corpo.motivo || '').trim();
    salvar();
    audit(usuario, 'venda-cancelada', { id: venda.id, motivo: venda.motivoCancelamento, fiado: valorFiado });
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
      audit(usuario, 'operador-criado', { login: novo.login, role: novo.role });
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
      audit(usuario, 'operador-alterado', { id, login: alvo.login });
      return json(res, 200, usuarioJSON(alvo));
    }

    if (method === 'DELETE') {
      if (alvo.id === usuario.id) return json(res, 400, { erro: 'Você não pode excluir a si mesmo' });
      db.usuarios = db.usuarios.filter((u) => u.id !== id);
      for (const [tok, s] of Object.entries(db.sessoes)) {
        if (s.usuarioId === id) delete db.sessoes[tok];
      }
      salvar();
      audit(usuario, 'operador-excluido', { id, login: alvo.login });
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

server.listen(PORT, HOST, () => {
  console.log(`PDV v${VERSAO} rodando em http://localhost:${PORT}`);
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    console.log(`\nRecebido ${sinal}, encerrando...`);
    try { salvar(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
