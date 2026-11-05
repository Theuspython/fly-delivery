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

A configuração do Railway usa `/health` como verificação do processo. Configure `GOOGLE_MAPS_BROWSER_KEY` nas variáveis do projeto Railway com uma chave de navegador da Maps JavaScript API restrita ao domínio da aplicação. O catálogo público usa `/api/catalog` para verificar também a comunicação com o banco. As chaves e o projeto são configurados por ambiente.

## Primeira operação

1. Nas variáveis do projeto Railway, preencha `FLY_DELIVERY_ADMIN_LOGIN` com o login escolhido (por exemplo, `admin`) e `FLY_DELIVERY_ADMIN_PASSWORD` com a senha. Aplique as alterações e entre na Administração com esses valores. `FD_ADMIN_BRIDGE_TOKEN` autentica a comunicação interna com o Supabase, e `FD_CUSTOMER_LOOKUP_KEY` protege os identificadores de clientes por CPF.
2. Na administração, cadastre o estabelecimento, informe o e-mail do responsável, marque a retirada e escolha se deseja publicar a loja. Cadastre também os entregadores pelo painel.
3. Para contas novas, o painel gera um link individual de ativação. Entregue-o diretamente ao titular da conta para que ele defina a senha. Contas confirmadas existentes são vinculadas pelo e-mail. Na área da loja, cadastre os produtos e abra para pedidos.
4. O cliente cria a conta com nome, CPF, celular e senha. O acesso é feito com CPF e senha. Na vitrine, seleciona itens de uma loja e, no carrinho, marca o endereço, escolhe o pagamento na entrega e envia o pedido. O banco valida o raio e congela os preços confirmados.
5. A loja coloca o pedido em preparo e marca como pronto. O entregador disponível, com o app aberto e GPS a até 15 km da retirada, pode aceitar a oferta. O primeiro aceite válido atribui o pedido e libera o endereço. O entregador confirma a retirada e a entrega.

O acompanhamento do cliente recebe sinais do Supabase Realtime com o app aberto. A área do entregador usa atualização periódica e encaminha a navegação para o aplicativo de mapas. O Pix, cartão e dinheiro são registrados como formas de pagamento na entrega. A transação financeira é realizada entre cliente e estabelecimento. O catálogo contém as lojas reais publicadas.

## Estrutura

- `public/` contém as telas, os manifestos e o service worker. Os mapas usam a API JavaScript do Google Maps, com pino arrastável e opção de GPS.
- `src/server.js` serve os PWAs e encaminha operações autenticadas com cookies HttpOnly e tokens individuais do Supabase.
- `supabase/migrations/` contém o schema isolado, a função de acesso, as regras e o bucket de fotos. As tabelas não são expostas diretamente no Data API.
- `supabase/functions/fd-onboarding/` contém o cadastro administrativo e a ativação. O endpoint valida o token e o papel administrativo antes de usar a credencial de serviço mantida no Supabase.
- `test/` contém verificações HTTP e um roteiro SQL de integração que usa uma transação com rollback. Rode o SQL apenas num ambiente autorizado.

Fotos ilustrativas da vitrine: [hambúrguer](https://images.unsplash.com/photo-1568901346375-23c9450c58cd), [pizza](https://images.unsplash.com/photo-1574071318508-1cdbab80d002), [sushi](https://images.unsplash.com/photo-1579871494447-9811cf80d66c) e [bowl](https://images.unsplash.com/photo-1511690743698-d9d85f2fbf38), via [Unsplash](https://unsplash.com/license).

O CPF é validado no servidor e convertido em um identificador protegido pela variável interna `FD_CUSTOMER_LOOKUP_KEY` do Railway. Preserve essa chave para manter o acesso das contas já criadas. O login interno é gerenciado pelo Supabase Auth.
