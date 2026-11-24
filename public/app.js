'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const estado = {
  token: localStorage.getItem('pdvToken') || null,
  usuario: null,
  produtos: [],
  carrinho: new Map(),
  pagamentos: [],
  produtoEditando: null,
  operadorEditando: null,
  vendasCache: [],
  relatorio: null,
  cfg: null,
};

/* ---------- infraestrutura ---------- */

async function api(rota, opcoes = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (estado.token) headers.Authorization = `Bearer ${estado.token}`;
  const resp = await fetch(`/api/${rota}`, {
    headers,
    ...opcoes,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  if (resp.status === 204) return null;
  if (resp.status === 401 && !rota.startsWith('login') && !rota.startsWith('setup') && !rota.startsWith('saude')) {
    mostrarLogin('Sessão expirada. Entre novamente.');
    throw new Error('Não autenticado');
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.erro || `Erro ${resp.status}`);
  return dados;
}

let toastTimer;
function toast(msg, tipo = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${tipo}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto == null ? '' : texto;
  return div.innerHTML;
}

function modal(id, abrir) {
  $(`#${id}`).classList.toggle('hidden', !abrir);
}

/* ---------- login / sessão ---------- */

function mostrarLogin(mensagem = '') {
  estado.token = null;
  localStorage.removeItem('pdvToken');
  $('#app').classList.add('hidden');
  $('#telaLogin').classList.remove('hidden');
  if (mensagem) {
    $('#erroLogin').textContent = mensagem;
    $('#erroLogin').classList.remove('hidden');
  }
}

async function verificarSessao() {
  try {
    const saude = await api('saude');
    if (saude.precisaSetup) {
      $('#telaLogin').classList.remove('hidden');
      $('#formLogin').classList.add('hidden');
      $('#formSetup').classList.remove('hidden');
      $('#setupNome').focus();
      return;
    }
    if (estado.token) {
      estado.usuario = await api('me');
      await iniciarApp();
    } else {
      $('#telaLogin').classList.remove('hidden');
      $('#inputLogin').focus();
    }
  } catch (err) {
    if (err.message !== 'Não autenticado') mostrarLogin(err.message);
  }
}

async function iniciarApp() {
  $('#telaLogin').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const eAdmin = estado.usuario.role === 'admin';
  $('#lblUsuario').textContent = `${estado.usuario.nome} (${estado.usuario.role})`;
  for (const aba of ['relatorios', 'operadores', 'ajustes']) {
    $(`[data-aba="${aba}"]`).classList.toggle('hidden', !eAdmin);
  }
  if (!eAdmin && $('[data-aba="relatorios"]').classList.contains('ativa')) {
    $('[data-aba="venda"]').click();
  }
  try {
    const { configuracao } = await api('configuracao');
    estado.cfg = configuracao;
  } catch {
    estado.cfg = { loja: {}, cupom: {} };
  }
  await Promise.all([carregarCatalogo(), carregarClientes().catch(() => null)]);
  const r = await api('resumo').catch(() => null);
  if (r) atualizarStatusCaixa(r.aberto);
}

function autenticarE(rodar) {
  return async () => {
    try {
      await rodar();
    } catch (err) {
      if (err.message !== 'Não autenticado') toast(err.message, 'erro');
    }
  };
}

$('#btnLogin').addEventListener('click', async () => {
  $('#erroLogin').classList.add('hidden');
  try {
    const r = await api('login', {
      method: 'POST',
      body: { login: $('#inputLogin').value, senha: $('#inputSenha').value },
    });
    estado.token = r.token;
    localStorage.setItem('pdvToken', r.token);
    estado.usuario = r.usuario;
    await iniciarApp();
  } catch (err) {
    $('#erroLogin').textContent = err.message;
    $('#erroLogin').classList.remove('hidden');
  }
});

$('#inputSenha').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnLogin').click();
});

$('#btnSetup').addEventListener('click', async () => {
  $('#erroLogin').classList.add('hidden');
  try {
    const r = await api('setup', {
      method: 'POST',
      body: { nome: $('#setupNome').value, login: $('#setupLogin').value, senha: $('#setupSenha').value },
    });
    estado.token = r.token;
    localStorage.setItem('pdvToken', r.token);
    estado.usuario = r.usuario;
    await iniciarApp();
  } catch (err) {
    $('#erroLogin').textContent = err.message;
    $('#erroLogin').classList.remove('hidden');
  }
});

$('#btnSair').addEventListener('click', async () => {
  try { await api('logout', { method: 'POST' }); } catch {}
  mostrarLogin();
});

/* ---------- abas ---------- */

const carregadoresPorAba = {
  produtos: carregarAbaProdutos,
  clientes: carregarClientes,
  historico: carregarHistorico,
  relatorios: carregarRelatorio,
  operadores: carregarOperadores,
  resumo: carregarResumo,
  ajustes: carregarAjustes,
};

$('#navAbas').addEventListener('click', (e) => {
  const botao = e.target.closest('.aba');
  if (!botao) return;
  $$('.aba').forEach((b) => b.classList.remove('ativa'));
  $$('.painel').forEach((p) => p.classList.remove('ativo'));
  botao.classList.add('ativa');
  $(`#aba-${botao.dataset.aba}`).classList.add('ativo');
  (carregadoresPorAba[botao.dataset.aba] || carregarCatalogo)();
});

/* ---------- catálogo ---------- */

async function carregarProdutos() {
  estado.produtos = await api('produtos');
  return estado.produtos;
}

async function carregarCatalogo() {
  await carregarProdutos();
  renderCatalogo($('#inputBusca') ? $('#inputBusca').value : '');
  renderCarrinho();
}

async function carregarAbaProdutos() {
  await carregarProdutos();
  renderProdutos($('#filtroProdutos').value);
}

function renderCatalogo(filtro = '') {
  const termo = filtro.trim().toLowerCase();
  const lista = termo
    ? estado.produtos.filter((p) => p.nome.toLowerCase().includes(termo) || p.codigo.toLowerCase().includes(termo))
    : estado.produtos;
  $('#catalogo').innerHTML = lista
    .map((p) => {
      const semEstoque = p.estoque <= 0;
      return `
        <div class="card-produto ${semEstoque ? 'sem-estoque' : ''}" data-id="${p.id}">
          <div class="nome">${escapar(p.nome)}</div>
          <div class="preco">${brl(p.preco)}</div>
          <div class="estoque">${escapar(p.codigo)} · estoque: ${p.estoque} ${escapar(p.unidade)}</div>
        </div>`;
    })
    .join('');
  $('#catalogo').querySelectorAll('.card-produto').forEach((card) => {
    card.addEventListener('click', () => {
      if (card.classList.contains('sem-estoque')) return;
      adicionarAoCarrinho(Number(card.dataset.id), 1);
    });
  });
}

