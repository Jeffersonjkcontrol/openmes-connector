// Simulador do jkcontrol.online para testar o conector sem tocar na produção.
//
// Responde a mesma API de histórico que o conector lê e recebe as leituras por
// HTTP, no lugar do MQTT do dispositivo, com as regras de ingestão do jkcontrol:
//  - `value` só numérico (texto vai no `context`);
//  - `timestamp` até 30 dias no passado e 5 min no futuro;
//  - duas leituras da mesma variável a menos de 250 ms uma da outra: fica só a
//    última (o buffer de ingestão do jkcontrol).
//
// As mesmas séries também saem no formato da API v1.6 da Ubidots, para testar o
// conector com SOURCE=ubidots.
//
//   GET  /api/devices/{dispositivo}/variables/{variável}/data   (Bearer token)
//   GET  /api/v1.6/devices/{dispositivo}/{variável}/values/     (X-Auth-Token, formato Ubidots)
//   POST /sim/publicar   {device, variable, value, context?, timestamp?}
//   GET  /sim/series     o que está guardado (sem token, é ferramenta local)
//   GET  /sim/ultimo?device=&variable=

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const BUFFER_MS = 250;
const PASSADO_MAXIMO_MS = 30 * 24 * 3_600_000;
const FUTURO_MAXIMO_MS = 5 * 60_000;

export class ErroLeitura extends Error {}

/**
 * Guarda as séries em memória (e opcionalmente num arquivo JSON, para o
 * histórico sobreviver a um reinício do simulador).
 */
export class Armazem {
    constructor({ arquivo = null, relogio = () => Date.now() } = {}) {
        this.arquivo = arquivo;
        this.relogio = relogio;
        this.series = new Map();

        if (arquivo && existsSync(arquivo)) {
            for (const [chave, itens] of Object.entries(JSON.parse(readFileSync(arquivo, 'utf8')))) {
                this.series.set(chave, itens);
            }
        }
    }

    publicar({ device, variable, value, context, timestamp } = {}) {
        for (const [nome, v] of [['device', device], ['variable', variable]]) {
            if (typeof v !== 'string' || !/^[\w.-]+$/.test(v)) {
                throw new ErroLeitura(`"${nome}" precisa ser um nome sem espaços nem barras.`);
            }
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new ErroLeitura('"value" precisa ser numérico; texto vai no "context".');
        }
        if (context !== undefined && (typeof context !== 'object' || context === null || Array.isArray(context))) {
            throw new ErroLeitura('"context" precisa ser um objeto.');
        }

        const agora = this.relogio();
        const ts = timestamp === undefined ? agora : new Date(timestamp).getTime();
        if (Number.isNaN(ts)) throw new ErroLeitura('"timestamp" inválido (use epoch em ms ou ISO 8601).');
        if (ts < agora - PASSADO_MAXIMO_MS) throw new ErroLeitura('"timestamp" mais de 30 dias no passado.');
        if (ts > agora + FUTURO_MAXIMO_MS) throw new ErroLeitura('"timestamp" mais de 5 minutos no futuro.');

        const chave = `${device}/${variable}`;
        const itens = this.series.get(chave) ?? [];
        const leitura = {
            _id: randomBytes(12).toString('hex'),
            timestamp: new Date(ts).toISOString(),
            value,
            context: context ?? {},
            recebidoEm: agora,
        };

        const anterior = itens.at(-1);
        if (anterior && agora - anterior.recebidoEm < BUFFER_MS) {
            itens[itens.length - 1] = leitura;
        } else {
            itens.push(leitura);
        }
        this.series.set(chave, itens);
        this.salvar();

        return leitura;
    }

    /** Leituras da série dentro da janela, do mais novo para o mais antigo. */
    janela(chave, inicio, fim) {
        return (this.series.get(chave) ?? [])
            .filter((i) => {
                const t = Date.parse(i.timestamp);
                return t >= inicio && t <= fim;
            })
            .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    }

    /** Uma página do histórico, como a API real: do mais novo para o mais antigo, cada página em ordem cronológica. */
    pagina(chave, { inicio, fim, pagina, porPagina }) {
        const janela = this.janela(chave, inicio, fim);

        const fatia = janela
            .slice((pagina - 1) * porPagina, pagina * porPagina)
            .reverse()
            .map(({ recebidoEm, ...publica }) => publica);

        return {
            data: fatia,
            page: pagina,
            perPage: porPagina,
            totalItems: janela.length,
            totalPages: Math.ceil(janela.length / porPagina),
        };
    }

    /**
     * Uma página no formato da Ubidots (v1.6): tudo do mais novo para o mais
     * antigo, horários em ms, `count` sem o total e o fim dado por `next` nulo.
     */
    paginaUbidots(chave, { inicio, fim, pagina, porPagina, enderecoDaPagina }) {
        const janela = this.janela(chave, inicio, fim);
        const fatia = janela.slice((pagina - 1) * porPagina, pagina * porPagina);

        return {
            count: true,
            next: pagina * porPagina < janela.length ? enderecoDaPagina(pagina + 1) : null,
            previous: pagina > 1 ? enderecoDaPagina(pagina - 1) : null,
            results: fatia.map((i) => ({
                timestamp: Date.parse(i.timestamp),
                value: i.value,
                context: i.context,
                created_at: i.recebidoEm,
            })),
        };
    }

