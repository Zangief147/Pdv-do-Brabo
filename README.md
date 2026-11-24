# PDV Express — Ponto de Venda

PDV web completo, **sem dependências externas**: exige apenas Node.js 18+.

## Como rodar

```bash
node server.js
```

Abra `http://localhost:3000` no navegador (recomendado em tela cheia/monitor touch).

> Porta alternativa: `PORT=4000 node server.js`

## Funcionalidades

- **Venda (Frente de caixa)**
  - Busca por código ou nome (Enter adiciona direto) + catálogo clicável
  - Carrinho com controle de quantidade, remoção e subtotais
  - Desconto em R$, validação de estoque em tempo real
  - Pagamento fracionado (dinheiro, débito, crédito, PIX) com cálculo de troco
  - Atalho **F2** finalize a venda · **Esc** fecha modais
  - Baixa automática de estoque + cupom não fiscal para impressão
- **Produtos**: cadastro/edição com código, nome, unidade, preço e estoque (alerta de estoque baixo)
- **Histórico**: últimas 200 vendas com reimpressão de cupom
- **Resumo/Caixa**: abertura com fundo de troco, fechamento (sangria), faturamento do dia por forma de pagamento, produtos com estoque crítico

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
├── data/db.json     # base de dados (gerado em runtime)
└── public/
    ├── index.html   # interface
    ├── style.css
    └── app.js       # lógica do frontend
```

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/produtos` | lista produtos |
| POST | `/api/produtos` | cadastra produto |
| PUT | `/api/produtos/:id` | edita produto |
| GET | `/api/produtos/busca?q=` | busca por código/nome |
| POST | `/api/vendas` | registra venda (baixa estoque) |
| GET | `/api/vendas?limite=` | histórico |
| POST | `/api/caixa/abrir` | abre caixa com fundo de troco |
| POST | `/api/caixa/fechar` | fecha caixa |
| GET | `/api/resumo` | resumo do dia |