async function buscaRapida() {
  const termo = $('#inputBusca').value.trim();
  if (!termo) return;
  if (/^2\d{12}$/.test(termo)) {
    const codigoInterno = termo.slice(1, 6);
    const gramas = Number(termo.slice(6, 11));
    const produto = estado.produtos.find((p) => p.codigo === codigoInterno);
    if (!produto) return toast(`Produto de balança ${codigoInterno} não cadastrado`, 'erro');
    if (produto.estoque < gramas / 1000) return toast(`Estoque insuficiente de "${produto.nome}"`, 'erro');
    adicionarQtd(produto.id, gramas / 1000);
    $('#inputBusca').value = '';
    renderCatalogo('');
    toast(`⚖ ${gramas}g de ${produto.nome}`, 'ok');
    return;
  }
  const resultados = await api(`produtos/busca?q=${encodeURIComponent(termo)}`);
  if (resultados.length === 1) {
    if (resultados[0].estoque <= 0) return toast(`"${resultados[0].nome}" sem estoque`, 'erro');
    adicionarAoCarrinho(resultados[0].id, 1);
    $('#inputBusca').value = '';
    renderCatalogo('');
    return;
  }
  renderCatalogo(termo);
  toast(resultados.length ? `${resultados.length} produto(s) no catálogo` : 'Produto não encontrado', resultados.length ? '' : 'erro');
}

$('#inputBusca').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') buscaRapida();
});
$('#inputBusca').addEventListener('input', (e) => renderCatalogo(e.target.value));

/* ---------- carrinho ---------- */

function adicionarAoCarrinho(id, delta) {
  const produto = estado.produtos.find((p) => p.id === id);
  if (!produto) return;
  qtdArredondada(id, produto, delta);
  renderCarrinho();
}

function adicionarQtd(id, qtd) {
  const produto = estado.produtos.find((p) => p.id === id);
  if (!produto) return;
  qtdArredondada(id, produto, qtd - (estado.carrinho.get(id) || 0));
  renderCarrinho();
}

function qtdArredondada(id, produto, delta) {
  const atual = estado.carrinho.get(id) || 0;
  const novaQtd = Math.round((atual + delta) * 1000) / 1000;
  if (novaQtd <= 0) {
    estado.carrinho.delete(id);
  } else if (novaQtd > produto.estoque) {
    toast(`Estoque insuficiente (${produto.estoque} ${produto.unidade})`, 'erro');
  } else {
    estado.carrinho.set(id, novaQtd);
  }
}

function subtotalCarrinho() {
  let subtotal = 0;
  for (const [id, qtd] of estado.carrinho) {
    subtotal += qtd * estado.produtos.find((x) => x.id === id).preco;
  }
  return Math.round(subtotal * 100) / 100;
}

function totalComDesconto() {
  const desconto = Math.max(0, Number($('#inputDesconto').value) || 0);
  return Math.max(0, Math.round((subtotalCarrinho() - desconto) * 100) / 100);
}

function renderCarrinho() {
  const corpo = $('#corCarrinho');
  if (!estado.carrinho.size) {
    corpo.innerHTML = '<tr><td colspan="5" style="color:#94a3b8;padding:30px;text-align:center">Carrinho vazio — clique em um produto</td></tr>';
  } else {
    corpo.innerHTML = [...estado.carrinho.entries()]
      .map(([id, qtd]) => {
        const p = estado.produtos.find((x) => x.id === id);
        return `
          <tr>
            <td>${escapar(p.nome)}</td>
            <td><div class="qtd-ctrl"><button data-acao="menos" data-id="${id}">−</button> ${qtd} <button data-acao="mais" data-id="${id}">+</button></div></td>
            <td>${brl(p.preco)}</td>
            <td><strong>${brl(qtd * p.preco)}</strong></td>
            <td><span class="remover" data-id="${id}">✕</span></td>
          </tr>`;
      })
      .join('');
    corpo.querySelectorAll('[data-acao]').forEach((b) =>
      b.addEventListener('click', () => adicionarAoCarrinho(Number(b.dataset.id), b.dataset.acao === 'mais' ? 1 : -1))
    );
    corpo.querySelectorAll('.remover').forEach((b) =>
      b.addEventListener('click', () => {
        estado.carrinho.delete(Number(b.dataset.id));
        renderCarrinho();
      })
    );
  }
  $('#lblSubtotal').textContent = brl(subtotalCarrinho());
  $('#lblTotal').textContent = brl(totalComDesconto());
  $('#btnPagar').disabled = !estado.carrinho.size;
}

$('#inputDesconto').addEventListener('input', renderCarrinho);

$('#btnCancelar').addEventListener('click', () => {
  if (estado.carrinho.size && !confirm('Cancelar a venda atual?')) return;
  estado.carrinho.clear();
  $('#inputDesconto').value = 0;
  $('#selCliente').value = '';
  renderCarrinho();
});

/* ---------- pagamento ---------- */

function abrirModalPagamento() {
  if (!estado.carrinho.size) return;
  estado.pagamentos = [];
  $('#totalModal').textContent = brl(totalComDesconto());
  $('#inputValorPago').value = '';
  renderPagamentos();
  modal('modalPagamento', true);
  $('#selForma').focus();
}

function renderPagamentos() {
  const total = totalComDesconto();
  const pago = Math.round(estado.pagamentos.reduce((s, p) => s + p.valor, 0) * 100) / 100;
  const falta = Math.round((total - pago) * 100) / 100;
  $('#lblPago').textContent = brl(pago);
  $('#lblFalta').textContent = falta >= 0 ? brl(falta) : `Troco: ${brl(-falta)}`;
  $('#lblFalta').style.color = falta >= 0 ? '' : 'var(--verde)';
  $('#listaPagamentos').innerHTML = estado.pagamentos
    .map((p, i) => `<li><span>${p.forma}</span><span>${brl(p.valor)} <span class="remover" data-i="${i}">✕</span></span></li>`)
    .join('');
  $('#listaPagamentos').querySelectorAll('.remover').forEach((b) =>
    b.addEventListener('click', () => {
      estado.pagamentos.splice(Number(b.dataset.i), 1);
      renderPagamentos();
    })
  );
  $('#btnConfirmarVenda').disabled = falta > 0 || !estado.pagamentos.length;
  $('#btnConfirmarVenda').textContent = falta < 0 ? `Confirmar (troco ${brl(-falta)})` : 'Confirmar venda';
}

