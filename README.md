# Fly Delivery

Marketplace de delivery com quatro PWAs responsivos e uma operação compartilhada.

| Entrada | Acesso |
| --- | --- |
| `/cliente/` | Vitrine, cardápio, carrinho, endereço com pino e acompanhamento |
| `/loja/` | Catálogo, fotos, disponibilidade e fila de preparo |
| `/entregador/` | Disponibilidade por GPS, ofertas próximas, retirada e entrega |
| `/admin/` | Cadastro de lojas, habilitação de entregadores e acompanhamento dos pedidos |

## Rodar localmente

Use Node.js 22 ou mais recente. Configure as variáveis de `.env.example` no ambiente, aplique a migração em um Supabase autorizado e execute:

```sh
npm ci
npm test
npm start
```

A configuração do Railway usa `/health` como verificação do processo. O catálogo público usa `/api/catalog` para verificar também a comunicação com o banco. As chaves e o projeto são configurados por ambiente.

## Primeira operação

1. Cadastre ou use contas com e-mail confirmado pelo Supabase. Para inicializar a administração em um novo banco, um operador do banco atribui o papel `admin` em `fly_delivery.accounts` ao UUID da conta confirmada.
2. No painel administrativo, cadastre uma loja, associe a conta do responsável, marque a retirada no mapa e ative a publicação.
3. Na área da loja, cadastre os produtos e abra para pedidos. Na administração, habilite a conta confirmada do motoboy.
4. O cliente seleciona itens de uma loja, marca o endereço, escolhe o pagamento na entrega e envia o pedido. O banco valida o raio e congela os preços confirmados.
5. A loja coloca o pedido em preparo e marca como pronto. O entregador disponível, com o app aberto e GPS a até 15 km da retirada, pode aceitar a oferta. O primeiro aceite válido atribui o pedido e libera o endereço. O entregador confirma a retirada e a entrega.

O fluxo piloto usa atualização periódica com o app aberto e encaminha a navegação para o aplicativo de mapas. O Pix, cartão e dinheiro são registrados como formas de pagamento na entrega. A transação financeira é realizada entre cliente e estabelecimento. As lojas demonstrativas somem quando a primeira loja real é publicada.

## Estrutura

- `public/` contém as telas, os manifestos e o service worker. Os mapas usam Leaflet com OpenStreetMap e atribuição visível.
- `src/server.js` serve os PWAs e encaminha operações autenticadas com cookies HttpOnly e tokens individuais do Supabase.
- `supabase/migrations/` contém o schema isolado, a função de acesso, as regras e o bucket de fotos. As tabelas não são expostas diretamente no Data API.
- `test/` contém verificações HTTP e um roteiro SQL de integração que usa uma transação com rollback. Rode o SQL apenas num ambiente autorizado.

Fotos ilustrativas da vitrine: [hambúrguer](https://images.unsplash.com/photo-1568901346375-23c9450c58cd), [pizza](https://images.unsplash.com/photo-1574071318508-1cdbab80d002), [sushi](https://images.unsplash.com/photo-1579871494447-9811cf80d66c) e [bowl](https://images.unsplash.com/photo-1511690743698-d9d85f2fbf38), via [Unsplash](https://unsplash.com/license).
