import { setTimeout as esperarPadrao } from 'node:timers/promises';
import { requisicao } from './http.js';

/**
 * Intervalo mínimo entre duas chamadas à Ubidots. O limite padrão é de 4
 * requisições por segundo por token, contado junto com tudo que usa o mesmo
 * token: com folga, o conector fica abaixo de 3,4 por segundo.
 */
export const INTERVALO_MINIMO_MS = 300;

/**
 * Leitura do histórico de variáveis da Ubidots (API v1.6), com a mesma
 * interface do JkControlClient: leituras(dispositivo, variável, desde, até).
 *
 * GET /api/v1.6/devices/{dispositivo}/{variável}/values, com token no
 * cabeçalho X-Auth-Token e janela FECHADA (start e end em ms, inclusivos).
 *  - as páginas vêm do mais novo para o mais antigo; com `end` fixo elas não
 *    "andam" enquanto chegam dados novos, e a ordem é refeita aqui;
 *  - o fim é dado por `next` vazio: `count` não traz o total (vem `true`);
 *  - um ponto da Ubidots não tem id próprio: a variável guarda um ponto por
 *    horário, então o horário identifica o ponto dentro da série.
 */
export class UbidotsClient {
    constructor({
        baseUrl,
        token,
        porPagina = 500,
        intervaloMinimoMs = INTERVALO_MINIMO_MS,
        fetchImpl = fetch,
        esperar = esperarPadrao,
        relogio = () => Date.now(),
    }) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.porPagina = porPagina;
        this.intervaloMinimoMs = intervaloMinimoMs;
        this.fetch = fetchImpl;
        this.esperar = esperar;
        this.relogio = relogio;
        this.proximaChamada = 0;
    }

    async leituras(dispositivo, variavel, desde, ate) {
        const brutos = [];
        let pagina = 1;
        let continua = true;

        while (continua) {
            const url = new URL(
                `/api/v1.6/devices/${encodeURIComponent(dispositivo)}/${encodeURIComponent(variavel)}/values/`,
                this.baseUrl,
            );
            url.searchParams.set('start', String(desde.getTime()));
            url.searchParams.set('end', String(ate.getTime()));
            url.searchParams.set('page', String(pagina));
            url.searchParams.set('page_size', String(this.porPagina));

            await this.aguardarVez();
            const corpo = await requisicao(this.fetch, url, {
                headers: { 'X-Auth-Token': this.token },
            });

            const resultados = Array.isArray(corpo?.results) ? corpo.results : [];
            brutos.push(...resultados);
            continua = Boolean(corpo?.next) && resultados.length > 0;
            pagina += 1;
        }

        return brutos
            .map((item) => ({
                id: `${variavel}@${item.timestamp}`,
                ts: new Date(item.timestamp),
                value: item.value,
                context: item.context ?? {},
            }))
            .filter((item) => !Number.isNaN(item.ts.getTime()))
            .sort((a, b) => a.ts - b.ts);
    }

    async aguardarVez() {
        const agora = this.relogio();
        const espera = this.proximaChamada - agora;
        if (espera > 0) await this.esperar(espera);
        this.proximaChamada = Math.max(agora, this.proximaChamada) + this.intervaloMinimoMs;
    }
}