$('#btnAddPagamento').addEventListener('click', () => {
  const valor = Number($('#inputValorPago').value);
  if (!Number.isFinite(valor) || valor <= 0) return toast('Informe um valor válido', 'erro');
  const total = totalComDesconto();
  const pago = estado.pagamentos.reduce((s, p) => s + p.valor, 0);
  const forma = $('#selForma').value;
  if (pago + valor > total + 0.001 && forma !== 'dinheiro') {
    return toast(forma === 'fiado' ? 'Fiado não gera troco' : 'Troco só é permitido em dinheiro', 'erro');
  }
  estado.pagamentos.push({ forma, valor });
  $('#inputValorPago').value = '';
  renderPagamentos();
  $('#inputValorPago').focus();
});

$('#btnFecharModal').addEventListener('click', () => modal('modalPagamento', false));
$('#btnPagar').addEventListener('click', abrirModalPagamento);

$('#btnConfirmarVenda').addEventListener('click', async () => {
  try {
    const venda = await api('vendas', {
      method: 'POST',
      body: {
        itens: [...estado.carrinho.entries()].map(([produtoId, qtd]) => ({
          produtoId,
          qtd,
          precoUnit: estado.produtos.find((p) => p.id === produtoId).preco,
        })),
        desconto: Number($('#inputDesconto').value) || 0,
        pagamentos: estado.pagamentos,
        clienteId: $('#selCliente').value ? Number($('#selCliente').value) : undefined,
      },
    });
    modal('modalPagamento', false);
    estado.carrinho.clear();
    $('#inputDesconto').value = 0;
    $('#selCliente').value = '';
    await carregarCatalogo();
    imprimirCupom(venda);
    toast(`Venda #${venda.id} concluída!`, 'ok');
  } catch (err) {
    toast(err.message, 'erro');
  }
});

/* ---------- cupom ---------- */

function cupomHTML(venda) {
  const loja = estado.cfg?.loja || {};
  const cabecalho = `
    <div style="text-align:center">
      ${loja.nome ? `<strong>${escapar(loja.nome)}</strong><br>` : ''}
      ${loja.cnpj ? `${escapar(loja.cnpj)}<br>` : ''}
      ${loja.endereco ? `${escapar(loja.endereco)}<br>` : ''}
      ${loja.telefone ? `${escapar(loja.telefone)}<br>` : ''}
      <strong>CUPOM NÃO FISCAL</strong>
    </div>`;
  if (venda.canceladaEm) {
    return `
      ${cabecalho}
      <hr>
      Venda #${venda.id} — ${new Date(venda.data).toLocaleString('pt-BR')}
      <hr>
      <div style="text-align:center;font-weight:700;font-size:16px;margin:8px 0">*** CANCELADA ***</div>
      <div style="text-align:center">Por ${escapar(venda.canceladaPor)} em<br>${new Date(venda.canceladaEm).toLocaleString('pt-BR')}</div>
      ${venda.motivoCancelamento ? `<div style="text-align:center">Motivo: ${escapar(venda.motivoCancelamento)}</div>` : ''}`;
  }
  const linhas = venda.itens
    .map((i) =>
      `${escapar(i.nome)}\n` +
      `${i.qtd} ${i.unidade} x ${brl(i.precoUnit)}` +
      brl(i.total).padStart(10)
    )
    .join('\n');
  const pagamentos = venda.pagamentos.map((p) => `${p.forma.toUpperCase()}${'.'.repeat(14)}${brl(p.valor)}`).join('\n');
  return `
    ${cabecalho}
    <hr>
    Venda #${venda.id} — ${new Date(venda.data).toLocaleString('pt-BR')}<br>
    Operador: ${escapar(venda.operador)}
    ${venda.cliente ? `<br>Cliente: ${escapar(venda.cliente)}` : ''}
    <hr>
    <pre style="font-family:inherit;white-space:pre-wrap">${linhas}</pre>
    <hr>
    <pre style="font-family:inherit">
Subtotal${'.'.repeat(21)}${brl(venda.subtotal).padStart(9)}
Desconto${'.'.repeat(22)}${brl(venda.desconto).padStart(9)}
TOTAL${'.'.repeat(25)}${brl(venda.total).padStart(9)}
${pagamentos}
Troco${'.'.repeat(25)}${brl(venda.troco).padStart(9)}
    </pre>
    <hr>
    <div style="text-align:center">${escapar(estado.cfg?.cupom?.mensagem || 'Obrigado pela preferência!')}</div>`;
}

function imprimirCupom(venda) {
  $('#cupom .cupom-conteudo').innerHTML = cupomHTML(venda);
  setTimeout(() => window.print(), 150);
}

/* ---------- produtos (CRUD) ---------- */

async function renderProdutos(filtro = '') {
  if (!estado.produtos.length) await carregarProdutos();
  const termo = filtro.trim().toLowerCase();
  const lista = estado.produtos.filter(
    (p) => !termo || p.nome.toLowerCase().includes(termo) || p.codigo.toLowerCase().includes(termo)
  );
  $('#corProdutos').innerHTML = lista
    .map(
      (p) => `
      <tr>
        <td>${escapar(p.codigo)}</td>
        <td>${escapar(p.nome)}</td>
        <td>${escapar(p.unidade)}</td>
        <td>${brl(p.preco)}</td>
        <td>${brl(p.custo || 0)}</td>
        <td class="${p.estoque <= 3 ? 'estoque-baixo' : ''}">${p.estoque}</td>
        <td>
          ${estado.usuario.role === 'admin' ? `<button class="btn secundario mini" data-entrada="${p.id}">＋ Estq</button>` : ''}
          <button class="btn secundario mini" data-editar="${p.id}">Editar</button>
        </td>
      </tr>`
    )
    .join('');
  $('#corProdutos').querySelectorAll('[data-editar]').forEach((b) =>
    b.addEventListener('click', () => abrirModalProduto(Number(b.dataset.editar)))
  );
  $('#corProdutos').querySelectorAll('[data-entrada]').forEach((b) =>
    b.addEventListener('click', () => abrirModalEntrada(Number(b.dataset.entrada)))
  );
}

