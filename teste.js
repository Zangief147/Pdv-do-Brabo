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
  const servidor = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: '3123' }, stdio: 'ignore' });
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
  assert(r.status === 400 && r.body.erro === 'Abra o caixa antes de vender', 'venda com caixa fechado rejeitada');

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
