'use strict';
const { spawn } = require('child_process');

function req(method, rota, corpo, token) {
  return new Promise((resolve, reject) => {
    const dados = corpo ? JSON.stringify(corpo) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (dados) headers['Content-Length'] = Buffer.byteLength(dados);
    const r = require('http').request(
      { host: '127.0.0.1', port: 3123, path: `/api/${rota}`, method, headers },
      (resp) => {
        let buf = '';
        resp.on('data', (c) => (buf += c));
        resp.on('end', () => {
          let body = null;
          try { body = buf ? JSON.parse(buf) : null; } catch { body = buf; }
          resolve({ status: resp.statusCode, body });
        });
      }
    );
    r.on('error', reject);
    if (dados) r.write(dados);
    r.end();
  });
}

function getArquivo(caminho) {
  return new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port: 3123, path: caminho }, (resp) => {
      let buf = '';
      resp.on('data', (c) => (buf += c));
      resp.on('end', () => resolve({ status: resp.statusCode, body: buf }));
    }).on('error', reject);
  });
}

const assert = (cond, msg) => {
  if (!cond) { console.error('FALHOU:', msg); process.exit(1); }
  console.log('OK:', msg);
};

(async () => {
  const servidor = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: '3123', PDV_LOGIN_MAX_TENTATIVAS: '5', PDV_LOGIN_JANELA_MS: '1000' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const matarServidor = () => { try { servidor.kill('SIGKILL'); } catch {} };
  process.on('exit', matarServidor);
  process.on('SIGINT', () => { matarServidor(); process.exit(1); });

  let r = await req('GET', 'saude');
  assert(r.status === 200 && r.body.precisaSetup === true, 'saúde detecta ausência de usuários');

  r = await req('GET', 'produtos');
  assert(r.status === 401, 'API exige autenticação');

  r = await req('POST', 'setup', { nome: 'Chefe', login: 'admin', senha: '1234' });
  assert(r.status === 201 && r.body.token && r.body.usuario.role === 'admin', 'setup cria administrador');
  const tokenAdmin = r.body.token;
  const idAdmin = r.body.usuario.id;

  r = await req('POST', 'setup', { login: 'x', senha: '1234' });
  assert(r.status === 403, 'setup não repete');

  r = await req('POST', 'login', { login: 'admin', senha: 'errada' });
  assert(r.status === 401, 'senha errada rejeitada');

  r = await req('POST', 'login', { login: 'ADMIN', senha: '1234' });
  assert(r.status === 200, 'login funciona (case-insensitive)');
  const tokenAdmin2 = r.body.token;

  r = await req('POST', 'operadores', { nome: 'Maria Caixa', login: 'maria', senha: '1234', role: 'operador' }, tokenAdmin);
  assert(r.status === 201 && r.body.role === 'operador', 'criar operador');
  const idMaria = r.body.id;

  r = await req('POST', 'operadores', { nome: 'Duplicado', login: 'MARIA', senha: '1234' }, tokenAdmin);
  assert(r.status === 400, 'login de operador duplicado rejeitado');

  r = await req('POST', 'login', { login: 'maria', senha: '1234' });
  assert(r.status === 200, 'login operador');
  const tokenMaria = r.body.token;

  r = await req('POST', 'produtos', { codigo: '7890001', nome: 'Arroz 5kg', preco: 24.9, estoque: 10, unidade: 'PCT' }, tokenMaria);
  assert(r.status === 403, 'operador não cadastra produto');

  r = await req('POST', 'produtos', { codigo: '7890001', nome: 'Arroz 5kg', preco: 24.9, estoque: 10, unidade: 'PCT' }, tokenAdmin);
  assert(r.status === 201, 'admin cadastra produto 1');
  r = await req('POST', 'produtos', { codigo: '7890002', nome: 'Café 500g', preco: 18.5, estoque: 20 }, tokenAdmin);
  assert(r.status === 201, 'admin cadastra produto 2');

  r = await req('PUT', 'configuracao', { loja: { nome: 'Mercado do Zé', cnpj: '12.345.678/0001-90', endereco: 'Rua das Palmeiras, 100', telefone: '(11) 99999-0000' }, cupom: { mensagem: 'Volte sempre, cliente especial!' } }, tokenAdmin);
  assert(r.status === 200 && r.body.configuracao.loja.nome === 'Mercado do Zé', 'configuração salva');

  r = await req('POST', 'caixa/abrir', { fundo: 100 }, tokenMaria);
  assert(r.status === 200 && r.body.abertoPor === 'Maria Caixa', 'operador abre caixa');

  r = await req('POST', 'vendas', { itens: [ { produtoId: 1, qtd: 2, precoUnit: 24.9 }, { produtoId: 2, qtd: 1, precoUnit: 18.5 } ], desconto: 2.4, pagamentos: [ { forma: 'dinheiro', valor: 70 } ], cliente: 'João' }, tokenMaria);
  assert(r.status === 201 && r.body.total === 65.9 && r.body.troco === 4.1, 'venda 1 criada (troco R$4,10)');
  assert(r.body.operador === 'Maria Caixa' && r.body.cliente === 'João', 'venda registra operador e cliente');
  const venda1 = r.body.id;

  r = await req('POST', 'vendas', { itens: [ { produtoId: 1, qtd: 2, precoUnit: 24.9 } ], pagamentos: [ { forma: 'pix', valor: 52.4 } ] }, tokenMaria);
  assert(r.status === 201 && r.body.troco === 2.6, 'venda 2 (pix, troco calc)');
  const venda2 = r.body.id;

  r = await req('POST', 'caixa/movimentacao', { tipo: 'sangria', valor: 42.4, motivo: 'depósito banco' }, tokenMaria);
  assert(r.status === 201, 'sangria registrada');

  r = await req('POST', 'caixa/movimentacao', { tipo: 'sangria', valor: 9999 }, tokenMaria);
  assert(r.status === 400, 'sangria maior que caixa rejeitada');

  r = await req('POST', 'caixa/movimentacao', { tipo: 'suprimento', valor: 42.4, motivo: 'troco extra' }, tokenMaria);
  assert(r.status === 201, 'suprimento registrado');

  r = await req('GET', 'resumo', null, tokenMaria);
  assert(r.status === 200 && r.body.vendas === 2 && r.body.faturamento === 115.7, `resumo do dia (faturamento ${r.body.faturamento})`);
  assert(r.body.dinheiroEsperado === 165.9, `dinheiro esperado (fundo 100 + dinheiro líquido 65,9 = ${r.body.dinheiroEsperado})`);

  r = await req('GET', 'relatorios?de=2020-01-01&ate=2020-01-01', null, tokenAdmin);
  assert(r.status === 200 && r.body.numVendas === 0, 'relatório período vazio');

  r = await req('GET', 'relatorios', null, tokenMaria);
  assert(r.status === 403, 'operador não acessa relatórios');

  const hoje = new Date().toISOString().slice(0, 10);
  r = await req('GET', `relatorios?de=${hoje}&ate=${hoje}`, null, tokenAdmin);
  assert(r.status === 200 && r.body.numVendas === 2 && r.body.faturamento === 115.7 && r.body.descontos === 2.4, 'relatório do dia completo');
  assert(r.body.ticketMedio === 57.85, `ticket médio (${r.body.ticketMedio})`);
  assert(r.body.porForma.dinheiro === 70 && r.body.porForma.pix === 52.4, 'por forma de pagamento');
  assert(r.body.porDia.length === 1 && r.body.porDia[0].total === 115.7, 'por dia');
  assert(r.body.topProdutos[0].nome === 'Arroz 5kg' && r.body.topProdutos[0].total === 99.6, `top produtos (${r.body.topProdutos[0].total})`);
  r = await req('GET', `relatorios/csv?de=${hoje}&ate=${hoje}`, null, tokenAdmin);
  assert(r.status === 200 && typeof r.body === 'object' && r.body.csv.includes('id;data;operador'), 'CSV gerado');
  const linhasCsv = r.body.csv.trim().split('\r\n').length;
  assert(linhasCsv === 3, `CSV com 2 vendas + cabeçalho (${linhasCsv})`);

  r = await req('POST', `vendas/${venda1}/cancelar`, { motivo: 'arrepentimento' }, tokenMaria);
  assert(r.status === 403, 'operador não cancela venda');

  r = await req('POST', `vendas/${venda1}/cancelar`, { motivo: 'arrependimento' }, tokenAdmin);
  assert(r.status === 200 && r.body.canceladaPor === 'Chefe', 'admin cancela venda');

  r = await req('POST', `vendas/${venda1}/cancelar`, {}, tokenAdmin);
  assert(r.status === 400, 'venda já cancelada rejeitada');

  r = await req('GET', 'produtos', null, tokenAdmin);
  const arroz = r.body.find((p) => p.id === 1);
  const cafe = r.body.find((p) => p.id === 2);
  assert(arroz.estoque === 8 && cafe.estoque === 20, `estoque estornado (arroz ${arroz.estoque}, café ${cafe.estoque})`);

  r = await req('GET', `relatorios?de=${hoje}&ate=${hoje}`, null, tokenAdmin);
  assert(r.body.numVendas === 1 && r.body.numCanceladas === 1 && r.body.faturamento === 49.8, 'canceladas excluídas do faturamento e contadas');

  r = await req('GET', 'resumo', null, tokenMaria);
  assert(r.body.vendas === 1 && r.body.canceladasHoje === 1, 'resumo reflete cancelamento');

  r = await req('POST', 'caixa/fechar', { dinheiroContado: 96 }, tokenMaria);
  assert(r.status === 200 && r.body.dinheiroEsperado === 100 && r.body.diferenca === -4, `fechamento com diferença (${r.body.diferenca})`);
  assert(r.body.numVendas === 1 && r.body.faturamento === 49.8, 'fechamento consolida período');

  r = await req('POST', 'vendas', { itens: [ { produtoId: 1, qtd: 1 } ] }, tokenMaria);
  assert(r.status === 400 && r.body.erro.includes('Abra o seu caixa antes de vender'), 'venda com caixa fechado rejeitada');

  r = await req('PUT', `operadores/${idMaria}`, { senha: '4321' }, tokenAdmin);
  assert(r.status === 200, 'senha de operador trocada');
  r = await req('POST', 'login', { login: 'maria', senha: '1234' });
  assert(r.status === 401, 'sessão/senha antigas invalidadas');
  r = await req('POST', 'login', { login: 'maria', senha: '4321' });
  assert(r.status === 200, 'nova senha funciona');

  r = await req('PUT', `operadores/${idMaria}`, { role: 'admin' }, tokenAdmin);
  assert(r.status === 200 && r.body.role === 'admin', 'promover para admin');
  r = await req('PUT', `operadores/${idAdmin}`, { role: 'operador' }, tokenAdmin);
  assert(r.status === 400, 'admin não remove o próprio cargo');
  r = await req('PUT', `operadores/${idAdmin}`, { ativo: false }, tokenAdmin);
  assert(r.status === 400, 'admin não se desativa');
  r = await req('DELETE', `operadores/${idMaria}`, null, tokenAdmin);
  assert(r.status === 204, 'excluir operador');
  r = await req('POST', 'login', { login: 'maria', senha: '4321' });
  assert(r.status === 401, 'operador excluído não loga');

  r = await req('GET', 'backup', null, tokenAdmin);
  assert(r.status === 200 && typeof r.body === 'object' && (r.body.produtos || r.body.usuarios), 'backup baixado');
  r = await req('GET', 'backup', null);
  assert(r.status === 401, 'backup exige autenticação');

  /* ============ v3: clientes, fiado, balança, importação, rate limit ============ */
  r = await req('POST', 'operadores', { nome: 'Bruno', login: 'bruno', senha: '1234', role: 'operador' }, tokenAdmin);
  assert(r.status === 201, 'criar segundo operador');
  r = await req('POST', 'login', { login: 'bruno', senha: '1234' });
  assert(r.status === 200, 'login segundo operador');
  const tokenBruno = r.body.token;


  r = await req('POST', 'clientes', { nome: 'joao pereira', telefone: '(11) 98888-1111' }, tokenBruno);
  assert(r.status === 201 && r.body.nome === 'joao pereira', 'cadastrar cliente');
  const idJoao = r.body.id;
  r = await req('POST', 'clientes', { nome: 'Ana', telefone: '1197777' }, tokenBruno);
  const idAna = r.body.id;

  r = await req('POST', 'caixa/abrir', { fundo: 50 }, tokenBruno);
  assert(r.status === 200, 'caixa reaberto');

  r = await req('POST', 'vendas', { itens: [ { produtoId: 1, qtd: 3, precoUnit: 24.9 } ], pagamentos: [ { forma: 'fiado', valor: 42.4 } ] }, tokenBruno);
  assert(r.status === 400 && r.body.erro.includes('exige cliente'), 'fiado sem cliente rejeitado');

  r = await req('POST', 'vendas', { itens: [ { produtoId: 1, qtd: 3, precoUnit: 24.9 } ], pagamentos: [ { forma: 'fiado', valor: 42.4 }, { forma: 'dinheiro', valor: 32.3 } ], clienteId: idJoao }, tokenBruno);
  assert(r.status === 201 && r.body.cliente === 'joao pereira', 'venda fiado registrada');
  const vendaFiado = r.body.id;

  r = await req('GET', `clientes/${idJoao}`, null, tokenBruno);
  assert(r.body.saldo === 42.4 && r.body.movimentos.length === 1, `saldo fiado atualizado (${r.body.saldo})`);

  r = await req('POST', 'vendas', { itens: [ { produtoId: 2, qtd: 2, precoUnit: 18.5 } ], pagamentos: [ { forma: 'fiado', valor: 20 }, { forma: 'dinheiro', valor: 17 } ], clienteId: idAna }, tokenBruno);
  assert(r.status === 201 && r.body.troco === 0, 'venda mista fiado+dinheiro (custo exato, sem troco)');

  r = await req('POST', 'vendas', { itens: [ { produtoId: 1, qtd: 1, precoUnit: 24.9 } ], pagamentos: [ { forma: 'fiado', valor: 50 }, { forma: 'dinheiro', valor: 50 } ], clienteId: idAna }, tokenBruno);
  assert(r.status === 400 && r.body.erro.includes('Troco não pode ser financiado'), 'fiado financiando troco rejeitado');

  r = await req('POST', `clientes/${idJoao}/receber`, { valor: 12.4, forma: 'dinheiro' }, tokenBruno);
  assert(r.status === 200 && r.body.saldo === 30, `recebimento parcial (${r.body.saldo})`);

  r = await req('GET', 'resumo', null, tokenBruno);
  const supMov = r.body.movimentacoes.find((mv) => mv.motivo && mv.motivo.includes('Recebimento fiado'));
  assert(supMov && supMov.valor === 12.4, 'recebimento em dinheiro virou suprimento no caixa');

  r = await req('POST', `clientes/${idAna}/receber`, { valor: 9999, forma: 'pix' }, tokenBruno);
  assert(r.status === 400, 'receber mais que a dívida rejeitado');

  r = await req('DELETE', `clientes/${idJoao}`, null, tokenAdmin);
  assert(r.status === 400, 'excluir cliente com fiado aberto rejeitado');

  r = await req('POST', `vendas/${vendaFiado}/cancelar`, { motivo: 'teste fiado' }, tokenAdmin);
  assert(r.status === 200, 'venda fiado cancelada');
  r = await req('GET', `clientes/${idJoao}`, null, tokenAdmin);
  assert(r.body.saldo === -12.4 || r.body.saldo === 0, `cancelamento de fiado ajusta saldo (${r.body.saldo})`);

  r = await req('POST', 'produtos/2/entrada', { qtd: 10 }, tokenBruno);
  assert(r.status === 403, 'operador não dá entrada de estoque');
  r = await req('POST', 'produtos/2/entrada', { qtd: 10 }, tokenAdmin);
  assert(r.status === 200 && r.body.estoque === 28, `entrada de estoque (${r.body.estoque})`);
  r = await req('POST', 'produtos/2/entrada', { qtd: -5 }, tokenAdmin);
  assert(r.status === 400, 'entrada negativa rejeitada');

  r = await req('POST', 'produtos/importar', { csv: 'codigo;nome;preco;estoque\n7890001;Arroz Tipo A;25.50;100;PCT\n7890099;Óleo de Soja;5.75;48\nlinha-ruim;Sem Preço;abc' }, tokenAdmin);
  assert(r.body.criados === 1 && r.body.atualizados === 1 && r.body.erros.length === 1, `importação CSV (${JSON.stringify(r.body)})`);
  r = await req('GET', 'produtos', null, tokenAdmin);
  const atualizado = r.body.find((p) => p.codigo === '7890001');
  const novoImport = r.body.find((p) => p.codigo === '7890099');
  assert(atualizado.nome === 'Arroz Tipo A' && atualizado.preco === 25.5 && atualizado.estoque === 100, 'upsert de produto existente');
  assert(novoImport && novoImport.unidade === 'UN', 'produto novo importado com defautls');

  for (let i = 0; i < 10; i++) {
    await req('POST', 'login', { login: 'admin', senha: 'errada' });
  }
  r = await req('POST', 'login', { login: 'admin', senha: '1234' });
  assert(r.status === 429, `rate limit bloqueou após várias tentativas (${r.status})`);
  await new Promise((r2) => setTimeout(r2, 1100));
  r = await req('POST', 'login', { login: 'admin', senha: '1234' });
  assert(r.status === 200, 'rate limit expirou e login voltou a funcionar');

  r = await req('POST', 'caixa/fechar', { dinheiroContado: 79.4 }, tokenBruno);
  if (r.status !== 200) console.log('INFO fechamento:', JSON.stringify(r.body));
  assert(r.status === 200 && r.body.dinheiroEsperado === 79.4 && r.body.diferenca === 0, `fechamento final com caixa batido (esperado ${r.body ? r.body.dinheiroEsperado : '?'})`);

  /* ============ v4: multi-caixa, custos/lucro, auditoria ============ */

  r = await req('POST', 'produtos', { codigo: '7890500', nome: 'Café Torrado', preco: 15, custo: 10, estoque: 10 }, tokenAdmin);
  assert(r.status === 201 && r.body.custo === 10, 'produto criado com custo');
  const idCafe = r.body.id;

  r = await req('PUT', `produtos/${idCafe}`, { codigo: '7890500', nome: 'Café Torrado', preco: 15, custo: 8, estoque: 10 }, tokenAdmin);
  assert(r.status === 200 && r.body.custo === 8, 'custo atualizado via PUT');

  r = await req('GET', 'auditoria', null, tokenBruno);
  assert(r.status === 403, 'auditoria negada para operador');

  r = await req('GET', `relatorios?de=${hoje}&ate=${hoje}`, null, tokenAdmin);
  const lucroAntes = r.body.lucroEstimado;

  r = await req('POST', 'caixa/abrir', { fundo: 20 }, tokenBruno);
  assert(r.status === 200, 'Bruno abre o caixa dele');
  r = await req('POST', 'caixa/abrir', { fundo: 10 }, tokenAdmin);
  assert(r.status === 200, 'admin abre caixa próprio com caixa de Bruno aberto');

  r = await req('GET', 'resumo', null, tokenAdmin);
  assert(r.body.aberto === true, 'resumo mostra caixa próprio aberto');
  assert(Array.isArray(r.body.caixasAbertos) && r.body.caixasAbertos.length === 2, `dois caixas abertos no resumo (${JSON.stringify(r.body.caixasAbertos)})`);
  const caixaBrunoResumo = r.body.caixasAbertos.find((c) => c.abertoPor === 'Bruno');
  const caixaAdminResumo = r.body.caixasAbertos.find((c) => c.abertoPor === 'Chefe');
  assert(caixaBrunoResumo && caixaBrunoResumo.fundo === 20 && caixaBrunoResumo.dinheiro === 20, 'caixa de Bruno visível com fundo/dinheiro');
  assert(caixaAdminResumo && caixaAdminResumo.fundo === 10, 'caixa do admin visível no resumo');

  r = await req('POST', 'vendas', { itens: [ { produtoId: idCafe, qtd: 2 } ], pagamentos: [ { forma: 'dinheiro', valor: 50 } ] }, tokenAdmin);
  assert(r.status === 201 && r.body.troco === 20, 'venda do admin no caixa dele');
  assert(r.body.itens[0].custoUnit === 8, 'item guarda custoUnit do momento da venda');

  r = await req('POST', 'vendas', { itens: [ { produtoId: idCafe, qtd: 1 } ], pagamentos: [ { forma: 'dinheiro', valor: 15 } ] }, tokenBruno);
  assert(r.status === 201, 'venda do Bruno no caixa dele');

  r = await req('GET', 'resumo', null, tokenAdmin);
  assert(r.body.dinheiroEsperado === 40, `dinheiro esperado isolado (admin: ${r.body.dinheiroEsperado})`);
  r = await req('GET', 'resumo', null, tokenBruno);
  assert(r.body.dinheiroEsperado === 35, `dinheiro esperado isolado (Bruno: ${r.body.dinheiroEsperado})`);

  r = await req('POST', 'caixa/fechar', { dinheiroContado: 40 }, tokenAdmin);
  assert(r.status === 200 && r.body.diferenca === 0 && r.body.fechadoPor === 'Chefe', 'admin fecha somente o próprio caixa');

  r = await req('GET', 'resumo', null, tokenBruno);
  assert(r.body.aberto === true, 'caixa de Bruno segue aberto (multi-caixa independente)');

  r = await req('GET', `relatorios?de=${hoje}&ate=${hoje}`, null, tokenAdmin);
  assert(r.body.lucroEstimado === lucroAntes + 21, `lucro estimado = antes + 21 (agora ${r.body.lucroEstimado})`);
  const diaHoje = r.body.porDia[r.body.porDia.length - 1];
  assert(diaHoje.lucro === r.body.lucroEstimado, 'lucro por dia agregado no relatório');

  r = await req('GET', 'auditoria?limite=50', null, tokenAdmin);
  assert(r.status === 200 && Array.isArray(r.body) && r.body.length > 0 && r.body[0].acao, 'auditoria lista eventos para admin');
  assert(r.body.some((e) => e.acao === 'venda' && e.usuario === 'Chefe'), 'evento de venda registrado na auditoria');
  assert(r.body.some((e) => e.acao === 'produto-criado'), 'evento de produto criado registrado');

  r = await req('POST', 'caixa/fechar', { dinheiroContado: 35 }, tokenBruno);
  assert(r.status === 200 && r.body.diferenca === 0, 'Bruno fecha o caixa dele');

  r = await req('GET', 'resumo', null, tokenAdmin);
  assert((r.body.caixasAbertos || []).length === 0, 'nenhum caixa aberto após fechamentos');

  r = await req('GET', 'saude');
  assert(r.status === 200 && r.body.precisaSetup === false, 'saúde após setup');

  for (const arq of ['/', '/app.js', '/style.css']) {
    const st = await getArquivo(arq);
    assert(st.status === 200, `estático ${arq}`);
  }

  matarServidor();
  console.log('\nTODOS OS TESTES PASSARAM ✅');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