function abrirModalEntrada(id) {
  const produto = estado.produtos.find((p) => p.id === id);
  if (!produto) return;
  estado.produtoEntrada = id;
  $('#formEntrada').reset();
  $('#tituloEntrada').textContent = `Entrada de estoque — ${produto.nome} (atual: ${produto.estoque})`;
  modal('modalEntrada', true);
  $('#formEntrada').qtd.focus();
}

$('#btnCancelarEntrada').addEventListener('click', () => modal('modalEntrada', false));

$('#formEntrada').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const p = await api(`produtos/${estado.produtoEntrada}/entrada`, {
      method: 'POST',
      body: { qtd: Number(e.target.qtd.value) },
    });
    modal('modalEntrada', false);
    toast(`Estoque de "${p.nome}" agora: ${p.estoque}`, 'ok');
    await carregarProdutos();
    renderProdutos($('#filtroProdutos').value);
  } catch (err) {
    toast(err.message, 'erro');
  }
});

$('#btnImportar').addEventListener('click', () => {
  $('#csvTexto').value = '';
  modal('modalImportar', true);
});

$('#btnCancelarImportar').addEventListener('click', () => modal('modalImportar', false));

$('#btnConfirmarImportar').addEventListener('click', async () => {
  try {
    const resultado = await api('produtos/importar', {
      method: 'POST',
      body: { csv: $('#csvTexto').value },
    });
    modal('modalImportar', false);
    toast(`${resultado.criados} criado(s), ${resultado.atualizados} atualizado(s)` +
      (resultado.erros.length ? `, ${resultado.erros.length} erro(s)` : ''),
      resultado.erros.length ? 'erro' : 'ok');
    if (resultado.erros.length) console.warn('Erros de importação:', resultado.erros);
    await carregarProdutos();
    renderProdutos($('#filtroProdutos').value);
  } catch (err) {
    toast(err.message, 'erro');
  }
});

$('#filtroProdutos').addEventListener('input', (e) => renderProdutos(e.target.value));

function abrirModalProduto(id = null) {
  estado.produtoEditando = id;
  const form = $('#formProduto');
  form.reset();
  $('#tituloProduto').textContent = id ? 'Editar produto' : 'Novo produto';
  if (id) {
    const p = estado.produtos.find((x) => x.id === id);
    form.codigo.value = p.codigo;
    form.nome.value = p.nome;
    form.unidade.value = p.unidade;
    form.preco.value = p.preco;
    form.custo.value = p.custo ?? 0;
    form.estoque.value = p.estoque;
  }
  modal('modalProduto', true);
  form.codigo.focus();
}

$('#btnNovoProduto').addEventListener('click', () => abrirModalProduto());
$('#btnCancelarProduto').addEventListener('click', () => modal('modalProduto', false));

$('#formProduto').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const corpo = {
    codigo: form.codigo.value,
    nome: form.nome.value,
    unidade: form.unidade.value,
    preco: Number(form.preco.value),
    custo: Number(form.custo.value) || 0,
    estoque: Number(form.estoque.value) || 0,
  };
  try {
    if (estado.produtoEditando) {
      await api(`produtos/${estado.produtoEditando}`, { method: 'PUT', body: corpo });
      toast('Produto atualizado', 'ok');
    } else {
      await api('produtos', { method: 'POST', body: corpo });
      toast('Produto cadastrado', 'ok');
    }
    modal('modalProduto', false);
    await carregarProdutos();
    renderProdutos($('#filtroProdutos').value);
    renderCatalogo($('#inputBusca').value);
  } catch (err) {
    toast(err.message, 'erro');
  }
});

function graficoDias(porDia) {
  const max = Math.max(...porDia.map((d) => d.total), 1);
  const largura = 100;
  const altura = 28;
  const passo = porDia.length > 1 ? largura / porDia.length : largura;
  const barras = porDia.map((d, i) => {
    const h = Math.max(1, (d.total / max) * (altura - 5));
    const x = (i * passo + passo * 0.15).toFixed(2);
    const w = (passo * 0.7).toFixed(2);
    const y = (altura - h).toFixed(2);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h.toFixed(2)}" rx="0.6" fill="var(--primario)"></rect>` +
      `<title>${new Date(d.dia + 'T12:00').toLocaleDateString('pt-BR')}: ${brl(d.total)}</title>`;
  }).join('');
  return `<svg viewBox="0 0 ${ largura } ${ altura }" preserveAspectRatio="none" style="width:100%;height:130px;background:#fff;border:1px solid var(--borda);border-radius:10px">${barras}</svg>`;
}

/* ---------- clientes / fiado ---------- */

let clientesCache = [];

async function carregarClientes() {
  clientesCache = await api('clientes');
  renderClientes($('#filtroClientes').value);
  atualizarSelectClientes();
  return clientesCache;
}

function atualizarSelectClientes(selecionado) {
  const sel = $('#selCliente');
  const atual = selecionado || sel.value;
  sel.innerHTML = '<option value="">— sem cliente —</option>' +
    clientesCache.map((c) => `<option value="${c.id}">${escapar(c.nome)}${c.saldo > 0 ? ` (deve ${brl(c.saldo)})` : ''}</option>`).join('');
  if (atual) sel.value = atual;
}

function renderClientes(filtro = '') {
  const termo = filtro.trim().toLowerCase();
  const lista = clientesCache.filter((c) => !termo || c.nome.toLowerCase().includes(termo) || (c.telefone || '').includes(termo));
  const totalFiado = clientesCache.reduce((s, c) => s + c.saldo, 0);
  $('#corClientes').innerHTML =
    `<tr style="background:#fffbeb"><td colspan="4"><strong>Fiado a receber: ${brl(totalFiado)}</strong> em ${clientesCache.filter((c) => c.saldo > 0).length} cliente(s)</td></tr>` +
    (lista.map((c) => `
      <tr class="${c.saldo > 0 ? '' : 'inativo'}">
        <td>${escapar(c.nome)}</td>
        <td>${escapar(c.telefone)}</td>
        <td class="${c.saldo > 0 ? 'estoque-baixo' : ''}">${brl(c.saldo)}</td>
        <td>
          <button class="btn primario mini" data-receber="${c.id}" ${c.saldo <= 0 ? 'disabled' : ''}>💵 Receber</button>
          <button class="btn secundario mini" data-extrato="${c.id}">Extrato</button>
          <button class="btn secundario mini" data-edit-c="${c.id}">Editar</button>
          ${estado.usuario.role === 'admin' ? `<button class="btn perigo mini" data-del-c="${c.id}">✕</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:#94a3b8">Nenhum cliente cadastrado</td></tr>');
  $('#corClientes').querySelectorAll('[data-receber]').forEach((b) =>
    b.addEventListener('click', () => abrirReceber(Number(b.dataset.receber)))
  );
  $('#corClientes').querySelectorAll('[data-extrato]').forEach((b) =>
    b.addEventListener('click', () => abrirExtrato(Number(b.dataset.extrato)))
  );
  $('#corClientes').querySelectorAll('[data-edit-c]').forEach((b) =>
    b.addEventListener('click', () => abrirModalCliente(Number(b.dataset.editC)))
  );
  $('#corClientes').querySelectorAll('[data-del-c]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Excluir este cliente?')) return;
      try {
        await api(`clientes/${b.dataset.delC}`, { method: 'DELETE' });
        toast('Cliente excluído', 'ok');
        carregarClientes();
      } catch (err) {
        toast(err.message, 'erro');
      }
    })
  );
}