    ultimo(chave) {
        const itens = this.series.get(chave) ?? [];
        if (itens.length === 0) return null;
        const { recebidoEm, ...publica } = itens.reduce((a, b) => (Date.parse(b.timestamp) >= Date.parse(a.timestamp) ? b : a));
        return publica;
    }

    resumo() {
        return [...this.series].map(([chave, itens]) => ({ serie: chave, leituras: itens.length, ultimo: this.ultimo(chave) }));
    }

    salvar() {
        if (!this.arquivo) return;
        const temporario = `${this.arquivo}.tmp`;
        writeFileSync(temporario, JSON.stringify(Object.fromEntries(this.series)));
        renameSync(temporario, this.arquivo);
    }
}

export function criarServidor({ token, armazem }) {
    return http.createServer(async (req, res) => {
        const responder = (status, corpo) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(corpo));
        };

        try {
            const url = new URL(req.url, 'http://simulador');

            const historico = url.pathname.match(/^\/api\/devices\/([^/]+)\/variables\/([^/]+)\/data$/);
            if (req.method === 'GET' && historico) {
                if (req.headers.authorization !== `Bearer ${token}`) return responder(401, { message: 'Not authorized' });

                const chave = `${decodeURIComponent(historico[1])}/${decodeURIComponent(historico[2])}`;
                if (!armazem.series.has(chave)) return responder(404, { message: 'Variable not found' });

                const inicio = Date.parse(url.searchParams.get('startDate') ?? '');
                const fim = Date.parse(url.searchParams.get('endDate') ?? '');
                const pagina = Number(url.searchParams.get('page') ?? 1);
                const porPagina = Number(url.searchParams.get('perPage') ?? 100);
                if (Number.isNaN(inicio) || Number.isNaN(fim) || !(pagina >= 1) || !(porPagina >= 1 && porPagina <= 1000)) {
                    return responder(400, { message: 'startDate, endDate, page e perPage (1 a 1000) são obrigatórios.' });
                }

                return responder(200, armazem.pagina(chave, { inicio, fim, pagina, porPagina }));
            }

            const ubidots = url.pathname.match(/^\/api\/v1\.6\/devices\/([^/]+)\/([^/]+)\/values\/?$/);
            if (req.method === 'GET' && ubidots) {
                if (req.headers['x-auth-token'] !== token) {
                    return responder(401, { code: 401002, message: 'Incorrect authentication credentials.' });
                }

                const chave = `${decodeURIComponent(ubidots[1])}/${decodeURIComponent(ubidots[2])}`;
                if (!armazem.series.has(chave)) return responder(404, { code: 404001, message: 'Not found.' });

                // Sem start/end a Ubidots devolve as mais recentes; aqui: tudo.
                const inicio = Number(url.searchParams.get('start') ?? 0);
                const fim = Number(url.searchParams.get('end') ?? Number.MAX_SAFE_INTEGER);
                const pagina = Number(url.searchParams.get('page') ?? 1);
                const porPagina = Number(url.searchParams.get('page_size') ?? 100);
                if (!Number.isFinite(inicio) || !Number.isFinite(fim) || !(pagina >= 1) || !(porPagina >= 1 && porPagina <= 1000)) {
                    return responder(400, { message: 'start e end em ms; page e page_size (1 a 1000) inteiros.' });
                }

                const enderecoDaPagina = (n) => {
                    const outra = new URL(url.pathname + url.search, `http://${req.headers.host}`);
                    outra.searchParams.set('page', String(n));
                    return outra.href;
                };
                return responder(200, armazem.paginaUbidots(chave, { inicio, fim, pagina, porPagina, enderecoDaPagina }));
            }

            if (req.method === 'POST' && url.pathname === '/sim/publicar') {
                let texto = '';
                for await (const parte of req) texto += parte;
                let corpo;
                try {
                    corpo = JSON.parse(texto);
                } catch {
                    return responder(400, { message: 'Corpo precisa ser JSON.' });
                }
                return responder(201, armazem.publicar(corpo));
            }

            if (req.method === 'GET' && url.pathname === '/sim/series') {
                return responder(200, armazem.resumo());
            }

            if (req.method === 'GET' && url.pathname === '/sim/ultimo') {
                const chave = `${url.searchParams.get('device')}/${url.searchParams.get('variable')}`;
                return responder(200, { data: armazem.ultimo(chave) });
            }

            return responder(404, { message: 'Not found' });
        } catch (erro) {
            if (erro instanceof ErroLeitura) return responder(400, { message: erro.message });
            return responder(500, { message: erro.message });
        }
    });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const porta = Number(process.env.SIM_PORT || 8090);
    const token = process.env.SIM_TOKEN || 'ag_simulador';
    const arquivo = process.env.SIM_ARQUIVO || null;

    const armazem = new Armazem({ arquivo });
    const servidor = criarServidor({ token, armazem });
    servidor.listen(porta, '0.0.0.0', () => {
        console.log(`simulador do jkcontrol e da Ubidots na porta ${porta} (token ${token}${arquivo ? `, guardando em ${arquivo}` : ''})`);
    });

    for (const sinal of ['SIGINT', 'SIGTERM']) {
        process.on(sinal, () => servidor.close(() => process.exit(0)));
    }
}
