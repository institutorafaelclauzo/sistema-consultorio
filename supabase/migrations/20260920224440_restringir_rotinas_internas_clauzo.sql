-- Rotinas globais são executadas pelo cron e pelas funções do servidor.
-- A interface não as chama; usuários autenticados não precisam desse acesso.
begin;
revoke execute on function public.liberar_reservas_vencidas() from public, anon, authenticated;
revoke execute on function public.liberar_conversas_travadas() from public, anon, authenticated;
grant execute on function public.liberar_reservas_vencidas() to service_role;
grant execute on function public.liberar_conversas_travadas() to service_role;
commit;