$('#filtroClientes').addEventListener('input', (e) => renderClientes(e.target.value));

function abrirModalCliente(id = null) {
  estado.clienteEditando = id;
  const form = $('#formCliente');
  form.reset();
  $('#tituloCliente').textContent = id ? 'Editar cliente' : 'Novo cliente';
  if (id) {
    const c = clientesCache.find((x) => x.id === id);
    if (!c) return;
    form.nome.value = c.nome;
    form.telefone.value = c.telefone;
    form.obs.value = c.obs;
  }
  modal('modalCliente', true);
  form.nome.focus();
}

$('#btnNovoCliente').addEventListener('click', () => abrirModalCliente());
$('#btnCancelarCliente').addEventListener('click', () => modal('modalCliente', false));

$('#formCliente').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const corpo = { nome: form.nome.value, telefone: form.telefone.value, obs: form.obs.value };
  try {
    if (estado.clienteEditando) {
      await api(`clientes/${estado.clienteEditando}`, { method: 'PUT', body: corpo });
      toast('Cliente atualizado', 'ok');
    } else {
      await api('clientes', { method: 'POST', body: corpo });
      toast('Cliente cadastrado', 'ok');
    }
    modal('modalCliente', false);
    carregarClientes();
  } catch (err) {
    toast(err.message, 'erro');
  }
});

function abrirReceber(id) {
  const c = clientesCache.find((x) => x.id === id);
  if (!c) return;
  estado.clienteRecebendo = id;
  $('#formReceber').reset();
  $('#recInfo').innerHTML = `<strong>${escapar(c.nome)}</strong> deve <strong>${brl(c.saldo)}</strong>`;
  $('#formReceber').valor.max = c.saldo;
  modal('modalReceber', true);
  $('#formReceber').valor.focus();
}

$('#btnCancelarReceber').addEventListener('click', () => modal('modalReceber', false));

$('#formReceber').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const c = await api(`clientes/${estado.clienteRecebendo}/receber`, {
      method: 'POST',
      body: { valor: Number(e.target.valor.value), forma: e.target.forma.value },
    });
    modal('modalReceber', false);
    toast(`Recebido! Saldo de ${c.nome}: ${brl(c.saldo)}`, 'ok');
    carregarClientes();
  } catch (err) {
    toast(err.message, 'erro');
  }
});

async function abrirExtrato(id) {
  try {
    const c = await api(`clientes/${id}`);
    $('#tituloExtrato').textContent = `Extrato — ${c.nome}`;
    $('#conteudoExtrato').innerHTML = `
      <p style="margin-bottom:8px">Saldo atual: <strong>${brl(c.saldo)}</strong></p>
      ${c.movimentos.length ? `<table class="trep" style="max-height:260px;overflow-y:auto;border:1px solid var(--borda)">
        <thead><tr><th>Data</th><th>Tipo</th><th>Valor</th><th>Motivo</th></tr></thead><tbody>
        ${c.movimentos.map((m) => `
          <tr><td>${new Date(m.data).toLocaleString('pt-BR')}</td>
          <td class="${m.tipo === 'debito' ? 'estoque-baixo' : ''}">${m.tipo === 'debito' ? 'Fiado' : 'Recebido'}</td>
          <td>${brl(m.valor)}</td><td style="font-size:.8rem">${escapar(m.motivo)}</td></tr>`).join('')}
        </tbody></table>` : '<p style="color:#94a3b8">Sem movimentações</p>'}`;
    modal('modalExtrato', true);
  } catch (err) {
    toast(err.message, 'erro');
  }
}

$('#btnFecharExtrato').addEventListener('click', () => modal('modalExtrato', false));

/* ---------- histórico ---------- */

