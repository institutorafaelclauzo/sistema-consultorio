-- Aplicar a cadeia de migrações em projeto novo e exclusivo do Instituto Clauzo.
begin;

alter table public.clinic_settings
  alter column telemedicine_enabled set default false,
  alter column appointment_reminder_enabled set default false,
  alter column whatsapp_autoreply_enabled set default false;

-- Os agendamentos só devem ser ativados após a configuração dos serviços próprios.
select cron.unschedule(jobid) from cron.job
where jobname in ('disparo-acompanhamentos-diario', 'lembretes-consulta-diario', 'lembretes-consulta');

create or replace function private.dispatch_whatsapp_followups()
returns void language plpgsql security definer set search_path = '' as $$
declare secret text; project_url text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  select rtrim(decrypted_secret, '/') into project_url from vault.decrypted_secrets where name = 'clauzo_supabase_url' limit 1;
  if secret is null or project_url is null then return; end if;
  perform net.http_post(url := project_url || '/functions/v1/whatsapp-dispatch',
    body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 120000);
end;
$$;

create or replace function private.dispatch_appointment_reminders()
returns void language plpgsql security definer set search_path = '' as $$
declare secret text; project_url text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  select rtrim(decrypted_secret, '/') into project_url from vault.decrypted_secrets where name = 'clauzo_supabase_url' limit 1;
  if secret is null or project_url is null then return; end if;
  perform net.http_post(url := project_url || '/functions/v1/appointment-reminders',
    body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 120000);
end;
$$;

revoke all on function private.dispatch_whatsapp_followups() from public, anon, authenticated;
revoke all on function private.dispatch_appointment_reminders() from public, anon, authenticated;
commit;
