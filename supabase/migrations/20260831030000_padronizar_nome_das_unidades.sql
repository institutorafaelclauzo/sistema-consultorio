-- Um nome so para cada unidade, igual ao do site.
--
-- Hoje o mesmo lugar aparece escrito de tres jeitos:
--
--   clinic_units   "Liferty · Santos"        (ponto medio, como no site)
--   clinic_units   "Livance - Santo Andre"   (hifen, e sem o acento de Andre)
--   patients.unit  "Liferty Santos"          (sem separador nenhum)
--
-- Isso obrigou a tela a comparar nomes ignorando acento, hifen e espaco para
-- adivinhar que sao a mesma coisa. Adivinhacao funciona ate alguem cadastrar
-- uma unidade nova e o palpite errar calado.
--
-- O site e a fonte da verdade, porque e o que o paciente le antes de escrever:
--   Liferty · Santos
--   Livance · Santo André
--   Livance · Vila Mariana

-- ---------------------------------------------------------------
-- Unidades da agenda
-- ---------------------------------------------------------------

update public.clinic_units set name = 'Liferty · Santos'
 where name <> 'Liferty · Santos'
   and lower(regexp_replace(name, '[^a-zA-Z0-9]+', '', 'g')) = 'lifertysantos';

update public.clinic_units set name = 'Livance · Santo André'
 where name <> 'Livance · Santo André'
   and lower(regexp_replace(translate(name, 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ', 'aaaaeeiooouucAAAAEEIOOOUUC'),
                            '[^a-zA-Z0-9]+', '', 'g')) = 'livancesantoandre';

update public.clinic_units set name = 'Livance · Vila Mariana'
 where name <> 'Livance · Vila Mariana'
   and lower(regexp_replace(name, '[^a-zA-Z0-9]+', '', 'g')) = 'livancevilamariana';

-- ---------------------------------------------------------------
-- Unidade escrita no cadastro do paciente
--
-- Campo de texto livre, preenchido por uma lista fixa na tela. Sem esta
-- passagem, abrir um paciente antigo mostraria o campo em branco, porque o
-- valor gravado nao existiria mais entre as opcoes.
-- ---------------------------------------------------------------

update public.patients set unit = 'Liferty · Santos'
 where unit <> 'Liferty · Santos'
   and lower(regexp_replace(unit, '[^a-zA-Z0-9]+', '', 'g')) = 'lifertysantos';

update public.patients set unit = 'Livance · Santo André'
 where unit <> 'Livance · Santo André'
   and lower(regexp_replace(translate(unit, 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ', 'aaaaeeiooouucAAAAEEIOOOUUC'),
                            '[^a-zA-Z0-9]+', '', 'g')) = 'livancesantoandre';

update public.patients set unit = 'Livance · Vila Mariana'
 where unit <> 'Livance · Vila Mariana'
   and lower(regexp_replace(unit, '[^a-zA-Z0-9]+', '', 'g')) = 'livancevilamariana';

-- O mesmo para o campo de unidade da consulta no prontuario.
update public.consultations set unit = 'Liferty · Santos'
 where unit <> 'Liferty · Santos'
   and lower(regexp_replace(unit, '[^a-zA-Z0-9]+', '', 'g')) = 'lifertysantos';

update public.consultations set unit = 'Livance · Santo André'
 where unit <> 'Livance · Santo André'
   and lower(regexp_replace(translate(unit, 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ', 'aaaaeeiooouucAAAAEEIOOOUUC'),
                            '[^a-zA-Z0-9]+', '', 'g')) = 'livancesantoandre';

update public.consultations set unit = 'Livance · Vila Mariana'
 where unit <> 'Livance · Vila Mariana'
   and lower(regexp_replace(unit, '[^a-zA-Z0-9]+', '', 'g')) = 'livancevilamariana';
