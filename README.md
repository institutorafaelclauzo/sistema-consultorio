# Instituto Clauzo — Central de Cuidado

> Atualização de instalação em 20/09/2026: consulte [ESTADO-DA-INSTALACAO.md](ESTADO-DA-INSTALACAO.md). O banco próprio e a conexão local já foram preparados; falta criar e vincular o administrador. As seções abaixo preservam o contexto e as instruções da entrega original.

Cópia independente do código fornecido em `sistema-followup-BACKUP.rar`, adaptada para o Instituto Clauzo em 20/09/2026. O backup de origem foi usado somente para leitura. Nenhum serviço do Dr. Marcello foi alterado.

## Conteúdo e estado da entrega

Interface responsiva com a marca do Clauzo, preservando os módulos do sistema de referência: pacientes, agenda, consultas, prontuário, acompanhamentos de 15/30/90 dias, administração de acessos e conversas. Inclui código para WhatsApp, lembretes, Memed, assinatura BRy e transcrição Groq; migrações do banco, funções, modelos de e-mail e testes existentes.

O sistema ainda não está instalado em um backend do Clauzo. Login, persistência e integrações exigem serviços próprios. `dist/` e `ABRIR-SISTEMA.html` contêm uma compilação de conferência sem credenciais: exibem a tela de acesso e o aviso de configuração pendente. Abrir o HTML não cria banco/usuários nem permite trabalhar offline. Após configurar `.env.local`, é necessário recompilar.

## Executar no Windows

Use Node.js 22.12 ou superior compatível com Vite 7 e npm. Dentro de `SISTEMA`:

```powershell
Copy-Item .env.example .env.local
npm ci
npm run dev
```

Preencha `.env.local` apenas com a URL e a chave publicável do NOVO projeto Supabase do Clauzo. Abra `http://localhost:3000`. `INICIAR-SISTEMA.bat` também inicia o servidor e instala dependências quando necessário.

## Preparar o banco próprio

1. Crie um projeto Supabase novo e exclusivo para o Clauzo. Não vincule esta cópia ao projeto de origem.
2. Com a CLI Supabase instalada, autentique-se e vincule a pasta usando `supabase link --project-ref SEU_NOVO_PROJECT_REF`. Confira o destino antes de enviar qualquer alteração.
3. Aplique `supabase db push`. A cadeia completa está em `supabase/migrations/`. Usa Auth, Storage, Realtime, Vault, pg_cron e pg_net do Supabase. PostgreSQL comum não basta sem esses serviços.
4. Crie e confirme o e-mail do administrador no Authentication do novo projeto.
5. Em `supabase/sql/01_inicializar_clauzo.sql`, substitua o UUID zerado pelo ID desse administrador e execute no SQL Editor do novo projeto. O instalador exige uma base sem clínicas e cria clínica, associação de proprietário, configurações e três unidades.
6. Configure `.env.local`, reinicie o servidor e entre com esse administrador. O código atual não cria a clínica automaticamente no primeiro login.
7. Configure as URLs de retorno do Auth para o endereço local e, quando existir, o domínio próprio. Os modelos de e-mail estão em `supabase/templates/email/`. Para usar a solicitação de acesso pela tela, habilite o cadastro correspondente no Auth; a liberação da clínica continua dependendo do administrador.

As migrações históricas mantêm a estrutura e a evolução do sistema. O cadastro do Clauzo ocorre somente após toda a cadeia. A última migração deixa automações desativadas e usa segredos próprios no Vault para os endereços dos disparos.

## Integrações opcionais

`supabase/functions/.env.example` lista as variáveis do servidor sem valores privados. Copie para um arquivo local de segredos e preencha com contas próprias. As variáveis `SUPABASE_*` do servidor são fornecidas pelo Supabase hospedado. Segredos e chaves administrativas nunca pertencem ao frontend.

- Publique as funções com `supabase functions deploy` no projeto novo e configure os segredos próprios. Preserve as opções de autenticação de `supabase/config.toml`.
- WhatsApp: configure o número/Phone Number ID e modelos aprovados nas preferências da clínica, token, aplicativo Meta e webhook `meta-webhook`. Verifique o token de validação e a assinatura do webhook. Os telefones das unidades são contatos, não IDs de integração.
- Memed, BRy e Groq: configure contas, dados do prescritor e credenciais quando utilizar essas funções. BRy exige URL de retorno própria. A imagem do perfil do WhatsApp precisa de URL própria se usada.
- Automações: depois de validar as integrações, crie no Vault `clauzo_supabase_url` (URL do novo projeto) e `cron_secret` (segredo próprio de pelo menos 32 caracteres). Use o mesmo segredo como `CRON_SECRET` nas funções. Só então execute `supabase/sql/02_ativar_agendamentos.sql` e habilite as opções desejadas na interface.

Não há publicação automática configurada. Nenhuma mensagem foi enviada durante esta preparação.

## Dados para revisar

Identidade: Dr. Rafael Volpini Clauzo, CRM-SP 126235. Contatos trazidos do site:

| Unidade | Telefone |
| --- | --- |
| São Paulo | (11) 94875-7371 |
| São Bernardo do Campo | (11) 99485-0797 |
| Baixada Santista | (11) 96573-9677 |

Endereços, horários, valores, convênios, faixa etária, dados fiscais, canais de privacidade e regras de atendimento devem ser preenchidos/revisados pela equipe. O campo de convênio vazio é tratado pelo código herdado como atendimento particular; revise antes de ativar o agendamento automático. As respostas informativas iniciais ficam inativas até revisão. Casos pediátricos e marcas de convênios nos testes são exemplos fictícios de regressão, não informações do Instituto.

## Compilar e conferir

```powershell
npm run test:bot
npm run build:standalone
```

`GERAR-VERSAO.bat` executa a compilação. Para hospedar, publique `dist/` após configurar o projeto próprio e recompilar. O arquivo único é uma conveniência de conferência; para autenticação e integrações, use o servidor local ou hospedagem HTTP(S).

Na entrega: compilação TypeScript/Vite aprovada; 766 verificações automatizadas aprovadas; sintaxe de 71 arquivos SQL conferida. Os testes usam simulações locais. A instalação real do banco e as integrações externas não foram executadas nem validadas ponta a ponta.

Leia `CONTINUAR-EM-OUTRA-IA.md` para o mapa dos arquivos e próximos passos.
