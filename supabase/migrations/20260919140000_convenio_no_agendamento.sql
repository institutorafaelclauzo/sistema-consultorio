begin;

-- Estrutura para convênios por unidade. Dados comerciais devem ser configurados pelo Instituto Clauzo.

alter table public.clinic_units
  add column if not exists accepts_insurance text not null default '';

comment on column public.clinic_units.accepts_insurance is
  'Nome do convenio aceito nesta unidade. Vazio = so particular, e o robo nao pergunta.';

alter table public.appointments
  add column if not exists insurance text not null default '';

comment on column public.appointments.insurance is
  'Convenio informado no agendamento. Vazio = particular.';

alter table public.whatsapp_conversations
  add column if not exists booking_insurance text;

comment on column public.whatsapp_conversations.booking_insurance is
  'Resposta do convenio enquanto o agendamento esta em andamento.';

-- Nenhum convênio é cadastrado automaticamente nesta cópia.
commit;
