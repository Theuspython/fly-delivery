# Fly Delivery

Marketplace de delivery com três PWAs responsivos e uma operação compartilhada.

| Entrada | Acesso |
| --- | --- |
| `/cliente/` | Vitrine, cardápio, carrinho, endereço digitado e acompanhamento |
| `/loja/` | Catálogo, fotos, disponibilidade e fila de preparo |
| `/admin/` | Cadastro de estabelecimentos com login e senha |

## Rodar localmente

Use Node.js 22 ou mais recente. Configure as variáveis de `.env.example` no ambiente, aplique a migração em um Supabase autorizado e execute:

```sh
npm ci
npm test
npm start
```

A configuração do Railway usa `/health` como verificação do processo. O catálogo público usa `/api/catalog` para verificar também a comunicação com o banco. As chaves e o projeto são configurados por ambiente.

## Primeira operação

1. Nas variáveis do projeto Railway, preencha `FLY_DELIVERY_ADMIN_LOGIN` com o login escolhido (por exemplo, `admin`) e `FLY_DELIVERY_ADMIN_PASSWORD` com a senha. Aplique as alterações e entre na Administração com esses valores. `FD_ADMIN_BRIDGE_TOKEN` autentica a comunicação interna com o Supabase, e `FD_CUSTOMER_LOOKUP_KEY` protege os identificadores de clientes por CPF.
2. Na Administração, crie o estabelecimento com nome, uma ou mais categorias, login e senha inicial. Compartilhe as credenciais em particular com cada titular.
3. Na tela de pedidos, clique em Novos, Em produção ou Em entrega para filtrar a fila. No menu lateral do estabelecimento, use Cadastro de produtos para o cardápio e Perfil da loja para as configurações. Na área da loja, cadastre os produtos, configure a foto ou logo, o endereço do estabelecimento e os horários da semana e publique a loja. O responsável pode trocar a senha em Minha conta.
4. O cliente cria a conta com nome, CPF, celular e senha. O acesso é feito com CPF e senha. Na vitrine, seleciona itens de uma loja e, no carrinho, seleciona o endereço principal ou informa rua, número e bairro de outro endereço, escolhe o pagamento na entrega e envia o pedido. O banco valida o endereço, os itens e os preços confirmados.
5. A loja aceita o pedido e inicia a produção. Ao clicar em **Pronto · saiu para entrega**, o cliente recebe o status **Saiu para entrega**. A loja usa sua própria equipe de entrega e depois confirma **Entregue**. O pedido sai da fila principal e entra nos finalizados e no financeiro.

O acompanhamento do cliente recebe sinais do Supabase Realtime com o app aberto. Não há aplicativo de entregadores, oferta de corridas, GPS ou mapa; os endereços são digitados. O Pix, cartão e dinheiro são registrados como formas de pagamento na entrega. A transação financeira é realizada entre cliente e estabelecimento. O catálogo contém as lojas reais publicadas.

## Estrutura

- `public/` contém as telas, os manifestos e o service worker.
- `src/server.js` serve os PWAs e encaminha operações autenticadas com cookies HttpOnly e tokens individuais do Supabase.
- `supabase/migrations/` contém o schema isolado, a função de acesso, as regras e o bucket de fotos. As tabelas não são expostas diretamente no Data API.
- `supabase/functions/fd-onboarding/` contém o cadastro administrativo, o login e a troca de senha. O endpoint valida o token e o papel administrativo antes de usar a credencial de serviço mantida no Supabase.
- `test/` contém verificações HTTP e um roteiro SQL de integração que usa uma transação com rollback. Rode o SQL apenas num ambiente autorizado.

Fotos ilustrativas da vitrine: [hambúrguer](https://images.unsplash.com/photo-1568901346375-23c9450c58cd), [pizza](https://images.unsplash.com/photo-1574071318508-1cdbab80d002), [sushi](https://images.unsplash.com/photo-1579871494447-9811cf80d66c) e [bowl](https://images.unsplash.com/photo-1511690743698-d9d85f2fbf38), via [Unsplash](https://unsplash.com/license).

O CPF é validado no servidor e convertido em um identificador protegido pela variável interna `FD_CUSTOMER_LOOKUP_KEY` do Railway. Preserve essa chave para manter o acesso das contas já criadas. O login interno é gerenciado pelo Supabase Auth.

O painel inicial do estabelecimento lista os pedidos em andamento. Os finalizados são paginados, e o financeiro soma pedidos entregues por data de conclusão no horário de Brasília. O relatório separa produtos e taxas de entrega.

Coordenadas, vínculos e status antigos são preservados no histórico. Pedidos antigos prontos ou atribuídos continuam na fila da loja, que confirma a saída. Novos pedidos não exigem coordenadas nem passam por atribuição a entregadores.

No cliente, o menu de três pontinhos reúne Pedidos e Endereços. O endereço principal fica salvo na conta do cliente; um endereço usado apenas em uma entrega não substitui o principal. O cardápio permite aumentar e reduzir quantidades, e as categorias rolam para alinhar a opção selecionada.
