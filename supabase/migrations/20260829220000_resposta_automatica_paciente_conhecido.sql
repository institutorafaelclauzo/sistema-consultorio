-- Resposta automatica diferente para quem ja e paciente.
--
-- Ate aqui a regra era so "nunca enviamos nada nesta conversa". Isso deixava um
-- buraco: paciente cadastrado ha tempos, que nunca recebeu acompanhamento -
-- porque a consulta e anterior ao sistema ou o acompanhamento foi arquivado -
-- escrevia e recebia a tabela de precos como se fosse desconhecido.
--
-- Agora sao dois textos. Quem o sistema reconhece pelo telefone recebe um
-- aceno curto; quem nao esta cadastrado recebe as informacoes de sempre.

alter table public.clinic_settings
  add column if not exists whatsapp_autoreply_known_text text not null default '';

comment on column public.clinic_settings.whatsapp_autoreply_known_text is
  'Resposta automatica para quem ja e paciente cadastrado. Aceita {nome}. Vazio nao envia nada.';

grant update (whatsapp_autoreply_known_text)
  on table public.clinic_settings to authenticated;

update public.clinic_settings
   set whatsapp_autoreply_known_text =
'Olá, {nome}! Recebemos sua mensagem aqui no consultório do Dr. Rafael Clauzo.

Nossa equipe já vai te atender. Atendemos de segunda a sexta, das 8h às 18h.'
 where whatsapp_autoreply_known_text = '';
