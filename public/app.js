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
  await carregarCatalogo();
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
  const atual = estado.carrinho.get(id) || 0;
  const novaQtd = atual + delta;
  if (novaQtd <= 0) {
    estado.carrinho.delete(id);
  } else if (novaQtd > produto.estoque) {
    return toast(`Estoque insuficiente (${produto.estoque} ${produto.unidade})`, 'erro');
  } else {
    estado.carrinho.set(id, novaQtd);
  }
  renderCarrinho();
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
  $('#inputCliente').value = '';
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
  if (pago + valor > total + 0.001 && $('#selForma').value !== 'dinheiro') {
    return toast('Troco só é permitido em dinheiro', 'erro');
  }
  estado.pagamentos.push({ forma: $('#selForma').value, valor });
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
        cliente: $('#inputCliente').value,
      },
    });
    modal('modalPagamento', false);
    estado.carrinho.clear();
    $('#inputDesconto').value = 0;
    $('#inputCliente').value = '';
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
        <td class="${p.estoque <= 3 ? 'estoque-baixo' : ''}">${p.estoque}</td>
        <td><button class="btn secundario mini" data-editar="${p.id}">Editar</button></td>
      </tr>`
    )
    .join('');
  $('#corProdutos').querySelectorAll('[data-editar]').forEach((b) =>
    b.addEventListener('click', () => abrirModalProduto(Number(b.dataset.editar)))
  );
}

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
    $('#repConteudo').innerHTML = `
      <div class="cards">
        <div class="card-resumo"><div class="rotulo">Faturamento</div><div class="valor">${brl(r.faturamento)}</div></div>
        <div class="card-resumo"><div class="rotulo">Vendas</div><div class="valor">${r.numVendas}</div></div>
        <div class="card-resumo"><div class="rotulo">Ticket médio</div><div class="valor">${brl(r.ticketMedio)}</div></div>
        <div class="card-resumo"><div class="rotulo">Descontos</div><div class="valor">${brl(r.descontos)}</div></div>
        ${r.numCanceladas ? `<div class="card-resumo negativo"><div class="rotulo">Canceladas</div><div class="valor">${r.numCanceladas}</div></div>` : ''}
        ${Object.entries(r.porForma)
          .map(([forma, valor]) => `<div class="card-resumo"><div class="rotulo">${forma}</div><div class="valor">${brl(valor)}</div></div>`)
          .join('')}
      </div>
      <div class="rep-secao">
        <h3>Faturamento por dia</h3>
        <table class="trep"><thead><tr><th>Data</th><th>Vendas</th><th>Total</th></tr></thead><tbody>
          ${r.porDia.map((d) => `<tr><td>${new Date(d.dia + 'T12:00').toLocaleDateString('pt-BR')}</td><td>${d.vendas}</td><td class="num">${brl(d.total)}</td></tr>`).join('') || '<tr><td colspan="3" style="color:#94a3b8">Sem vendas no período</td></tr>'}
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
    <table><thead><tr><th>Data</th><th>Vendas</th><th>Total</th></tr></thead><tbody>
      ${r.porDia.map((d) => `<tr><td>${new Date(d.dia + 'T12:00').toLocaleDateString('pt-BR')}</td><td>${d.vendas}</td><td>${brl(d.total)}</td></tr>`).join('')}
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
