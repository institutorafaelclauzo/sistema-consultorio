-- Resposta automatica para quem escreve pela primeira vez no numero da clinica.
--
-- Ate aqui o numero so falava: mandava acompanhamento e esperava resposta. Com
-- o site novo divulgando o WhatsApp, pessoa que nunca foi paciente vai escrever
-- perguntando preco e horario. Sem isso ela ficaria sem resposta ate alguem da
-- equipe abrir a tela.
--
-- Regra deliberada: a resposta NAO sai para quem esta respondendo um
-- acompanhamento. Paciente que escreve "Estou bem, obrigada" nao pode receber
-- de volta uma tabela de precos.

alter table public.clinic_settings
  add column if not exists whatsapp_autoreply_enabled boolean not null default false,
  add column if not exists whatsapp_autoreply_text text not null default '';

comment on column public.clinic_settings.whatsapp_autoreply_enabled is
  'Liga a resposta automatica para quem escreve pela primeira vez.';
comment on column public.clinic_settings.whatsapp_autoreply_text is
  'Texto enviado nessa primeira resposta. Vazio desliga o envio.';

-- A tela precisa poder editar estes dois campos. O update em clinic_settings e
-- liberado coluna a coluna: sem este grant a tela salva sem erro e nada muda.
grant update (whatsapp_autoreply_enabled, whatsapp_autoreply_text)
  on table public.clinic_settings to authenticated;

-- Marca na conversa quando a resposta automatica ja foi enviada, para nao
-- repetir a cada mensagem que a pessoa mandar.
alter table public.whatsapp_conversations
  add column if not exists autoreply_sent_at timestamptz;

comment on column public.whatsapp_conversations.autoreply_sent_at is
  'Quando a resposta automatica de primeiro contato foi enviada nesta conversa.';

-- Texto inicial, exatamente como a recepcao ja envia hoje.
update public.clinic_settings
   set whatsapp_autoreply_text =
'Olá,
Consultório do Dr. Rafael Clauzo, Gastropediatra.

Para adiantar seu atendimento, seguem algumas informações importantes:

O valor da consulta é R$ 450,00 e inclui um retorno em 30 dias.
Não aceitamos convênios médicos, porém fornecemos recibos para seu reembolso.

Agende sua consulta:
13 3273-6828
13 99786-7273

Estamos à disposição para agendar sua consulta ou esclarecer outras dúvidas.
Em caso de urgência, atendemos telemedicina para avaliação inicial e solicitação de exames, se necessário.

Atendemos de segunda a sexta, das 8h às 18h. Mensagens recebidas fora desse horário são respondidas no próximo dia útil.'
 where whatsapp_autoreply_text = '';
