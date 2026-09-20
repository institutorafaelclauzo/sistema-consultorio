-- Disparo automatico diario dos acompanhamentos vencidos.
--
-- Ate aqui o sistema so enviava quando alguem clicava em "Enviar agora", o que
-- contraria a premissa dele: "no dia certo, o sistema envia". Este agendamento
-- resolve isso.
--
-- O segredo de autenticacao fica no Vault do Supabase, nunca no corpo do job -
-- a definicao de um job do pg_cron e legivel por qualquer um com acesso ao banco.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Funcao que o cron chama. Le o segredo do Vault e chama a Edge Function.
create or replace function private.dispatch_whatsapp_followups()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text;
begin
  select decrypted_secret into secret
  from vault.decrypted_secrets
  where name = 'cron_secret'
  limit 1;

  if secret is null then
    raise warning 'cron_secret ausente no Vault; disparo automatico ignorado';
    return;
  end if;

  -- A funcao vive no esquema net e recebe a url como text. Com search_path
  -- vazio, o cast explicito e obrigatorio.
  perform net.http_post(
    url := ((select rtrim(decrypted_secret, '/') from vault.decrypted_secrets where name = 'clauzo_supabase_url' limit 1) || '/functions/v1/whatsapp-dispatch')::text,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function private.dispatch_whatsapp_followups() from public, anon, authenticated;

-- Todo dia as 12:00 UTC = 09:00 em Brasilia. Horario comercial de proposito:
-- mensagem de clinica nao deve chegar de madrugada.
select cron.unschedule('disparo-acompanhamentos-diario')
where exists (
  select 1 from cron.job where jobname = 'disparo-acompanhamentos-diario'
);

-- Disparo externo desativado na instalação do Clauzo.
-- Ativar somente com supabase/sql/02_ativar_agendamentos.sql após configurar a integração.
