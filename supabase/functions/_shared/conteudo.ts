import type { Toque } from './atendimento.ts'

/**
 * Monta o conteudo da mensagem: texto simples, botoes ou lista tocavel.
 *
 * A Meta impoe limites duros - 3 botoes, 10 linhas, titulos curtos - e recusa a
 * mensagem inteira quando algum estoura. Aqui, se o pedido nao couber, o envio
 * cai para texto puro em vez de falhar: a mensagem numerada sozinha ja resolve,
 * e uma resposta sem botao e infinitamente melhor do que resposta nenhuma.
 */
export function montarConteudo(
  texto: string,
  toques?: { botoes?: Toque[]; lista?: { rotulo: string; linhas: Toque[] } },
) {
  const simples = { type: 'text', text: { preview_url: false, body: texto } }
  if (!toques) return simples

  const cabe = (valor: string, limite: number) => valor.length > 0 && valor.length <= limite

  const botoes = toques.botoes ?? []
  if (botoes.length > 0) {
    if (botoes.length > 3 || texto.length > 1024) return simples
    if (!botoes.every((b) => cabe(b.titulo, 20) && cabe(b.id, 256))) return simples
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: texto },
        action: {
          buttons: botoes.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.titulo },
          })),
        },
      },
    }
  }

  const lista = toques.lista
  if (lista && lista.linhas.length > 0) {
    if (lista.linhas.length > 10 || texto.length > 1024) return simples
    if (!cabe(lista.rotulo, 20)) return simples
    if (!lista.linhas.every((l) => cabe(l.titulo, 24) && (!l.descricao || l.descricao.length <= 72))) {
      return simples
    }
    return {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: texto },
        action: {
          button: lista.rotulo,
          sections: [
            {
              title: 'Opções',
              rows: lista.linhas.map((l) => ({
                id: l.id,
                title: l.titulo,
                ...(l.descricao ? { description: l.descricao } : {}),
              })),
            },
          ],
        },
      },
    }
  }

  return simples
}
