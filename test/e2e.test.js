// Ciclo completo por HTTP de verdade, contra um jkcontrol e um OpenMES falsos
// que respondem no formato das APIs reais (paginação do histórico, login com
// token que expira, endpoints de sinais e do módulo JkControl).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { normalizarMaquinas } from '../src/config.js';
import { JkControlClient } from '../src/jkcontrol.js';
import { silencioso } from '../src/log.js';
import { OpenMesClient } from '../src/openmes.js';
import { Estado } from '../src/state.js';
import { executarCiclo } from '../src/sync.js';

function subir(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(async (req, res) => {
            let corpo = '';
            for await (const parte of req) corpo += parte;
            const json = corpo ? JSON.parse(corpo) : undefined;
            const [status, resposta] = handler(req, new URL(req.url, 'http://x'), json);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(resposta));
        });
        srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
    });
}

// ── jkcontrol falso ────────────────────────────────────────────────────────
const historico = {
    'injetora01/produzido': [10, 20, 30, 40, 50].map((v, i) => ({
        _id: `p${i + 1}`, timestamp: `2026-10-19T10:0${i}:00.000Z`, value: v, context: {},
    })),
    'injetora01/estado': [{ _id: 'e1', timestamp: '2026-10-19T10:02:30.000Z', value: 0, context: {} }],
    'injetora01/operador': [{ _id: 'o1', timestamp: '2026-10-19T09:59:00.000Z', value: 1, context: { uid: '04:A1:B2:C3' } }],
    'injetora01/motivo_parada': [
        { _id: 'm1', timestamp: '2026-10-19T10:03:00.000Z', value: 99, context: {} },
        { _id: 'm2', timestamp: '2026-10-19T10:03:30.000Z', value: 12, context: {} },
    ],
};
const pedidosJk = [];

function jkcontrol(req, url) {
    if (req.headers.authorization !== 'Bearer ag_teste') return [401, { message: 'Not authorized' }];

    const m = url.pathname.match(/^\/api\/devices\/([^/]+)\/variables\/([^/]+)\/data$/);
    if (!m) return [404, { message: 'Not found' }];

    const chave = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
    if (!historico[chave]) return [404, { message: 'Device not found' }];

    const inicio = Date.parse(url.searchParams.get('startDate'));
    const fim = Date.parse(url.searchParams.get('endDate'));
    const pagina = Number(url.searchParams.get('page'));
    const porPagina = Number(url.searchParams.get('perPage'));
    pedidosJk.push({ chave, pagina });

    // Como a API real: ordena do mais novo para o mais antigo, pagina e
    // devolve cada página em ordem cronológica.
    const janela = historico[chave]
        .filter((i) => Date.parse(i.timestamp) >= inicio && Date.parse(i.timestamp) <= fim)
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const fatia = janela.slice((pagina - 1) * porPagina, pagina * porPagina).reverse();

    return [200, { data: fatia, page: pagina, perPage: porPagina, totalItems: janela.length, totalPages: Math.ceil(janela.length / porPagina) }];
}

// ── OpenMES falso ──────────────────────────────────────────────────────────
const recebido = [];
let logins = 0;
let usosDoToken = 0;
let tokenValido = null;

function openmes(req, url, corpo) {
    if (url.pathname === '/api/auth/login') {
        if (corpo?.username !== 'conector' || corpo?.password !== 'segredo') {
            return [422, { message: 'The provided credentials are incorrect.' }];
        }
        logins += 1;
        tokenValido = `tok${logins}`;
        usosDoToken = 0;
        return [200, { message: 'Login successful', data: { token: tokenValido, force_password_change: false } }];
    }

    // O primeiro token "expira" depois de 2 usos, como o TTL de 15 min.
    usosDoToken += 1;
    if (req.headers.authorization !== `Bearer ${tokenValido}` || (logins === 1 && usosDoToken > 2)) {
        return [401, { message: 'Unauthenticated.' }];
    }

    let m;
    if ((m = url.pathname.match(/^\/api\/v1\/machine-connections\/(\d+)\/signals$/))) {
        recebido.push({ tipo: 'sinais', conexao: Number(m[1]), leituras: corpo.readings });
        return [200, { accepted: corpo.readings.length }];
    }
    if ((m = url.pathname.match(/^\/api\/v1\/machine-connections\/(\d+)\/heartbeat$/))) {
        recebido.push({ tipo: 'heartbeat', conexao: Number(m[1]) });
        return [200, { ok: true }];
    }
    if (url.pathname === '/api/v1/jk/operator-events') {
        recebido.push({ tipo: 'operador', ...corpo });
        return [201, { status: 'logged_in' }];
    }
    if ((m = url.pathname.match(/^\/api\/v1\/jk\/workstations\/(\d+)\/downtime-reason$/))) {
        if (corpo.reason_code === '99') {
            return [422, { message: 'No active downtime reason has this code.', errors: { reason_code: ['No active downtime reason has this code.'] } }];
        }
        recebido.push({ tipo: 'motivo', estacao: Number(m[1]), ...corpo });
        return [200, { status: 'classified', data: { downtime_id: 5 } }];
    }
    return [404, { message: 'Not found' }];
}

