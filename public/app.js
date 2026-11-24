'use strict';

const $ = (sel) => document.querySelector(sel);
const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const estado = {
  produtos: [],
  carrinho: new Map(),
  pagamentos: [],
  produtoEditando: null,
};

/* ---------- utilidades ---------- */

async function api(rota, opcoes = {}) {
  const resp = await fetch(`/api/${rota}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opcoes,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  if (resp.status === 204) return null;
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
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

/* ---------- abas ---------- */

document.querySelectorAll('.aba').forEach((botao) => {
  botao.addEventListener('click', () => {
    document.querySelectorAll('.aba').forEach((b) => b.classList.remove('ativa'));
    document.querySelectorAll('.painel').forEach((p) => p.classList.remove('ativo'));
    botao.classList.add('ativa');
    $(`#aba-${botao.dataset.aba}`).classList.add('ativo');
    if (botao.dataset.aba === 'produtos') carregarProdutos();
    if (botao.dataset.aba === 'historico') carregarHistorico();
    if (botao.dataset.aba === 'resumo') carregarResumo();
    if (botao.dataset.aba === 'venda') carregarCatalogo();
  });
});

/* ---------- catálogo e busca ---------- */

async function carregarProdutos() {
  estado.produtos = await api('produtos');
  return estado.produtos;
}

async function carregarCatalogo() {
  await carregarProdutos();
  renderCatalogo();
  renderCarrinho();
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
          <div class="estoque">${p.codigo} · estoque: ${p.estoque} ${p.unidade}</div>
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

function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

async function buscaRapida() {
  const termo = $('#inputBusca').value.trim();
  if (!termo) return;
  const resultados = await api(`produtos/busca?q=${encodeURIComponent(termo)}`);
  if (resultados.length === 1) {
    if (resultados[0].estoque <= 0) return toast(`"${resultados[0].nome}" sem estoque`, 'erro');
    adicionarAoCarrinho(resultados[0].id, 1);
    $('#inputBusca').value = '';
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
    const p = estado.produtos.find((x) => x.id === id);
    subtotal += qtd * p.preco;
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
  renderCarrinho();
});

/* ---------- pagamento ---------- */

function abrirModalPagamento() {
  if (!estado.carrinho.size) return;
  estado.pagamentos = [];
  $('#totalModal').textContent = brl(totalComDesconto());
  $('#inputValorPago').value = '';
  renderPagamentos();
  $('#modalPagamento').classList.remove('hidden');
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
  const trocoTexto = falta < 0 ? `Troco: ${brl(-falta)}` : '';
  $('#btnConfirmarVenda').textContent = trocoTexto ? `Confirmar (${trocoTexto})` : 'Confirmar venda';
}

$('#btnAddPagamento').addEventListener('click', () => {
  const valor = Number($('#inputValorPago').value);
  if (!Number.isFinite(valor) || valor <= 0) return toast('Informe um valor válido', 'erro');
  const total = totalComDesconto();
  const pago = estado.pagamentos.reduce((s, p) => s + p.valor, 0);
  if (Math.round((pago + valor) * 100) / 100 > total + 0.001) {
    const troco = Math.round((pago + valor - total) * 100) / 100;
    if ($('#selForma').value !== 'dinheiro') return toast('Troco só é permitido em dinheiro', 'erro');
  }
  estado.pagamentos.push({ forma: $('#selForma').value, valor });
  $('#inputValorPago').value = '';
  renderPagamentos();
});

$('#btnFecharModal').addEventListener('click', () => $('#modalPagamento').classList.add('hidden'));

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
      },
    });
    $('#modalPagamento').classList.add('hidden');
    estado.carrinho.clear();
    $('#inputDesconto').value = 0;
    await carregarCatalogo();
    imprimirCupom(venda);
    toast(`Venda #${venda.id} concluída!`, 'ok');
  } catch (err) {
    toast(err.message, 'erro');
  }
});

/* ---------- cupom ---------- */

function cupomHTML(venda) {
  const linhas = venda.itens
    .map(
      (i) =>
        `${escapar(i.nome)}\n` +
        `${i.qtd} ${i.unidade} x ${brl(i.precoUnit)}`.padEnd(28) +
        `${brl(i.total).padStart(12)}`
    )
    .join('\n');
  const pagamentos = venda.pagamentos.map((p) => `${p.forma.toUpperCase()}${'.'.repeat(12)}${brl(p.valor)}`).join('\n');
  const data = new Date(venda.data).toLocaleString('pt-BR');
  return `
    <div style="text-align:center"><strong>PDV EXPRESS</strong><br>CUPOM NÃO FISCAL</div>
    <hr>
    Venda #${venda.id} — ${data}<br>Operador: ${escapar(venda.operador)}
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
    <div style="text-align:center">Obrigado pela preferência!<br>Volte sempre</div>`;
}

function imprimirCupom(venda) {
  $('#cupom .cupom-conteudo').innerHTML = cupomHTML(venda);
  setTimeout(() => window.print(), 150);
}

/* ---------- produtos (CRUD) ---------- */