async function carregarHistorico() {
  const vendas = await api('vendas?limite=200');
  estado.vendasCache = vendas;
  $('#corHistorico').innerHTML = vendas.length
    ? vendas
        .map((v) => {
          const cancelada = !!v.canceladaEm;
          return `
          <tr class="${cancelada ? 'inativo' : ''}">
            <td>#${v.id}${cancelada ? ' <span class="badge-cancelada">CANCELADA</span>' : ''}</td>
            <td>${new Date(v.data).toLocaleString('pt-BR')}</td>
            <td>${v.itens.reduce((s, i) => s + i.qtd, 0)} item(ns)</td>
            <td><strong>${brl(v.total)}</strong></td>
            <td>${v.pagamentos.map((p) => `${p.forma}: ${brl(p.valor)}`).join(', ')}</td>
            <td>${escapar(v.operador)}</td>
            <td>
              <button class="btn secundario mini" data-imprimir="${v.id}">🖨</button>
              ${!cancelada && estado.usuario.role === 'admin' ? `<button class="btn perigo mini" data-cancelar="${v.id}">✕</button>` : ''}
            </td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="7" style="text-align:center;color:#94a3b8">Nenhuma venda registrada</td></tr>';
  $('#corHistorico').querySelectorAll('[data-imprimir]').forEach((b) =>
    b.addEventListener('click', () => {
      const venda = estado.vendasCache.find((v) => v.id === Number(b.dataset.imprimir));
      imprimirCupom(venda);
    })
  );
  $('#corHistorico').querySelectorAll('[data-cancelar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const motivo = prompt('Motivo do cancelamento (estorna o estoque):');
      if (motivo === null) return;
      try {
        await api(`vendas/${b.dataset.cancelar}/cancelar`, { method: 'POST', body: { motivo } });
        toast('Venda cancelada e estoque estornado', 'ok');
        carregarHistorico();
      } catch (err) {
        toast(err.message, 'erro');
      }
    })
  );
}

/* ---------- relatórios ---------- */

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function carregarRelatorio() {
  if (!$('#repDe').value) $('#repDe').value = hojeISO();
  if (!$('#repAte').value) $('#repAte').value = hojeISO();
  return atualizarRelatorio();
}

async function atualizarRelatorio() {
  try {
    const r = await api(`relatorios?de=${$('#repDe').value}&ate=${$('#repAte').value}`);
    estado.relatorio = r;
    let fiadoTotal = 0;
    try {
      fiadoTotal = (await api('clientes')).reduce((s, c) => s + c.saldo, 0);
    } catch {}
    $('#repConteudo').innerHTML = `
      <div class="cards">
        <div class="card-resumo"><div class="rotulo">Faturamento</div><div class="valor">${brl(r.faturamento)}</div></div>
        ${estado.usuario.role === 'admin' ? `<div class="card-resumo"><div class="rotulo">Lucro estimado</div><div class="valor">${brl(r.lucroEstimado || 0)}</div></div>` : ''}
        <div class="card-resumo"><div class="rotulo">Vendas</div><div class="valor">${r.numVendas}</div></div>
        <div class="card-resumo"><div class="rotulo">Ticket médio</div><div class="valor">${brl(r.ticketMedio)}</div></div>
        <div class="card-resumo"><div class="rotulo">Descontos</div><div class="valor">${brl(r.descontos)}</div></div>
        ${r.numCanceladas ? `<div class="card-resumo negativo"><div class="rotulo">Canceladas</div><div class="valor">${r.numCanceladas}</div></div>` : ''}
        ${fiadoTotal > 0 ? `<div class="card-resumo negativo"><div class="rotulo">Fiado a receber</div><div class="valor">${brl(fiadoTotal)}</div></div>` : ''}
        ${Object.entries(r.porForma)
          .map(([forma, valor]) => `<div class="card-resumo"><div class="rotulo">${forma}</div><div class="valor">${brl(valor)}</div></div>`)
          .join('')}
      </div>
      ${r.porDia.length > 1 ? `
      <div class="rep-secao">
        <h3>Faturamento por dia (gráfico)</h3>
        ${graficoDias(r.porDia)}
      </div>` : ''}
      <div class="rep-secao">
        <h3>Faturamento por dia</h3>
        <table class="trep"><thead><tr><th>Data</th><th>Vendas</th><th>Total</th>${estado.usuario.role === 'admin' ? '<th>Lucro est.</th>' : ''}</tr></thead><tbody>
          ${r.porDia.map((d) => `<tr><td>${new Date(d.dia + 'T12:00').toLocaleDateString('pt-BR')}</td><td>${d.vendas}</td><td class="num">${brl(d.total)}</td>${estado.usuario.role === 'admin' ? `<td class="num">${brl(d.lucro || 0)}</td>` : ''}</tr>`).join('') || '<tr><td colspan="4" style="color:#94a3b8">Sem vendas no período</td></tr>'}
        </tbody></table>
      </div>
      <div class="rep-secao">
        <h3>Produtos mais vendidos</h3>
        <table class="trep"><thead><tr><th>#</th><th>Produto</th><th>Qtd</th><th>Total</th></tr></thead><tbody>
          ${r.topProdutos.map((p, i) => `<tr><td>${i + 1}</td><td>${escapar(p.nome)}</td><td>${p.qtd}</td><td class="num">${brl(p.total)}</td></tr>`).join('') || '<tr><td colspan="4" style="color:#94a3b8">Sem dados</td></tr>'}
        </tbody></table>
      </div>
      ${r.ultimosFechamentos.length ? `
      <div class="rep-secao">
        <h3>Últimos fechamentos de caixa</h3>
        <table class="trep"><thead><tr><th>Fechado em</th><th>Vendas</th><th>Faturamento</th><th>Dinheiro esperado</th><th>Contado</th><th>Diferença</th><th>Por</th></tr></thead><tbody>
          ${r.ultimosFechamentos.map((f) => `
            <tr><td>${new Date(f.fechadoEm).toLocaleString('pt-BR')}</td><td>${f.numVendas}</td><td class="num">${brl(f.faturamento)}</td>
            <td class="num">${brl(f.dinheiroEsperado)}</td><td class="num">${f.dinheiroContado === null ? '—' : brl(f.dinheiroContado)}</td>
            <td class="num">${f.diferenca === null ? '—' : brl(f.diferenca)}</td><td>${escapar(f.fechadoPor)}</td></tr>`).join('')}
        </tbody></table>
      </div>` : ''}`;
  } catch (err) {
    toast(err.message, 'erro');
  }
}

$('#btnRepAtualizar').addEventListener('click', atualizarRelatorio);

$('#btnRepCSV').addEventListener('click', async () => {
  try {
    const { csv } = await api(`relatorios/csv?de=${$('#repDe').value}&ate=${$('#repAte').value}`);
    baixarArquivo(csv, `vendas-${$('#repDe').value}_a_${$('#repAte').value}.csv`, 'text/csv;charset=utf-8');
  } catch (err) {
    toast(err.message, 'erro');
  }
});

$('#btnRepImprimir').addEventListener('click', () => {
  if (!estado.relatorio) return;
  const r = estado.relatorio;
  $('#relImpressao').innerHTML = `
    <h1>${escapar(estado.cfg?.loja?.nome || 'PDV Express')} — Relatório de vendas</h1>
    <p>Período: ${$('#repDe').value} a ${$('#repAte').value} · Emitido em ${new Date().toLocaleString('pt-BR')} por ${escapar(estado.usuario.nome)}</p>
    <table><tbody>
      <tr><th>Vendas</th><td>${r.numVendas}</td><th>Canceladas</th><td>${r.numCanceladas}</td></tr>
      <tr><th>Faturamento</th><td>${brl(r.faturamento)}</td><th>Ticket médio</th><td>${brl(r.ticketMedio)}</td></tr>
      ${Object.entries(r.porForma).map(([f, v]) => `<tr><th>${f}</th><td>${brl(v)}</td><td colspan="2"></td></tr>`).join('')}
    </tbody></table>
    <table><thead><tr><th>Data</th><th>Vendas</th><th>Total</th>${estado.usuario.role === 'admin' ? '<th>Lucro est.</th>' : ''}</tr></thead><tbody>
      ${r.porDia.map((d) => `<tr><td>${new Date(d.dia + 'T12:00').toLocaleDateString('pt-BR')}</td><td>${d.vendas}</td><td>${brl(d.total)}</td>${estado.usuario.role === 'admin' ? `<td>${brl(d.lucro || 0)}</td>` : ''}</tr>`).join('')}
    </tbody></table>
    <table><thead><tr><th>Produto</th><th>Qtd</th><th>Total</th></tr></thead><tbody>
      ${r.topProdutos.map((p) => `<tr><td>${escapar(p.nome)}</td><td>${p.qtd}</td><td>${brl(p.total)}</td></tr>`).join('')}
    </tbody></table>`;
  setTimeout(() => window.print(), 150);
});

/* ---------- operadores ---------- */

async function carregarOperadores() {
  const usuarios = await api('operadores');
  $('#corOperadores').innerHTML = usuarios
    .map(
      (u) => `
      <tr class="${u.ativo ? '' : 'inativo'}">
        <td>${escapar(u.nome)}</td>
        <td>${escapar(u.login)}</td>
        <td>${u.role === 'admin' ? 'Administrador' : 'Operador'}</td>
        <td>${u.ativo ? 'Ativo' : 'Inativo'}</td>
        <td>
          <button class="btn secundario mini" data-edit-op="${u.id}">Editar</button>
          ${u.id !== estado.usuario.id ? `
            <button class="btn secundario mini" data-toggle-op="${u.id}" data-ativo="${u.ativo}">${u.ativo ? 'Desativar' : 'Ativar'}</button>
            <button class="btn perigo mini" data-del-op="${u.id}">Excluir</button>` : ''}
        </td>
      </tr>`
    )
    .join('');
  $('#corOperadores').querySelectorAll('[data-edit-op]').forEach((b) =>
    b.addEventListener('click', () => abrirModalOperador(Number(b.dataset.editOp)))
  );
  $('#corOperadores').querySelectorAll('[data-toggle-op]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`operadores/${b.dataset.toggleOp}`, { method: 'PUT', body: { ativo: b.dataset.ativo !== 'true' } });
        carregarOperadores();
      } catch (err) {
        toast(err.message, 'erro');
      }
    })
  );
  $('#corOperadores').querySelectorAll('[data-del-op]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Excluir este operador? As vendas anteriores continuam no histórico.')) return;
      try {
        await api(`operadores/${b.dataset.delOp}`, { method: 'DELETE' });
        toast('Operador excluído', 'ok');
        carregarOperadores();
      } catch (err) {
        toast(err.message, 'erro');
      }
    })
  );
}

function abrirModalOperador(id = null) {
  estado.operadorEditando = id;
  const form = $('#formOperador');
  form.reset();
  $('#tituloOperador').textContent = id ? 'Editar operador' : 'Novo operador';
  form.senha.required = !id;
  form.senha.placeholder = id ? 'Deixe vazio para manter a senha atual' : '';
  if (id) {
    api('operadores').then((usuarios) => {
      const op = usuarios.find((x) => x.id === id);
      if (!op) return;
      form.nome.value = op.nome;
      form.login.value = op.login;
      form.role.value = op.role;
    });
  }
  modal('modalOperador', true);
  form.nome.focus();
}

$('#btnNovoOperador').addEventListener('click', () => abrirModalOperador());
$('#btnCancelarOperador').addEventListener('click', () => modal('modalOperador', false));

$('#formOperador').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    if (estado.operadorEditando) {
      const corpo = { nome: form.nome.value, login: form.login.value, role: form.role.value };
      if (form.senha.value) corpo.senha = form.senha.value;
      await api(`operadores/${estado.operadorEditando}`, { method: 'PUT', body: corpo });
      toast('Operador atualizado', 'ok');
    } else {
      await api('operadores', {
        method: 'POST',
        body: { nome: form.nome.value, login: form.login.value, senha: form.senha.value, role: form.role.value },
      });
      toast('Operador criado', 'ok');
    }
    modal('modalOperador', false);
    carregarOperadores();
  } catch (err) {
    toast(err.message, 'erro');
  }
});

/* ---------- caixa ---------- */

function atualizarStatusCaixa(aberto) {
  const el = $('#statusCaixa');
  el.textContent = aberto ? 'Caixa aberto' : 'Caixa fechado';
  el.className = `status-caixa ${aberto ? 'aberto' : 'fechado'}`;
}

async function carregarResumo() {
  const r = await api('resumo');
  atualizarStatusCaixa(r.aberto);
  $('#cardsResumo').innerHTML = `
    <div class="card-resumo"><div class="rotulo">Vendas hoje</div><div class="valor">${r.vendas}</div></div>
    <div class="card-resumo"><div class="rotulo">Faturamento hoje</div><div class="valor">${brl(r.faturamento)}</div></div>
    ${r.aberto ? `<div class="card-resumo"><div class="rotulo">Dinheiro no caixa</div><div class="valor">${brl(r.dinheiroEsperado)}</div></div>` : ''}
    ${r.canceladasHoje ? `<div class="card-resumo negativo"><div class="rotulo">Canceladas hoje</div><div class="valor">${r.canceladasHoje}</div></div>` : ''}
    ${Object.entries(r.porForma)
      .map(([forma, valor]) => `<div class="card-resumo"><div class="rotulo">${forma}</div><div class="valor">${brl(valor)}</div></div>`)
      .join('')}
    <div class="card-resumo"><div class="rotulo">Estoque baixo</div><div class="valor">${r.estoqueBaixo.length}</div>
      ${r.estoqueBaixo.map((p) => `<div style="font-size:.8rem;color:#b91c1c">${escapar(p.nome)}: ${p.estoque}</div>`).join('')}
    </div>`;

  $('#formAbrir').classList.toggle('hidden', r.aberto);
  $('#formFechar').classList.toggle('hidden', !r.aberto);
  if (r.aberto) {
    $('#infoCaixa').innerHTML = `Aberto por <strong>${escapar(r.abertoPor)}</strong> em<br>${new Date(r.aberturaEm).toLocaleString('pt-BR')}<br>
      Fundo de troco: <strong>${brl(r.fundo)}</strong><br>Dinheiro no caixa: <strong>${brl(r.dinheiroEsperado)}</strong>`;
  }
  $('#listaMovimentacoes').innerHTML = r.movimentacoes.length
    ? [...r.movimentacoes].reverse().map((m) =>
        `<div><span class="${m.tipo}">${m.tipo === 'sangria' ? '−' : '+'} ${brl(m.valor)}</span><span>${escapar(m.motivo || m.tipo)}</span></div>`
      ).join('')
    : '<div style="color:#94a3b8">Nenhuma</div>';

  const caixas = r.caixasAbertos || [];
  $('#caixasAbertos').innerHTML = caixas.length
    ? `<div class="caixa-form"><h3>Caixas abertos agora (${caixas.length})</h3>
        ${caixas.map((c) => `<div>👤 <strong>${escapar(c.abertoPor || '?')}</strong></div>`).join('')}
      </div>`
    : '';
}

$('#btnAbrirCaixa').addEventListener('click', async () => {
  try {
    await api('caixa/abrir', { method: 'POST', body: { fundo: Number($('#inputFundo').value) || 0 } });
    toast('Caixa aberto', 'ok');
    $('#inputFundo').value = '';
    carregarResumo();
  } catch (err) {
    toast(err.message, 'erro');
  }
});

$('#btnSangria').addEventListener('click', () => {
  $('#formMov').reset();
  modal('modalMov', true);
  $('#formMov').valor.focus();
});

$('#btnCancelarMov').addEventListener('click', () => modal('modalMov', false));

$('#formMov').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const mov = await api('caixa/movimentacao', {
      method: 'POST',
      body: { tipo: e.target.tipo.value, valor: Number(e.target.valor.value), motivo: e.target.motivo.value },
    });
    modal('modalMov', false);
    toast(`${mov.tipo === 'sangria' ? 'Sangria' : 'Suprimento'} de ${brl(mov.valor)} registrado`, 'ok');
    carregarResumo();
  } catch (err) {
    toast(err.message, 'erro');
  }
});

$('#btnFecharCaixa').addEventListener('click', async () => {
  try {
    const r = await api('resumo');
    $('#fcEsperado').innerHTML = `Dinheiro esperado no caixa: <strong>${brl(r.dinheiroEsperado)}</strong>`;
    $('#fcEsperado').dataset.esperado = r.dinheiroEsperado;
    $('#fcContado').value = '';
    $('#fcDiferenca').textContent = '';
    modal('modalFecharCaixa', true);
    $('#fcContado').focus();
  } catch (err) {
    toast(err.message, 'erro');
  }
});

$('#fcContado').addEventListener('input', () => {
  const esperado = Number($('#fcEsperado').dataset.esperado || 0);
  const texto = $('#fcContado').value;
  if (!texto) {
    $('#fcDiferenca').textContent = '';
    return;
  }
  const contado = Number(texto);
  if (!Number.isFinite(contado)) return;
  const dif = Math.round((contado - esperado) * 100) / 100;
  $('#fcDiferenca').textContent = dif === 0 ? 'Caixa batido, sem diferença!' :
    `Diferença: ${brl(Math.abs(dif))} ${dif > 0 ? 'a mais' : 'a menos'}`;
  $('#fcDiferenca').className = `fc-diferenca ${dif === 0 ? 'positiva' : 'negativa'}`;
});

$('#btnCancelarFechar').addEventListener('click', () => modal('modalFecharCaixa', false));

$('#formFecharCaixa').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const registro = await api('caixa/fechar', {
      method: 'POST',
      body: { dinheiroContado: Number($('#fcContado').value) || 0 },
    });
    modal('modalFecharCaixa', false);
    atualizarStatusCaixa(false);
    const dif = registro.diferenca;
    toast(dif === 0 ? 'Caixa fechado e batido!' : `Caixa fechado. Diferença: ${brl(Math.abs(dif))} ${dif > 0 ? 'a mais' : 'a menos'}`, dif === 0 ? 'ok' : 'erro');
    carregarResumo();
  } catch (err) {
    toast(err.message, 'erro');
  }
});

/* ---------- ajustes ---------- */

async function carregarAjustes() {
  const { configuracao, versao } = await api('configuracao');
  estado.cfg = configuracao;
  $('#cfgNome').value = configuracao.loja.nome || '';
  $('#cfgCnpj').value = configuracao.loja.cnpj || '';
  $('#cfgEndereco').value = configuracao.loja.endereco || '';
  $('#cfgTelefone').value = configuracao.loja.telefone || '';
  $('#cfgMensagem').value = configuracao.cupom.mensagem || '';
  $('#infoVersao').textContent = `Versão do sistema: ${versao} · Dados em data/db.json`;

  if (estado.usuario.role === 'admin') {
    try {
      const eventos = await api('auditoria?limite=100');
      $('#listaAuditoria').innerHTML = eventos.length
        ? eventos.map((e) =>
            `<div><span style="color:#94a3b8;font-size:.78rem">${e.data ? new Date(e.data).toLocaleString('pt-BR') : ''}</span> <strong>${escapar(e.usuario)}</strong></div>`
          ).join('')
        : '<div style="color:#94a3b8">Sem registros ainda</div>';
    } catch {
      $('#listaAuditoria').innerHTML = '<div style="color:#94a3b8">Indisponível</div>';
    }
  }
}

$('#btnSalvarConfig').addEventListener('click', async () => {
  try {
    const r = await api('configuracao', {
      method: 'PUT',
      body: {
        loja: { nome: $('#cfgNome').value, cnpj: $('#cfgCnpj').value, endereco: $('#cfgEndereco').value, telefone: $('#cfgTelefone').value },
        cupom: { mensagem: $('#cfgMensagem').value },
      },
    });
    estado.cfg = r.configuracao;
    toast('Configurações salvas', 'ok');
  } catch (err) {
    toast(err.message, 'erro');
  }
});

function baixarArquivo(conteudo, nome, tipo) {
  const blob = new Blob([conteudo], { type: tipo });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('#btnBackup').addEventListener('click', async () => {
  try {
    const resp = await fetch('/api/backup', { headers: { Authorization: `Bearer ${estado.token}` } });
    if (!resp.ok) throw new Error('Falha no backup');
    baixarArquivo(await resp.text(), `pdv-backup-${hojeISO()}.json`, 'application/json');
  } catch (err) {
    toast(err.message, 'erro');
  }
});

/* ---------- atalhos ---------- */

document.addEventListener('keydown', (e) => {
  if (!$('#telaLogin').classList.contains('hidden')) return;
  if (e.key === 'F1') {
    e.preventDefault();
    $('[data-aba="venda"]').click();
    $('#inputBusca').focus();
  }
  if (e.key === 'F2') {
    e.preventDefault();
    if (!$('#btnPagar').disabled) abrirModalPagamento();
  }
  if (e.key === 'F4') {
    e.preventDefault();
    $('#btnCancelar').click();
  }
  if (e.key === 'Escape') {
    $$('.modal').forEach((m) => m.classList.add('hidden'));
  }
});

/* ---------- init ---------- */

verificarSessao();
