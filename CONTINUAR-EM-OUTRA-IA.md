# Continuidade do sistema Instituto Clauzo

> Antes de continuar, leia [ESTADO-DA-INSTALACAO.md](ESTADO-DA-INSTALACAO.md): contém o projeto Supabase instalado, as verificações realizadas e as pendências atuais, incluindo o administrador e a divergência dos identificadores de migração.

O usuário pediu uma cópia do sistema do Dr. Marcello adaptada ao Instituto Clauzo, preservando o original, para continuar as edições em outra IA. Destino desejado: `C:\Users\Edu\Desktop\DR RAFAL CLAUZO\SISTEMA`. O site independente acompanha em `..\SITE`.

## Base e mapa dos arquivos

React 19, TypeScript, Vite 7, Tailwind, Radix e Supabase. Backend em Deno. Layout e módulos vêm do backup fornecido pelo usuário, com marca e textos adaptados. Não houve reconstrução simplificada do sistema.

| Onde | Conteúdo |
| --- | --- |
| `src/components/Brand.tsx`, `src/assets/logo-clauzo.png` | Identidade visual |
| `src/pages/` | Login, recuperação de senha e estrutura principal |
| `src/sections/` | Dashboard, pacientes, agenda, prontuário, conversas e configurações |
| `src/lib/repository.ts`, `src/types/database.ts` | Persistência e tipos |
| `src/auth/AuthProvider.tsx`, `src/lib/supabase.ts` | Autenticação e configuração |
| `supabase/migrations/` | Estrutura, políticas e histórico do banco |
| `supabase/sql/` | Inicialização do Clauzo e ativação opcional do cron |
| `supabase/functions/` | WhatsApp, lembretes, prescrição, assinatura e áudio |
| `tests/` | Regressão do bot, lembretes e textos do prontuário |

## Alterações desta adaptação

Nome, logo, entrada, rodapé, e-mails, médico e contatos foram adaptados. A chave local de autenticação é `instituto-clauzo-auth`. Foram retirados da cópia credenciais, caches de projeto vinculado, arquivos pessoais temporários e scripts de publicação do projeto de origem. Destinos de disparo dependem do Vault novo; URLs de retorno e de imagem de perfil não apontam para a hospedagem antiga.

O instalador cria três unidades com contatos conhecidos, sem inventar endereços ou condições comerciais. As perguntas do bot dirigem-se ao paciente sem pressupor atendimento pediátrico. O prazo de resposta médica passou a depender de confirmação da equipe. A expectativa de teste foi ajustada e o teste de atendimento agora retorna falha de processo se houver verificações reprovadas. Os testes contêm cenários fictícios herdados, inclusive pediatria e convênios.

## Próximos passos

Seguir README.md: criar backend próprio, aplicar migrações, criar administrador, executar inicializador e configurar integrações. Revisar textos, convênios, agendas, modelos de WhatsApp e páginas de privacidade com os responsáveis. Testar login, permissões, cadastro, agenda e integrações no ambiente novo antes da publicação.

Nenhum banco ou serviço externo foi copiado. Não reutilizar pacientes, segredos, contas ou projetos do Dr. Marcello. Esta preparação não comprova operação real das integrações.

## Prompt para outra IA

“Leia README.md e CONTINUAR-EM-OUTRA-IA.md. Continue o sistema Instituto Clauzo nesta pasta, preservando módulos e permissões. O sistema de referência do Dr. Marcello não pode ser alterado. Esta entrega compila, mas precisa de backend e integrações próprios. Confira o destino de qualquer operação remota. Não invente dados clínicos, convênios ou credenciais. Aplique as alterações que eu pedir e valide o que elas afetarem.”
