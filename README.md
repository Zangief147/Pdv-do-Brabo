# PDV Express — Ponto de Venda v2

PDV web completo com **zero dependências externas**: exige apenas Node.js 18+.

## Como rodar

```bash
node server.js
```

Abra `http://localhost:3000` no navegador.

> Porta alternativa: `PORT=4000 node server.js` · Testes: `node teste.js`

## Primeiro acesso

Ao abrir o sistema pela primeira vez, a tela inicial pede a criação do **usuário administrador** (nome, login e senha). Depois, na aba **Operadores**, você cadastra os demais usuários.

| Cargo | Permissões |
|---|---|
| **Administrador** | Tudo: produtos, relatórios, operadores, cancelar vendas, configurações, backup |
| **Operador** | Vender, abrir/fechar caixa, sangria e suprimento |

## Funcionalidades

- **Venda (Frente de caixa)**
  - Busca por código ou nome (Enter adiciona direto) + catálogo clicável
  - Carrinho com controle de quantidade, remoção e subtotais
  - Desconto em R$, campo de cliente, validação de estoque em tempo real
  - Pagamento fracionado (dinheiro, débito, crédito, PIX) com cálculo de troco
  - Atalhos: **F1** foca a busca · **F2** finaliza · **F4** cancela a venda · **Esc** fecha modais
  - Baixa automática de estoque + cupom não fiscal para impressão
- **Produtos**: cadastro/edição com código, nome, unidade, preço e estoque (alerta de estoque baixo)
- **Cancelamento de venda** (admin): com motivo, **estorna o estoque** e sai do faturamento
- **Caixa**: abertura com fundo de troco, **sangria e suprimento** com motivo, fechamento com **conferência** (dinheiro esperado × contado, diferença calculada e arquivada)
- **Relatórios** (admin): por período, com faturamento, ticket médio, descontos, vendas canceladas, valores por forma de pagamento, faturamento por dia, **produtos mais vendidos** e últimos fechamentos — com **exportação CSV** (Excel pt-BR) e **impressão**
- **Histórico**: últimas 200 vendas com reimpressão de cupom e cancelamento (admin)
- **Operadores** (admin): criar, editar, trocar senha, desativar e excluir usuários; sessões invalidadas ao desativar ou trocar senha
- **Ajustes** (admin): dados da loja no cupom (nome, CNPJ, endereço, telefone), mensagem personalizada e **backup do banco em JSON**
- **Segurança**: senhas com scrypt + salt, sessões com expiração (12h), preços validados no servidor, todas as rotas exigem login

## Dados

Persistidos em `data/db.json` (escrita atômica). Para recomeçar do zero:

```bash
rm -rf data
```

## Estrutura

```
pdv/
├── server.js        # API REST + servidor estático (http puro)
├── db.js            # persistência JSON
├── teste.js         # 53 testes end-to-end
├── data/db.json     # base de dados (gerado em runtime)
└── public/
    ├── index.html   # interface (7 abas)
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
| POST/PUT/DELETE | `/api/produtos[/:id]` | admin | CRUD de produtos |
| POST | `/api/vendas` | logado | registra venda (baixa estoque) |
| GET | `/api/vendas?limite=` | logado | histórico |
| POST | `/api/vendas/:id/cancelar` | admin | cancela + estorna estoque |
| POST | `/api/caixa/abrir` / `fechar` | logado | abertura/fechamento conferido |
| POST | `/api/caixa/movimentacao` | logado | sangria / suprimento |
| GET | `/api/resumo` | logado | resumo do dia |
| GET | `/api/relatorios?de=&ate=` | admin | relatório do período |
| GET | `/api/relatorios/csv?de=&ate=` | admin | CSV das vendas |
| GET | `/api/operadores` · POST/PUT/DELETE | admin | gestão de usuários |
| GET | `/api/backup` | admin | download do banco |

## Nota sobre emissão fiscal

O cupom é **não fiscal**. Emissão de NFC-e/SAT exige credenciamento na SEFAZ e certificado digital — pode ser plugado nesta base futuramente.
