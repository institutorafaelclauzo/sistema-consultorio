# Instituto Clauzo na Meta — estado em 22/09/2026

Registro do que já existe na Meta para o WhatsApp deste sistema, e do que falta.
Complementa [ESTADO-DA-INSTALACAO.md](ESTADO-DA-INSTALACAO.md), que trata do Supabase.

## Identificadores criados

| O que | Valor |
| --- | --- |
| Portfólio empresarial | `1119249520656455` (Instituto Clauzo) |
| Conta do WhatsApp Business (WABA) | `1080031411430281` |
| App de desenvolvedor | `1579834743041058` (Instituto Clauzo) |
| Conta de pagamento | `2118602698763194` |
| Usuario do sistema | `61594668690829` (sistema-clauzo, Admin) |
| E-mail administrativo | institutorafaelclauzo@gmail.com |

O portfólio é separado do portfólio do Dr. Marcello. Nenhum ativo do Marcello foi
tocado.

## Dados da empresa registrados na Meta

Vieram do cartão CNPJ, sem invenção de endereço ou contato.

- Razão social: INSTITUTO CLAUZO CLINICA MEDICA LTDA
- CNPJ: 13.543.182/0001-99
- Endereço: R Luiz Antonio de Andrade Vieira, 216, Sala 810, Boqueirão, Praia Grande/SP, 11701-040
- Telefone: +55 13 3474-5471
- Site declarado: https://institutoclauzo.com.br
- Categoria do WhatsApp: Medicina e saúde
- Nome de exibição do WhatsApp: Instituto Clauzo

Sem esses dados a Meta recusa a criação da WABA. O erro que aparece é
"Não foi possível concluir a configuração", e ele não diz qual campo falta.

## Conta de pagamento

Fixada em Brasil, Real brasileiro, fuso São Paulo (GMT-03:00). A Meta não permite
mudar localização nem moeda depois de definidas. Nenhum cartão foi cadastrado:
o formulário aceita Visa, Mastercard e Elo, e quem digita é o responsável pela
clínica.

Caminho: Meta Business Suite, portfólio Instituto Clauzo, Configurações, Contas do
WhatsApp, Instituto Clauzo, "Configurações de pagamento", "Adicionar forma de pagamento".

## Segredos

O arquivo `supabase/functions/.env.clauzo` guarda os segredos do servidor. Está
coberto pelo `.gitignore` (regra `.env.*`) e não deve ser versionado nem colado em
conversa. Já contém `META_APP_ID`, `META_GRAPH_VERSION` e dois segredos gerados
aleatoriamente, `WHATSAPP_VERIFY_TOKEN` e `CRON_SECRET`.

Continuam vazios, porque dependem de passos ainda não feitos:

- `META_APP_SECRET`: painel do app, Configurações do app, Básico. Exige confirmar senha.
- `WHATSAPP_ACCESS_TOKEN`: token permanente do usuário do sistema.
- `WHATSAPP_PROFILE_IMAGE_URL`: só quando houver URL própria para a foto do perfil.

## Pendências, na ordem que resolve

1. **Token do usuário do sistema.** O usuário `sistema-clauzo` já existe, com
   acesso de Admin, e já recebeu o app `1579834743041058` e a WABA
   `1080031411430281` com acesso total. Falta gerar o token, em Usuários do
   sistema, "Gerar token", marcando `whatsapp_business_messaging` e
   `whatsapp_business_management`. O token aparece uma única vez: copiar direto
   para `WHATSAPP_ACCESS_TOKEN` no `.env.clauzo`, sem passar por conversa.
2. **Publicar as Edge Functions** no projeto `zwxrdqztnmacxqmquvti`. Sem a
   `meta-webhook` no ar, a Meta não valida o webhook: ela exige que o endereço
   responda ao desafio na hora da configuração. Depende de acesso à conta
   Supabase do Instituto.
3. **Webhook.** Painel do app, caso de uso do WhatsApp, Etapa 2. URL de callback
   `https://zwxrdqztnmacxqmquvti.supabase.co/functions/v1/meta-webhook`, e o
   token de verificação igual ao `WHATSAPP_VERIFY_TOKEN` do `.env.clauzo`.
   Assinar o campo `messages`.
4. **Número de telefone.** A WABA está sem número. Um número na Cloud API não
   pode estar ativo no app comum do WhatsApp: ou a clínica libera um dos números
   atuais apagando a conta no aplicativo, ou usa um chip novo. O número precisa
   receber SMS ou ligação no momento da verificação.
5. **Verificação da empresa.** O portfólio está "Não verificada". Sem ela o
   número fica limitado a poucas conversas por dia. Exige documento do CNPJ.
6. **Publicar o app.** Enquanto o app não for publicado, ele só recebe webhooks
   de teste disparados pelo painel, nunca dados de produção.

## Cuidados herdados do sistema do Dr. Marcello

O `CLAUDE.md` do `sistema-followup` registra que o lembrete da véspera ficou três
semanas sem disparar por um erro de maiúsculas no nome do segredo do cron, e que
o agendador marcava sucesso mesmo assim. Ao configurar `CRON_SECRET` aqui, conferir
que o nome bate exatamente entre o Vault e as functions, e testar o disparo de
verdade em vez de confiar no status do agendador.

Aquele repositório está duas migrações à frente deste, e uma delas é justamente
`20260920180000_consertar_segredo_do_lembrete.sql`. Este sistema herdou o defeito.
