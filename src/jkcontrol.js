import { requisicao } from './http.js';

/**
 * Leitura do histórico de telemetria do jkcontrol.online.
 *
 * Usa GET /api/devices/{device}/variables/{variavel}/data em modo paginado e
 * com a janela FECHADA (endDate fixo). Dois cuidados que vêm da API:
 *  - o modo `limit` devolve só os N mais recentes da janela e descarta o resto
 *    sem avisar; a paginação não tem esse problema;
 *  - as páginas vêm do mais novo para o mais antigo — com endDate fixo elas não
 *    "andam" enquanto chegam dados novos, e a ordem é refeita aqui.
 */
export class JkControlClient {
    constructor({ baseUrl, token, porPagina = 500, fetchImpl = fetch }) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.porPagina = porPagina;
        this.fetch = fetchImpl;
    }

    async leituras(dispositivo, variavel, desde, ate) {
        const brutos = [];
        let pagina = 1;
        let totalPaginas = 1;

        do {
            const url = new URL(
                `/api/devices/${encodeURIComponent(dispositivo)}/variables/${encodeURIComponent(variavel)}/data`,
                this.baseUrl,
            );
            url.searchParams.set('startDate', desde.toISOString());
            url.searchParams.set('endDate', ate.toISOString());
            url.searchParams.set('page', String(pagina));
            url.searchParams.set('perPage', String(this.porPagina));

            const corpo = await requisicao(this.fetch, url, {
                headers: { Authorization: `Bearer ${this.token}` },
            });

            brutos.push(...(Array.isArray(corpo?.data) ? corpo.data : []));
            totalPaginas = Number(corpo?.totalPages ?? 1);
            pagina += 1;
        } while (pagina <= totalPaginas);

        return brutos
            .map((item) => ({
                id: String(item._id ?? `${dispositivo}/${variavel}@${item.timestamp}`),
                ts: new Date(item.timestamp),
                value: item.value,
                context: item.context ?? {},
            }))
            .filter((item) => !Number.isNaN(item.ts.getTime()))
            .sort((a, b) => a.ts - b.ts);
    }
}
