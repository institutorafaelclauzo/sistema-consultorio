-- Lembrete deixa de ser uma passada por dia e vira uma varredura de hora em
-- hora.
--
-- Com uma passada so, as 10h, quem marcasse depois disso para o dia seguinte
-- nao recebia lembrete nenhum: a unica chance do dia ja tinha passado. Em
-- 31/08/2026 um paciente marcou as 08:56 para o dia seguinte e so recebeu
-- porque faltava pouco mais de uma hora para a varredura.
--
-- A funcao agora olha uma janela continua (de daqui a duas horas ate o limite
-- configurado) e so envia entre 8h e 20h. Cada consulta continua recebendo uma
-- vez so - quem garante isso e o reminder_sent_at, nao o horario do cron.

select cron.unschedule('lembretes-consulta-diario')
where exists (
  select 1 from cron.job where jobname = 'lembretes-consulta-diario'
);

select cron.unschedule('lembretes-consulta')
where exists (
  select 1 from cron.job where jobname = 'lembretes-consulta'
);

-- Aos 20 minutos de cada hora: longe do minuto zero, onde se acumulam as
-- outras tarefas agendadas.
-- Disparo externo desativado na instalação do Clauzo.
-- Ativar somente com supabase/sql/02_ativar_agendamentos.sql após configurar a integração.
