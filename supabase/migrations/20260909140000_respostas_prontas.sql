begin;

/**
 * Respostas prontas do robô.
 *
 * Até aqui o robô só entendia o que ele mesmo tinha perguntado: número do menu,
 * dia, horário, nome. Quem escrevia "quanto custa a consulta?" recebia o menu
 * de volta, como se a pergunta não existisse - e ficava esperando alguém da
 * clínica responder algo que está escrito na parede da recepção.
 *
 * Aqui ficam os assuntos que a clínica quer que o robô responda sozinho. Cada
 * linha tem as palavras que identificam o assunto e o texto da resposta. Quem
 * escreve as respostas é a clínica, na tela de Preferências: nada aqui é
 * gerado, inventado ou deduzido pelo robô.
 *
 * O que NÃO entra aqui, por decisão e não por esquecimento: qualquer coisa
 * clínica. Dose de remédio, sintoma, "posso dar dipirona?" - isso é consulta,
 * vai para a equipe. A trava que garante isso está no código do atendimento,
 * antes da busca, e não depende do que for cadastrado nesta tabela.
 */

create table if not exists public.bot_answers (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  -- Nome do assunto. Aparece só para a equipe, na tela e no histórico.
  subject text not null,
  -- As palavras que identificam a pergunta, uma por linha na tela. Guardadas
  -- como array porque a busca compara palavra a palavra: com tudo num campo de
  -- texto seria preciso separar de novo a cada mensagem que chega.
  keywords text[] not null default '{}',
  -- O que o robô responde, exatamente como está escrito.
  answer text not null,
  is_active boolean not null default true,
  -- Empate de pontuação é resolvido pela ordem: o assunto de cima ganha.
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_answers_subject_length check (char_length(btrim(subject)) between 1 and 120),
  constraint bot_answers_answer_length check (char_length(btrim(answer)) between 1 and 1024),
  constraint bot_answers_keywords_limit check (array_length(keywords, 1) is null or array_length(keywords, 1) <= 40)
);

comment on table public.bot_answers is
  'Respostas prontas que o robo do WhatsApp da sozinho, escritas pela clinica.';
comment on column public.bot_answers.keywords is
  'Palavras que identificam o assunto. A busca ignora acento e maiuscula.';
comment on column public.bot_answers.answer is
  'Texto enviado ao paciente, sem alteracao. Limite de 1024 por causa do corpo com botoes da Meta.';

create index if not exists bot_answers_clinic_idx
  on public.bot_answers (clinic_id, position) where is_active;

drop trigger if exists bot_answers_set_updated_at on public.bot_answers;
create trigger bot_answers_set_updated_at
before update on public.bot_answers
for each row execute function private.set_updated_at();

alter table public.bot_answers enable row level security;
alter table public.bot_answers force row level security;

-- Ler: qualquer membro. Escrever: só perfil de edição, como nas unidades - o
-- que o robô fala para as famílias não é coisa de perfil somente-visualização.
drop policy if exists bot_answers_select_member on public.bot_answers;
create policy bot_answers_select_member on public.bot_answers
for select to authenticated using ((select private.is_clinic_member(clinic_id)));

drop policy if exists bot_answers_write_editor on public.bot_answers;
create policy bot_answers_write_editor on public.bot_answers
for all to authenticated
using ((select private.is_clinic_editor(clinic_id)))
with check ((select private.is_clinic_editor(clinic_id)));

grant select, insert, update, delete on table public.bot_answers to authenticated;
-- O webhook roda como service_role e só lê.
grant select on table public.bot_answers to service_role;

/**
 * Os quatro assuntos que a clínica pediu para começar.
 *
 * Entram desativados de propósito. O texto abaixo é um rascunho com o formato
 * certo mas com os dados em branco: se entrasse ligado, o robô começaria hoje
 * a dizer "o valor da consulta é R$ ___" para as famílias. Quem escreve o
 * conteúdo e liga o botão é a clínica.
 */
insert into public.bot_answers (clinic_id, subject, keywords, answer, is_active, position)
select c.id, v.subject, v.keywords, v.answer, false, v.position
from public.clinics c
cross join (values
  (
    'Valor e pagamento',
    array['valor','valores','preco','preços','preço','custa','custo','quanto','pagamento','pagar','pix','cartao','parcela','recibo','nota','reembolso','particular'],
    E'A consulta particular custa R$ ___.\n\nAceitamos pix, dinheiro e cartão (em até __ vezes). Emitimos recibo com CRM e CNPJ para você pedir reembolso ao seu plano.',
    10
  ),
  (
    'Convênios',
    array['convenio','convenios','convênio','convênios','plano','planos','unimed','bradesco','amil','sulamerica','sul','porto','notredame','carteirinha','credenciado'],
    E'O atendimento é particular, sem convênio credenciado.\n\nVocê recebe o recibo da consulta com CRM e CNPJ e pode solicitar o reembolso ao seu plano. O valor devolvido depende do seu contrato.',
    20
  ),
  (
    'Endereço e estacionamento',
    array['endereco','endereço','onde','local','localizacao','localização','fica','chegar','estacionamento','estacionar','carro','mapa','referencia','referência','bairro','rua'],
    E'Atendemos em duas unidades:\n\n📍 *Livance · Ibirapuera* — R. Agostinho Rodrigues Filho, 550, Vila Clementino, São Paulo.\n\n📍 *Liferty · Santos* — Al. Armênio Mendes, 66, sala 2912, Aparecida, Santos.\n\n___ (estacionamento e como chegar)',
    30
  ),
  (
    'O que levar e como é a consulta',
    array['levar','documento','documentos','exame','exames','carteirinha','vacina','vacinacao','vacinação','primeira','duracao','duração','demora','tempo','retorno','preparo','jejum'],
    E'Leve um documento com foto do responsável, a carteirinha de vacinação da criança e os exames anteriores, se houver.\n\nA consulta dura cerca de __ minutos. O retorno é ___.',
    40
  )
) as v(subject, keywords, answer, position)
where not exists (
  select 1 from public.bot_answers b where b.clinic_id = c.id
);

commit;