async function renderProdutos(filtro = '') {
  if (!estado.produtos.length) await carregarProdutos();
  const termo = filtro.trim().toLowerCase();
  const lista = estado.produtos.filter((p) => !termo || p.nome.toLowerCase().includes(termo) || p.codigo.toLowerCase().includes(termo));
  $('#corProdutos').innerHTML = lista
    .map(
      (p) => `
      <tr>
        <td>${escapar(p.codigo)}</td>
        <td>${escapar(p.nome)}</td>
        <td>${p.unidade}</td>
        <td>${brl(p.preco)}</td>
        <td class="${p.estoque <= 3 ? 'estoque-baixo' : ''}">${p.estoque}</td>
        <td><button class="btn secundario" data-editar="${p.id}">Editar</button></td>
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
  $('#modalProduto').classList.remove('hidden');
  form.codigo.focus();
}

$('#btnNovoProduto').addEventListener('click', () => abrirModalProduto());
$('#btnCancelarProduto').addEventListener('click', () => $('#modalProduto').classList.add('hidden'));

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
    $('#modalProduto').classList.add('hidden');
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
  $('#corHistorico').innerHTML = vendas.length
    ? vendas
        .map(
          (v) => `
        <tr>
          <td>#${v.id}</td>
          <td>${new Date(v.data).toLocaleString('pt-BR')}</td>
          <td>${v.itens.reduce((s, i) => s + i.qtd, 0)} item(ns)</td>
          <td><strong>${brl(v.total)}</strong></td>
          <td>${v.pagamentos.map((p) => `${p.forma}: ${brl(p.valor)}`).join(', ')}</td>
          <td><button class="btn secundario" data-imprimir="${v.id}">🖨 Cupom</button></td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="6" style="text-align:center;color:#94a3b8">Nenhuma venda registrada</td></tr>';
  $('#corHistorico').querySelectorAll('[data-imprimir]').forEach((b) =>
    b.addEventListener('click', () => {
      const venda = vendas.find((v) => v.id === Number(b.dataset.imprimir));
      imprimirCupom(venda);
    })
  );
}

/* ---------- resumo + caixa ---------- */

async function carregarResumo() {
  const r = await api('resumo');
  $('#cardsResumo').innerHTML = `
    <div class="card-resumo"><div class="rotulo">Vendas hoje</div><div class="valor">${r.vendas}</div></div>
    <div class="card-resumo"><div class="rotulo">Faturamento hoje</div><div class="valor">${brl(r.faturamento)}</div></div>
    ${Object.entries(r.porForma)
      .map(([forma, valor]) => `<div class="card-resumo"><div class="rotulo">${forma}</div><div class="valor">${brl(valor)}</div></div>`)
      .join('')}
    <div class="card-resumo"><div class="rotulo">Estoque baixo</div><div class="valor">${r.estoqueBaixo.length}</div>
      ${r.estoqueBaixo.map((p) => `<div style="font-size:.8rem;color:#b91c1c">${escapar(p.nome)}: ${p.estoque}</div>`).join('')}
    </div>`;

  const aberto = r.aberto;
  $('#statusCaixa').textContent = aberto ? 'Caixa aberto' : 'Caixa fechado';
  $('#statusCaixa').className = `status-caixa ${aberto ? 'aberto' : 'fechado'}`;
  $('#formAbrir').classList.toggle('hidden', aberto);
  $('#formFechar').classList.toggle('hidden', !aberto);
  if (aberto) {
    $('#infoCaixa').innerHTML = `Aberto em <strong>${new Date(r.aberturaEm).toLocaleString('pt-BR')}</strong><br>Fundo de troco: ${brl(r.fundoTroco)}`;
  }
}

$('#btnAbrirCaixa').addEventListener('click', async () => {
  try {
    await api('caixa/abrir', { method: 'POST', body: { fundo: Number($('#inputFundo').value) || 0 } });
    toast('Caixa aberto', 'ok');
    carregarResumo();
  } catch (err) {
    toast(err.message, 'erro');
  }
});

$('#btnFecharCaixa').addEventListener('click', async () => {
  if (!confirm('Fechar o caixa e encerrar o dia?')) return;
  const r = await api('caixa/fechar', { method: 'POST' });
  toast(`Caixa fechado. Total: ${brl(r.faturamento)} em ${r.vendas} venda(s)`, 'ok');
  carregarResumo();
});

/* ---------- atalhos ---------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'F2') {
    e.preventDefault();
    if (!$('#btnPagar').disabled) abrirModalPagamento();
  }
  if (e.key === 'Escape') {
    $('#modalPagamento').classList.add('hidden');
    $('#modalProduto').classList.add('hidden');
  }
});

/* ---------- init ---------- */

carregarCatalogo().then(async () => {
  const r = await api('resumo');
  $('#statusCaixa').textContent = r.aberto ? 'Caixa aberto' : 'Caixa fechado';
  $('#statusCaixa').className = `status-caixa ${r.aberto ? 'aberto' : 'fechado'}`;
});
