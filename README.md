# PDV Express — Ponto de Venda v4.1

PDV web completo com **zero dependências externas**: exige apenas Node.js 18+.

## Como rodar

```bash
node server.js
```

Abra `http://localhost:3000` no navegador.

> Porta/host alternativos: `PORT=4000 HOST=0.0.0.0 node server.js` · Testes: `node teste.js`

## Primeiro acesso

Ao abrir o sistema pela primeira vez, a tela inicial pede a criação do **usuário administrador** (nome, login e senha). Depois, na aba **Operadores**, você cadastra os demais usuários.

| Cargo | Permissões |
|---|---|
| **Administrador** | Tudo: produtos, clientes, relatórios com lucro, operadores, cancelar vendas, auditoria, configurações, backup |
| **Operador** | Vender (incl. fiado), abrir/fechar o próprio caixa, sangria e suprimento, clientes |

## Funcionalidades

- **Venda (Frente de caixa)**
  - Busca por código ou nome (Enter adiciona direto) + catálogo clicável
  - Carrinho com controle de quantidade, remoção e subtotais
  - Desconto em R$, campo de cliente, validação de estoque em tempo real
  - Pagamento fracionado (dinheiro, débito, crédito, PIX) com cálculo de troco
  - Atalhos: **F1** foca a busca · **F2** finaliza · **F4** cancela a venda · **Esc** fecha modais
  - Baixa automática de estoque + cupom não fiscal para impressão
- **Multi-caixa**: **um caixa por operador** — vários caixas podem ficar abertos ao mesmo tempo (painel "Caixas abertos agora" no resumo); cada abertura, sangria, suprimento e fechamento é isolado por operador, e vendas antigas de caixa único são migradas automaticamente
- **Produtos**: cadastro/edição com código, nome, unidade, **custo**, preço e estoque (alerta de estoque baixo), **entrada rápida de estoque** e **importação em massa por CSV** (`codigo;nome;preco;estoque;unidade;custo`, atualiza existentes pelo código)
- **Clientes e fiado**: cadastro, venda parcial ou total em fiado (exige cliente escolhido), saldo por cliente, **recebimento com extrato** (dinheiro recebido entra no caixa de quem recebeu automaticamente), bloqueio de exclusão com dívida aberta
- **Leitor de balança**: códigos EAN de peso (2 + 5 dígitos do produto + peso em gramas) adicionam a quantidade correta automaticamente
- **Cancelamento de venda** (admin): com motivo, **estorna o estoque e o fiado** e sai do faturamento
- **Caixa**: abertura com fundo de troco, **sangria e suprimento** com motivo, fechamento com **conferência** (dinheiro esperado × contado, diferença calculada e arquivada) + **backup automático do banco** a cada fechamento (média de 30 arquivos em `data/backups/`)
- **Relatórios** (admin): por período, com faturamento, **lucro estimado** (preço − custo por item, registrado no momento da venda), ticket médio, descontos, fiado a receber, vendas canceladas, valores por forma de pagamento, faturamento **e lucro por dia** com **gráfico de barras**, **produtos mais vendidos** e últimos fechamentos — com **exportação CSV** (Excel pt-BR) e **impressão**
- **Auditoria** (admin): registro automático de eventos sensíveis (setup, login, venda, cancelamento, caixa, fiado, produtos, operadores, configuração) em `data/auditoria.log`, visível na aba Ajustes ou via `GET /api/auditoria`
- **Histórico**: últimas 200 vendas com reimpressão de cupom e cancelamento (admin)
- **Operadores** (admin): criar, editar, trocar senha, desativar e excluir usuários; sessões invalidadas ao desativar ou trocar senha
- **Ajustes** (admin): dados da loja no cupom (nome, CNPJ, endereço, telefone), mensagem personalizada e **backup do banco em JSON**
- **Ordens de serviço**: aba própria com CRUD (cliente, aparelho/item, descrição, valor orçado) e fluxo de status (aberta → em andamento → pronta → entregue, ou cancelada), filtro por texto e por status; exclusão só para admin, tudo registrado na auditoria
- **Cupom com logo**: o admin envia a logo da loja em **Ajustes** (recebida, redimensionada e salva no banco); sai no topo de todos os cupons impressos
- **Teclado de toque**: clicar na quantidade de um item do carrinho abre um **teclado numérico grande** para digitar a quantidade exata (ideal para tablet/balança), com vírgula decimal e correção
- **Segurança**: senhas com scrypt + salt, sessões com expiração (12h), preços validados no servidor, todas as rotas exigem login, limitador de tentativas no login (8 erros em 5 min bloqueiam temporariamente), graceful shutdown (SIGINT/SIGTERM preservam o banco)

## Dados

Persistidos em `data/db.json` (escrita atômica). Para recomeçar do zero:

```bash
rm -rf data
```

## Estrutura

```
pdv/
├── server.js        # API REST + servidor estático (http puro)
├── db.js            # persistência JSON (inclui migração de caixa único → multi-caixa)
├── teste.js         # 112 testes end-to-end
├── data/db.json     # base de dados (gerado em runtime)
├── data/auditoria.log  # trilha de auditoria (JSON por linha)
└── public/
    ├── index.html   # interface (9 abas)
    ├── style.css
    └── app.js       # lógica do frontend
```

## API

| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/api/saude` | pública | status + precisa de setup? |
| POST | `/api/setup` | pública (só 1ª vez) | cria o administrador |
| POST | `/api/login` / `/api/logout` | pública / logado | sessões (Bearer token) |
| GET | `/api/me` | logado | usuário atual |
| GET | `/api/configuracao` | logado | dados para o cupom |
| PUT | `/api/configuracao` | admin | altera loja/molde do cupom |
| GET | `/api/produtos` · `/api/produtos/busca?q=` | logado | listagem e busca |
| POST/PUT/DELETE | `/api/produtos[/:id]` | admin | CRUD de produtos (com custo) |
| POST | `/api/vendas` | logado | registra venda no caixa do operador |
| GET | `/api/vendas?limite=` | logado | histórico |
| POST | `/api/vendas/:id/cancelar` | admin | cancela + estorna estoque |
| POST | `/api/caixa/abrir` / `fechar` | logado | abertura/fechamento conferido (próprio caixa) |
| POST | `/api/caixa/movimentacao` | logado | sangria / suprimento |
| GET | `/api/resumo` | logado | resumo do dia + caixas abertos |
| GET | `/api/relatorios?de=&ate=` | admin | relatório do período (com lucro) |
| GET | `/api/relatorios/csv?de=&ate=` | admin | CSV das vendas |
| GET | `/api/auditoria?limite=` | admin | trilha de auditoria |
| GET | `/api/operadores` · POST/PUT/DELETE | admin | gestão de usuários |
| GET | `/api/backup` | admin | download do banco |
| GET/POST | `/api/clientes` | logado | cadastro de clientes |
| GET/PUT/DELETE | `/api/clientes/:id` | logado / DELETE admin | cliente + extrato |
| POST | `/api/clientes/:id/receber` | logado | recebimento de fiado |
| POST | `/api/produtos/:id/entrada` | admin | entrada de estoque |
| POST | `/api/produtos/importar` | admin | importação em massa (CSV) |
| GET/POST | `/api/os` | logado | listagem (filtro `?status=`) e criação de ordens de serviço |
| PUT/DELETE | `/api/os/:id` | logado / DELETE admin | status/valor da ordem; exclusão só admin |

## Nota sobre emissão fiscal

O cupom é **não fiscal**. Emissão de NFC-e/SAT exige credenciamento na SEFAZ e certificado digital — pode ser plugado nesta base futuramente.