let jk;
let mes;
before(async () => {
    jk = await subir(jkcontrol);
    mes = await subir(openmes);
});
after(() => {
    jk.srv.close();
    mes.srv.close();
});

test('ciclo completo: pagina o histórico, renova o token e entrega tudo na ordem', async () => {
    const arquivoEstado = join(mkdtempSync(join(tmpdir(), 'conector-')), 'state.json');
    const config = {
        fuso: 'America/Sao_Paulo',
        sobreposicaoMs: 15 * 60_000,
        retroativoInicialMs: 60 * 60_000,
        maquinas: normalizarMaquinas([{
            device: 'injetora01',
            workstation_id: 3,
            connection_id: 1,
            signals: ['estado', 'produzido'],
            operator_variable: 'operador',
            reason_variable: 'motivo_parada',
        }]),
    };
    const clientes = {
        jk: new JkControlClient({ baseUrl: jk.url, token: 'ag_teste', porPagina: 2 }),
        mes: new OpenMesClient({ baseUrl: mes.url, usuario: 'conector', senha: 'segredo' }),
    };
    const agora = new Date('2026-10-19T10:10:00.000Z');

    const resumo = await executarCiclo({ config, ...clientes, estado: new Estado(arquivoEstado), log: silencioso, agora });

    // 5 leituras de produzido em páginas de 2 → 3 páginas
    assert.deepEqual(pedidosJk.filter((p) => p.chave === 'injetora01/produzido').map((p) => p.pagina), [1, 2, 3]);

    // token expirou no meio e o cliente fez login de novo
    assert.equal(logins, 2);

    // O motivo das 10:03:30 corta o lote: a leitura das 10:04 vai depois dele.
    const entregas = recebido.filter((r) => r.tipo !== 'heartbeat');
    assert.deepEqual(entregas.map((r) => r.tipo), ['operador', 'sinais', 'motivo', 'sinais']);

    const [operador, lote1, motivo, lote2] = entregas;
    assert.equal(operador.card_uid, '04:A1:B2:C3');
    assert.equal(operador.occurred_at, '2026-10-19T06:59:00.000-03:00');

    assert.deepEqual([...lote1.leituras, ...lote2.leituras].map((l) => `${l.node_id}=${l.value}@${l.ts}`), [
        'injetora01/produzido=10@2026-10-19T07:00:00.000-03:00',
        'injetora01/produzido=20@2026-10-19T07:01:00.000-03:00',
        'injetora01/produzido=30@2026-10-19T07:02:00.000-03:00',
        'injetora01/estado=0@2026-10-19T07:02:30.000-03:00',
        'injetora01/produzido=40@2026-10-19T07:03:00.000-03:00',
        'injetora01/produzido=50@2026-10-19T07:04:00.000-03:00',
    ]);

    // motivo 99 recusado (422) e descartado; o 12 entregue
    assert.deepEqual([motivo.estacao, motivo.reason_code], [3, '12']);
    assert.equal(resumo.descartados, 1);
    assert.equal(resumo.sinais, 6);

    assert.deepEqual(recebido.filter((r) => r.tipo === 'heartbeat').map((r) => r.conexao), [1]);

    // Estado gravado em disco: cursor avançado e ids lembrados
    const salvo = JSON.parse(readFileSync(arquivoEstado, 'utf8'));
    assert.equal(salvo.series['injetora01/produzido'].cursor, agora.toISOString());
    assert.equal(Object.keys(salvo.series['injetora01/produzido'].vistos).length, 5);

    // Segundo ciclo, com o estado relido do disco: nada novo para enviar.
    const antes = recebido.filter((r) => r.tipo !== 'heartbeat').length;
    await executarCiclo({
        config, ...clientes, estado: new Estado(arquivoEstado), log: silencioso, agora: new Date('2026-10-19T10:10:15.000Z'),
    });
    assert.equal(recebido.filter((r) => r.tipo !== 'heartbeat').length, antes);
});

test('usuário que precisa trocar a senha gera erro claro', async () => {
    const srv = await subir((req, url) => (url.pathname === '/api/auth/login'
        ? [200, { data: { token: 'limitado', force_password_change: true } }]
        : [403, { message: 'Invalid ability provided.' }]));

    try {
        const cliente = new OpenMesClient({ baseUrl: srv.url, usuario: 'conector', senha: 'temporaria' });
        await assert.rejects(cliente.heartbeat(1), /precisa trocar a senha/);
    } finally {
        srv.srv.close();
    }
});

test('token do jkcontrol inválido interrompe o ciclo (não descarta nada)', async () => {
    const config = {
        fuso: 'America/Sao_Paulo',
        sobreposicaoMs: 60_000,
        retroativoInicialMs: 60_000,
        maquinas: normalizarMaquinas([{ device: 'injetora01', connection_id: 1, signals: ['estado'] }]),
    };
    const estado = new Estado(null);

    await assert.rejects(executarCiclo({
        config,
        jk: new JkControlClient({ baseUrl: jk.url, token: 'ag_errado' }),
        mes: new OpenMesClient({ baseUrl: mes.url, usuario: 'conector', senha: 'segredo' }),
        estado,
        log: silencioso,
    }), /HTTP 401/);

    assert.equal(estado.serie('injetora01/estado').cursor, null);
});
