begin;

/**
 * O perfil do WhatsApp vira dado, e não texto fixo no código.
 *
 * É o cartão de visita que a família vê ao tocar no nome da conversa: site,
 * endereço, descrição e e-mail. Nasceu ontem como constante dentro da função
 * que grava na Meta, o que é aceitável para o site (que não muda) e ruim para
 * o endereço: sala, prédio e até a unidade mudam com frequência, e cada troca
 * exigiria um programador e uma publicação.
 *
 * Agora mora aqui, ao lado do telefone e do CRM, e é editado em Preferências.
 * Quem escreve é a clínica; o sistema só entrega à Meta.
 */

alter table public.clinic_settings
  add column if not exists whatsapp_profile_about text not null default '',
  add column if not exists whatsapp_profile_address text not null default '',
  add column if not exists whatsapp_profile_description text not null default '',
  add column if not exists whatsapp_profile_email text not null default '',
  add column if not exists whatsapp_profile_website text not null default '';

comment on column public.clinic_settings.whatsapp_profile_about is
  'Recado curto do perfil do WhatsApp (limite de 139 caracteres na Meta).';
comment on column public.clinic_settings.whatsapp_profile_address is
  'Endereco mostrado no perfil do WhatsApp. Um so: a Meta nao aceita dois.';
comment on column public.clinic_settings.whatsapp_profile_description is
  'Descricao do consultorio no perfil do WhatsApp (limite de 512 caracteres).';
comment on column public.clinic_settings.whatsapp_profile_email is
  'E-mail de contato mostrado no perfil do WhatsApp.';
comment on column public.clinic_settings.whatsapp_profile_website is
  'Site mostrado no perfil do WhatsApp.';

grant update (
  whatsapp_profile_about,
  whatsapp_profile_address,
  whatsapp_profile_description,
  whatsapp_profile_email,
  whatsapp_profile_website
) on table public.clinic_settings to authenticated;

-- Começa com o que já foi gravado na Meta em 16/09/2026, para a tela abrir
-- mostrando a verdade e não campos vazios.
update public.clinic_settings
set whatsapp_profile_about = 'Saúde e acompanhamento médico · Santos e São Paulo',
    whatsapp_profile_address = 'Al. Armênio Mendes, 66, sala 2912, Aparecida, Santos - SP',
    whatsapp_profile_description =
      'Consultório do Dr. Rafael Volpini Clauzo, médico do Instituto Clauzo. ' ||
      'Atendimento em Santos e São Paulo, e por telemedicina. Agendamento por aqui mesmo.',
    whatsapp_profile_email = '',
    whatsapp_profile_website = ''
where whatsapp_profile_website = '';

commit;
