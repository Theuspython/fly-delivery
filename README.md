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

No cliente, o menu lateral de três traços reúne Pedidos e Endereços, com o mesmo estilo do estabelecimento. Os cards de pedidos ficam recolhidos e exibem os detalhes ao clicar em Visualizar. O endereço principal fica salvo na conta do cliente; um endereço usado apenas em uma entrega não substitui o principal. O cardápio permite aumentar e reduzir quantidades, e as categorias rolam para alinhar a opção selecionada.

Minha conta fica no menu lateral do cliente e permite enviar uma foto JPG, PNG ou WebP de até 3 MB. As fotos usam armazenamento privado, com leitura pelo próprio cliente e pelos estabelecimentos com pedidos desse cliente. A casinha no cabeçalho retorna à vitrine completa sem alterar o carrinho.

Na administração, Editar altera nome e categorias do estabelecimento. Excluir retira a loja da vitrine e da operação, mantém produtos e pedidos finalizados no histórico e bloqueia o acesso se não houver outra loja vinculada. Pedidos em andamento precisam ser finalizados ou cancelados antes da exclusão.

O botão Instalar app captura a disponibilidade de instalação antes da consulta de login e solicita a confirmação nativa nos navegadores compatíveis. Se a liberação chegar depois do clique, o botão da janela fica disponível para confirmar. No Safari do iPhone/iPad, são exibidas as instruções de Compartilhar e Adicionar à Tela de Início. A janela nativa depende da elegibilidade e do suporte do navegador.

As categorias dos estabelecimentos aparecem em etiquetas acima do nome na vitrine. Cada produto recebe uma categoria dentre as cadastradas para sua loja, e o cliente pode filtrar o cardápio por essas categorias. Produtos anteriores de lojas com múltiplas categorias continuam disponíveis em Todas e Outros itens até o responsável classificá-los em Editar; a lista da loja sinaliza Categoria pendente.

O estabelecimento pode ativar **Opcionais do produto** ao cadastrar ou editar, com até 20 adicionais de nome e valor por produto. Cada opcional selecionado é aplicado uma vez a cada unidade daquela combinação. O cliente abre Opcionais no cardápio, seleciona os adicionais e usa os controles de quantidade. Combinações diferentes ficam em linhas distintas no carrinho e no pedido. O banco confere os preços e preserva nomes e valores no histórico mesmo após alterações do cardápio.

Na vitrine, as etiquetas de categorias ficam em uma única linha deslizável, e a ordem das categorias começa por Hambúrguer, Pizza, Marmitex, Açaí e Telecerveja. A busca considera lojas, produtos, descrições e opcionais, ignora acentos e aceita pequenos erros de digitação. O campo usa fonte de 16 px para evitar o zoom automático no foco em celulares.

O cadastro/edição permite ativar **O item possui tamanhos diferentes**, marcar os tamanhos disponíveis entre P, M e G e informar seus preços. O preço inicial do catálogo é o menor entre os tamanhos; o carrinho e o banco usam o valor do tamanho escolhido mais os opcionais. Tamanhos e combinações diferentes são separados no pedido e preservados no histórico.

O cliente pode escrever uma observação opcional de até 500 caracteres antes de confirmar o pedido. A observação aparece nos detalhes para o cliente e o estabelecimento. Os detalhes também separam Produtos, Entrega e Total. Os filtros Novos, Em produção e Em entrega compartilham as cores de status dos cards.

## Faturas Fly Delivery

O menu do estabelecimento começa por **Faturas Fly Delivery**, seguido de pedidos, produtos e relatórios. O menu da administração reúne **Estabelecimentos** e **Clientes**. A administração pode suspender ou reativar uma loja; a suspensão oculta a loja da vitrine e bloqueia novos pedidos, mantendo o acesso às faturas e o atendimento dos pedidos já recebidos.

A administração define e confirma a comissão global, de 0 a 100%, com duas casas decimais. A taxa vale para os próximos pedidos entregues de todos os estabelecimentos. Cada entrega registra a taxa e o valor da comissão daquele pedido; mudanças posteriores não recalculam comissões já registradas. A base é o subtotal dos produtos, incluindo tamanhos e opcionais, sem a entrega. Pedidos cancelados e vendas anteriores à ativação da cobrança não geram comissão.

As faturas agrupam as entregas por dia civil em `America/Sao_Paulo`: fechamento à meia-noite e vencimento às 12h do dia seguinte. O processo do servidor verifica fechamentos a cada 30 segundos e recupera dias pendentes ao reiniciar; abrir a área de faturas também fecha dias anteriores de forma idempotente. A fatura do dia é uma prévia e não pode ser paga antes do fechamento. Faturas vencidas ficam destacadas. Suspender e reativar estabelecimentos são ações da administração; o pagamento não remove por conta própria uma suspensão administrativa.

No serviço Fly Delivery do Railway, configure `INFINITEPAY_API_KEY` e `INFINITEPAY_HANDLE` com os valores da mesma conta usada no Flycar Novo e preserve `APP_ORIGIN` como a origem HTTPS do Fly Delivery. A integração cria checkouts Pix com identificação `flydelivery-daily-`, retorno em `/loja/?invoice_return=1` e webhook em `/api/infinitepay/webhook`. Ela confere `paid` e o valor original em centavos em `/payment_check` antes de marcar uma fatura como paga. As faturas e identificadores do Flycar não são alterados nem processados pelo webhook Delivery.

`FD_BILLING_BRIDGE_TOKEN` é uma credencial exclusiva do backend, comparada com seu SHA-256 em `fly_delivery.billing_config`; não deve ir para o navegador. A função pública de ponte usa `SECURITY INVOKER` e delega as operações financeiras à função do schema privado, que valida a credencial. Nenhuma tabela financeira dá acesso direto a `anon` ou `authenticated`. Não coloque valores reais em arquivos versionados.

A cobrança começa somente quando a comissão está definida e o servidor encontra a configuração InfinitePay. Enquanto as credenciais estão ausentes ou com `PREENCHER`, não são registradas novas comissões; suspensões e reativações pela administração continuam disponíveis. O provisionamento inicial deixa a taxa sem valor até a confirmação pelo administrador.

Além de `npm test`, os roteiros `test/daily_billing.sql`, `test/sizes_order_notes.sql` e `test/product_options.sql` usam transações com rollback para validar o banco autorizado. Os testes de pagamento usam respostas simuladas da InfinitePay; não realizam pagamentos reais.
