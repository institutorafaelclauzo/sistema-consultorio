-- OPCIONAL. Execute apenas no projeto Clauzo depois de validar as integrações.
-- Antes: configurar cron_secret e clauzo_supabase_url no Vault deste projeto.
-- Configurar também CRON_SECRET nas Edge Functions com o mesmo segredo.
do $$
begin
  if not exists(select 1 from vault.decrypted_secrets where name = 'cron_secret' and length(decrypted_secret) >= 32)
    or not exists(select 1 from vault.decrypted_secrets where name = 'clauzo_supabase_url' and decrypted_secret like 'https://%') then
    raise exception 'Configure os dois segredos próprios no Vault antes de ativar.';
  end if;
end;
$$;
select cron.unschedule(jobid) from cron.job where jobname in ('disparo-acompanhamentos-diario','lembretes-consulta');
select cron.schedule('disparo-acompanhamentos-diario', '0 12 * * *', $$select private.dispatch_whatsapp_followups()$$);
select cron.schedule('lembretes-consulta', '20 * * * *', $$select private.dispatch_appointment_reminders()$$);
