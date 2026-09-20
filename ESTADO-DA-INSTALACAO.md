# Instalação do Clauzo — 20/09/2026

Este registro atualiza o estado descrito nos documentos originais da entrega.

## Concluído

- Projeto exclusivo: `institutorafaelclauzo` (`zwxrdqztnmacxqmquvti`), região São Paulo.
- As 69 migrações originais foram aplicadas, mais uma correção de permissões: 70 registros remotos.
- 20 tabelas no esquema público, todas com RLS. Leitura anônima de pacientes recusada pela API (401/42501).
- `.env.local` configurado com a URL e a chave publicável do projeto novo. Nenhuma chave administrativa no frontend.
- Dependências instaladas; `npm run build:standalone` aprovado; `dist/index.html` e `ABRIR-SISTEMA.html` atualizados.
- 766 verificações locais aprovadas: atendimento 671, lembretes 60, prontuário 35.
- Login conferido em navegador: aviso de configuração ausente removido, botão habilitado, sem erros de console. Endpoint de configurações do Auth responde 200.
- Servidor local iniciado em http://127.0.0.1:3000 nesta sessão. Para reiniciar depois, usar INICIAR-SISTEMA.bat.

## Pendente para o primeiro acesso

O usuário administrador `institutorafaelclauzo@gmail.com` ainda não existe no Auth. A clínica ainda não foi inicializada (zero clínicas).

1. No painel do projeto correto, Authentication → Users → Add user → Create new user, cadastrar esse e-mail, escolher a senha e marcar Auto Confirm User. Não compartilhar a senha na conversa.
2. Conferir o UUID e a confirmação do e-mail. Executar `supabase/sql/01_inicializar_clauzo.sql` com esse UUID para criar a clínica, o proprietário e as três unidades.
3. Testar login e os módulos com a conta criada. Nenhum teste de login autenticado ou operação clínica ponta a ponta foi feito nesta etapa.

## Integrações e automações

Funções externas ainda não publicadas/configuradas neste projeto. WhatsApp, Memed, BRy e Groq dependem de contas/segredos próprios e validação posterior.

As três migrações históricas que criavam disparos externos foram ajustadas para não agendá-los durante a instalação. O caminho de ativação posterior continua em `supabase/sql/02_ativar_agendamentos.sql`. Não há cron de envio externo ativo. Permanecem apenas duas rotinas internas: liberar reservas vencidas e destravar conversas antigas. Uma migração adicional retirou a permissão de execução dessas rotinas dos usuários comuns; cron/servidor continuam autorizados.

## Histórico de migrações e GitHub

A aplicação pelo conector Supabase gerou versões remotas com o horário da instalação e guardou o nome completo dos arquivos locais no campo `name`. A revisão automática rejeitou a tentativa de normalizar esses identificadores por considerar a alteração ampla. O histórico remoto foi preservado. Antes de usar `supabase db push`, revisar a correspondência dos 70 registros e resolver explicitamente a divergência; não reaplicar as migrações nem apagar o banco.

GitHub conectado à conta `institutorafaelclauzo`. Repositório de destino: https://github.com/institutorafaelclauzo/sistema-consultorio . A pasta SISTEMA foi inicializada como repositório Git para o envio autorizado do código. O sistema do Dr. Marcello permanece preservado. O envio do código não publica automaticamente a aplicação; a hospedagem ainda precisa ser configurada.

## Conferência de segurança

O verificador do Supabase mantém avisos sobre quatro funções SECURITY DEFINER públicas, necessárias à interface e com validação explícita de membro/editor/proprietário: aprovação/rejeição de acesso, integridade do prontuário e vínculo de conversas. Referência: https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable

Há dois avisos informativos de tabelas de assinatura com RLS sem políticas para usuários; são tabelas internas do servidor, sem acesso de anon/authenticated. Referência: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy

Os hashes da entrega original não representam mais os arquivos editados/compilados nesta instalação.
