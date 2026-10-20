// Cliente da Ubidots: lê o histórico pelo formato da API v1.6 (o mesmo que o
// simulador imita) e respeita o limite de requisições por token.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ErroHttp } from '../src/http.js';
import { UbidotsClient } from '../src/ubidots.js';
import { Armazem, criarServidor } from '../sim/servidor.js';

let agora = Date.parse('2026-10-19T12:00:00.000Z');
const armazem = new Armazem({ relogio: () => agora });
let servidor;
let url;

// Sem espera de verdade entre chamadas, para o teste não ficar lento.
const cliente = (extra = {}) => new UbidotsClient({ baseUrl: url, token: 'BBUS-teste', intervaloMinimoMs: 0, ...extra });

before(async () => {
    servidor = criarServidor({ token: 'BBUS-teste', armazem });
    await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${servidor.address().port}`;

    for (let i = 0; i < 7; i += 1) {
        agora += 1000;
        armazem.publicar({ device: 'injetora07', variable: 'injecao_hora', value: (i + 1) * 10, timestamp: Date.parse(`2026-10-19T11:0${i}:00.000Z`) });
    }
    agora += 1000;
    armazem.publicar({ device: 'injetora07', variable: 'fun_rfid', value: 1, context: { fun_rfid: 'CRACHA-TESTE' }, timestamp: Date.parse('2026-10-19T11:30:00.000Z') });
});

after(() => servidor.close());

test('segue as páginas até "next" vazio e devolve em ordem cronológica', async () => {
    const itens = await cliente({ porPagina: 3 }).leituras('injetora07', 'injecao_hora', new Date('2026-10-19T10:00:00Z'), new Date('2026-10-19T12:00:00Z'));

    assert.deepEqual(itens.map((i) => i.value), [10, 20, 30, 40, 50, 60, 70]);
    assert.equal(itens[0].ts.toISOString(), '2026-10-19T11:00:00.000Z');
    // Sem id na Ubidots: o horário identifica o ponto dentro da série.
    assert.equal(itens[0].id, `injecao_hora@${Date.parse('2026-10-19T11:00:00.000Z')}`);
    assert.equal(new Set(itens.map((i) => i.id)).size, 7);
});

test('a janela de horário é respeitada e o context chega inteiro', async () => {
    const janela = await cliente().leituras('injetora07', 'injecao_hora', new Date('2026-10-19T11:02:00Z'), new Date('2026-10-19T11:04:00Z'));
    assert.deepEqual(janela.map((i) => i.value), [30, 40, 50]);

    const [cartao] = await cliente().leituras('injetora07', 'fun_rfid', new Date('2026-10-19T11:00:00Z'), new Date('2026-10-19T12:00:00Z'));
    assert.deepEqual(cartao.context, { fun_rfid: 'CRACHA-TESTE' });
});

test('token errado recebe 401 e variável inexistente recebe 404', async () => {
    const intruso = new UbidotsClient({ baseUrl: url, token: 'BBUS-errado', intervaloMinimoMs: 0 });
    await assert.rejects(intruso.leituras('injetora07', 'injecao_hora', new Date(0), new Date(agora)), (e) => e instanceof ErroHttp && e.status === 401);

    await assert.rejects(cliente().leituras('injetora07', 'nao_existe', new Date(0), new Date(agora)), (e) => e instanceof ErroHttp && e.status === 404);
});

test('o token vai no cabeçalho, nunca no endereço', async () => {
    const pedidos = [];
    const espiao = async (endereco, opcoes) => {
        pedidos.push({ endereco: String(endereco), cabecalhos: opcoes.headers });
        return new Response(JSON.stringify({ count: true, next: null, previous: null, results: [] }), { status: 200 });
    };

    await new UbidotsClient({ baseUrl: 'https://ubidots.exemplo', token: 'BBUS-segredo', intervaloMinimoMs: 0, fetchImpl: espiao })
        .leituras('injetora07', 'parada', new Date(1_000), new Date(2_000));

    const [pedido] = pedidos;
    assert.equal(pedido.cabecalhos['X-Auth-Token'], 'BBUS-segredo');
    assert.doesNotMatch(pedido.endereco, /segredo/);
    assert.equal(pedido.endereco, 'https://ubidots.exemplo/api/v1.6/devices/injetora07/parada/values/?start=1000&end=2000&page=1&page_size=500');
});

test('espaça as chamadas para ficar abaixo do limite de 4 por segundo', async () => {
    let relogio = 0;
    const esperas = [];
    const ubidots = new UbidotsClient({
        baseUrl: 'https://ubidots.exemplo',
        token: 'BBUS-x',
        intervaloMinimoMs: 300,
        relogio: () => relogio,
        esperar: async (ms) => {
            esperas.push(ms);
            relogio += ms;
        },
        fetchImpl: async () => {
            relogio += 50; // cada chamada leva 50 ms
            return new Response(JSON.stringify({ count: true, next: null, results: [] }), { status: 200 });
        },
    });

    for (const variavel of ['parada', 'injecao_hora', 'fun_rfid']) {
        await ubidots.leituras('injetora07', variavel, new Date(0), new Date(1));
    }

    // 1ª sai na hora; as outras esperam o que falta para 300 ms desde a anterior.
    assert.deepEqual(esperas, [250, 250]);
    assert.equal(relogio, 650);
});
