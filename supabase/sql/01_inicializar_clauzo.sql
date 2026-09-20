-- Execute no SQL Editor do NOVO projeto, depois de todas as migrações.
-- Crie primeiro o usuário administrador no Authentication do novo projeto.
-- Substitua somente o UUID abaixo pelo ID desse usuário. Não coloque senhas aqui.
begin;
do $$
declare
  admin_user_id uuid := '00000000-0000-0000-0000-000000000000';
  new_clinic_id uuid;
begin
  if admin_user_id = '00000000-0000-0000-0000-000000000000' then
    raise exception 'Preencha admin_user_id com o ID do administrador do Clauzo.';
  end if;
  if not exists(select 1 from auth.users where id = admin_user_id and email_confirmed_at is not null) then
    raise exception 'O administrador precisa existir e ter e-mail confirmado neste projeto.';
  end if;
  if exists(select 1 from public.clinics) then
    raise exception 'Este instalador exige um banco novo, sem clínicas. Não execute no sistema de origem.';
  end if;

  insert into public.clinics(name, created_by) values ('Instituto Clauzo', admin_user_id)
    returning id into new_clinic_id;
  insert into public.clinic_memberships(clinic_id, user_id, role, status)
    values(new_clinic_id, admin_user_id, 'owner', 'active');
  insert into public.clinic_settings(
    clinic_id, signer_name, signer_crm, clinic_phone, clinic_phone_alt,
    whatsapp_autoreply_enabled, appointment_reminder_enabled, telemedicine_enabled,
    whatsapp_autoreply_text, whatsapp_autoreply_known_text, whatsapp_menu_info_text,
    whatsapp_profile_about, whatsapp_profile_description
  ) values (
    new_clinic_id, 'Rafael Volpini Clauzo', '126235', '(11) 94875-7371', '(11) 99485-0797',
    false, false, false,
    'Olá! Aqui é a equipe do Instituto Clauzo. Como podemos ajudar?',
    'Olá! Aqui é a equipe do Instituto Clauzo. Como podemos ajudar?',
    'O Instituto Clauzo atende em São Paulo, São Bernardo do Campo e Baixada Santista. Fale com a equipe para confirmar endereço, horários, valores e formas de atendimento.',
    'Instituto Clauzo | Saúde e acompanhamento médico',
    'Acompanhamento médico com o Dr. Rafael Volpini Clauzo. Unidades em São Paulo, São Bernardo do Campo e Baixada Santista.'
  );
  insert into public.clinic_units(clinic_id, name, address, info_text) values
    (new_clinic_id, 'São Paulo', '', 'Fale com a unidade São Paulo: (11) 94875-7371. Confirme endereço, horários e valores com a equipe.'),
    (new_clinic_id, 'São Bernardo do Campo', '', 'Fale com a unidade São Bernardo do Campo: (11) 99485-0797. Confirme endereço, horários e valores com a equipe.'),
    (new_clinic_id, 'Baixada Santista', '', 'Fale com a unidade Baixada Santista: (11) 96573-9677. Confirme endereço, horários e valores com a equipe.');
  insert into public.bot_answers(clinic_id, subject, keywords, answer, is_active, position) values
    (new_clinic_id, 'Unidades', array['unidade','unidades','endereço','endereco','localização'], 'Atendemos em São Paulo, São Bernardo do Campo e Baixada Santista. A equipe confirma o endereço da unidade escolhida.', false, 10),
    (new_clinic_id, 'Valores e convênios', array['valor','preço','preco','convênio','convenio','pagamento'], 'A equipe do Instituto Clauzo informa os valores e as condições de atendimento para a unidade escolhida.', false, 20),
    (new_clinic_id, 'Preparação para a consulta', array['levar','preparo','exames'], 'Traga seus exames anteriores e a lista de medicamentos em uso. A equipe informa se houver alguma orientação específica de preparo.', false, 30);
end;
$$;
commit;
