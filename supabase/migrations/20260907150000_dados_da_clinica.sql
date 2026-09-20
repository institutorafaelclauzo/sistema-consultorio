begin;

/**
 * Telefone da clinica como dado, e nao como constante no codigo.
 *
 * Ele vai impresso na receita da Memed e no cadastro do prescritor. Estava
 * fixo em dois arquivos; uma clinica nova, ou uma troca de numero, exigiria
 * um programador. Passa a morar aqui, ao lado do nome e do CRM do medico, e a
 * ser editado em Preferencias.
 */
alter table public.clinic_settings
  add column if not exists clinic_phone text not null default '';

comment on column public.clinic_settings.clinic_phone is
  'Telefone de contato da clinica, como deve aparecer em receitas e cadastros externos.';

grant update (clinic_phone) on table public.clinic_settings to authenticated;

-- Preenche a clinica que ja existe com o numero que estava no codigo.
-- Atualização de dados exclusiva do sistema de origem omitida nesta cópia.

commit;
