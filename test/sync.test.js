import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizarMaquinas } from '../src/config.js';
import { ErroHttp } from '../src/http.js';
import { silencioso } from '../src/log.js';
import { Estado } from '../src/state.js';
import { LOTE_MAXIMO, executarCiclo } from '../src/sync.js';

const T = (hhmmss) => new Date(`2026-10-19T${hhmmss}.000Z`);

function configCom(maquinas) {
    return {
        fuso: 'America/Sao_Paulo',
        sobreposicaoMs: 15 * 60_000,
        retroativoInicialMs: 60 * 60_000,
        maquinas: normalizarMaquinas(maquinas),
    };
}

const injetora = {
    device: 'injetora01',
    workstation_id: 3,
    connection_id: 1,
    signals: ['estado', 'produzido'],
    operator_variable: 'operador',
    reason_variable: 'motivo_parada',
};

/** jkcontrol de mentira: séries em memória, filtradas pela janela pedida. */
class JkFalso {
    constructor(series) {
        this.series = series;
        this.pedidos = [];
    }

    adicionar(chave, item) {
        (this.series[chave] ??= []).push(item);
    }

    async leituras(dispositivo, variavel, desde, ate) {
        this.pedidos.push({ chave: `${dispositivo}/${variavel}`, desde, ate });
        const itens = this.series[`${dispositivo}/${variavel}`];
        if (!itens) throw new ErroHttp(404, { message: 'Device not found' }, 'jk');
        return itens
            .filter((i) => i.ts >= desde && i.ts <= ate)
            .map((i) => ({ context: {}, ...i }))
            .sort((a, b) => a.ts - b.ts);
    }
}

/** OpenMES de mentira: registra a ordem das chamadas e falha quando mandado. */
class MesFalso {
    constructor() {
        this.chamadas = [];
        this.falhas = { sinais: [], operador: [], motivo: [] };
    }

    registrar(tipo, dados) {
        const falha = this.falhas[tipo].shift();
        if (falha) throw falha;
        this.chamadas.push({ tipo, ...dados });
    }

    async enviarSinais(conexaoId, leituras) {
        this.registrar('sinais', { conexaoId, leituras });
        return { accepted: leituras.length };
    }

    async eventoOperador(payload) {
        this.registrar('operador', payload);
        return { status: payload.action === 'login' ? 'logged_in' : 'logged_out' };
    }

    async motivoParada(estacaoId, payload) {
        this.registrar('motivo', { estacaoId, ...payload });
        return { data: { downtime_id: 7 } };
    }

    async heartbeat(conexaoId) {
        this.chamadas.push({ tipo: 'heartbeat', conexaoId });
    }

    entregas() {
        return this.chamadas.filter((c) => c.tipo !== 'heartbeat');
    }
}

function cenario(series, maquinas = [injetora]) {
    const jk = new JkFalso(series);
    const mes = new MesFalso();
    const estado = new Estado(null);
    const avisos = [];
    const log = { ...silencioso, warn: (m) => avisos.push(m), error: (m) => avisos.push(m) };
    const config = configCom(maquinas);
    const ciclo = (agora) => executarCiclo({ config, jk, mes, estado, log, agora });
    return { jk, mes, estado, avisos, ciclo };
}

test('entrega na ordem do horário; no mesmo instante o estado vem antes do motivo', async () => {
    const { mes, ciclo } = cenario({
        'injetora01/produzido': [{ id: 'p1', ts: T('09:58:00'), value: 100 }],
        'injetora01/operador': [{ id: 'o1', ts: T('09:59:00'), value: 1, context: { uid: '04A1B2C3' } }],
        'injetora01/estado': [
            { id: 'e1', ts: T('10:00:00'), value: 0 },
            { id: 'e2', ts: T('10:05:00'), value: 1 },
        ],
        'injetora01/motivo_parada': [{ id: 'm1', ts: T('10:00:00'), value: 12 }],
    });

    await ciclo(T('10:06:00'));

    assert.deepEqual(mes.entregas().map((c) => c.tipo), ['sinais', 'operador', 'sinais', 'motivo', 'sinais']);

    const [produzido, operador, parada, motivo, retomada] = mes.entregas();
    assert.deepEqual(produzido.leituras, [
        { node_id: 'injetora01/produzido', value: 100, ts: '2026-10-19T06:58:00.000-03:00', event_id: 'p1' },
    ]);
    assert.deepEqual(operador, {
        tipo: 'operador', card_uid: '04A1B2C3', action: 'login', workstation_id: 3, occurred_at: '2026-10-19T06:59:00.000-03:00',
    });
    assert.equal(parada.leituras[0].value, 0);
    assert.deepEqual(motivo, { tipo: 'motivo', estacaoId: 3, reason_code: '12', occurred_at: '2026-10-19T07:00:00.000-03:00' });
    assert.equal(retomada.leituras[0].event_id, 'e2');
});

test('sinais seguidos da mesma conexão vão num lote só', async () => {
    const { mes, ciclo } = cenario({
        'injetora01/estado': [{ id: 'e1', ts: T('10:00:00'), value: 1 }],
        'injetora01/produzido': [
            { id: 'p1', ts: T('10:01:00'), value: 10 },
            { id: 'p2', ts: T('10:02:00'), value: 20 },
        ],
    }, [{ ...injetora, operator_variable: undefined, reason_variable: undefined }]);

    await ciclo(T('10:03:00'));

    assert.equal(mes.entregas().length, 1);
    assert.deepEqual(mes.entregas()[0].leituras.map((l) => l.event_id), ['e1', 'p1', 'p2']);
});

test('o que a janela de sobreposição relê não é reenviado', async () => {
    const { jk, mes, ciclo } = cenario({ 'injetora01/estado': [{ id: 'e1', ts: T('10:00:00'), value: 1 }] },
        [{ device: 'injetora01', connection_id: 1, signals: ['estado'] }]);

    await ciclo(T('10:01:00'));
    jk.adicionar('injetora01/estado', { id: 'e2', ts: T('10:01:10'), value: 0 });
    await ciclo(T('10:01:15'));

    const enviados = mes.entregas().flatMap((c) => c.leituras.map((l) => l.event_id));
    assert.deepEqual(enviados, ['e1', 'e2']);

    // O segundo ciclo releu a partir de cursor − sobreposição.
    assert.equal(jk.pedidos[1].desde.toISOString(), '2026-10-19T09:46:00.000Z');
});

test('o primeiro ciclo lê o período retroativo inicial', async () => {
    const { jk, ciclo } = cenario({ 'injetora01/estado': [] }, [{ device: 'injetora01', connection_id: 1, signals: ['estado'] }]);

    await ciclo(T('10:00:00'));

    assert.equal(jk.pedidos[0].desde.toISOString(), '2026-10-19T09:00:00.000Z');
    assert.equal(jk.pedidos[0].ate.toISOString(), '2026-10-19T10:00:00.000Z');
});

test('falha temporária interrompe o ciclo; na próxima vez só vai o que faltou', async () => {
    const { mes, estado, ciclo } = cenario({
        'injetora01/estado': [{ id: 'e1', ts: T('10:00:00'), value: 0 }],
        'injetora01/motivo_parada': [{ id: 'm1', ts: T('10:01:00'), value: 12 }],
    }, [{ ...injetora, operator_variable: undefined, signals: ['estado'] }]);

    mes.falhas.motivo.push(new ErroHttp(503, 'indisponível', 'mes'));

    await assert.rejects(ciclo(T('10:02:00')), /HTTP 503/);
    assert.equal(estado.serie('injetora01/estado').cursor, null, 'cursor não avança em ciclo interrompido');

    await ciclo(T('10:02:15'));

    assert.deepEqual(mes.entregas().map((c) => c.tipo), ['sinais', 'motivo']);
    assert.equal(estado.serie('injetora01/estado').cursor, '2026-10-19T10:02:15.000Z');
});

test('recusa definitiva (422) é descartada e não trava a fila', async () => {
    const { mes, avisos, ciclo } = cenario({
        'injetora01/operador': [{ id: 'o1', ts: T('10:00:00'), value: 1, context: { uid: 'DEADBEEF' } }],
        'injetora01/estado': [{ id: 'e1', ts: T('10:01:00'), value: 1 }],
    }, [{ ...injetora, reason_variable: undefined, signals: ['estado'] }]);

    mes.falhas.operador.push(new ErroHttp(422, { message: 'No active worker has this card.' }, 'mes'));

    const r = await ciclo(T('10:02:00'));
    await ciclo(T('10:02:15'));

    assert.deepEqual(mes.entregas().map((c) => c.tipo), ['sinais']);
    assert.equal(r.descartados, 1);
    assert.match(avisos.join('\n'), /No active worker has this card/);
});

test('leitura de sinal mais antiga que a última entregue é ignorada', async () => {
    const { jk, mes, avisos, ciclo } = cenario({ 'injetora01/estado': [{ id: 'e2', ts: T('10:05:00'), value: 1 }] },
        [{ device: 'injetora01', connection_id: 1, signals: ['estado'] }]);

    await ciclo(T('10:06:00'));
    // Chegou atrasada (dispositivo estava sem rede), com horário anterior.
    jk.adicionar('injetora01/estado', { id: 'e1', ts: T('10:01:00'), value: 0 });
    await ciclo(T('10:06:15'));

    assert.deepEqual(mes.entregas().flatMap((c) => c.leituras.map((l) => l.event_id)), ['e2']);
    assert.match(avisos.join('\n'), /injetora01\/estado: 1 leitura/);
});

test('motivo que chega atrasado ainda é entregue (o OpenMES acha a parada pelo horário)', async () => {
    const { jk, mes, ciclo } = cenario({ 'injetora01/motivo_parada': [{ id: 'm2', ts: T('10:05:00'), value: 15 }] },
        [{ device: 'injetora01', workstation_id: 3, reason_variable: 'motivo_parada' }]);

    await ciclo(T('10:06:00'));
    jk.adicionar('injetora01/motivo_parada', { id: 'm1', ts: T('10:01:00'), value: 12 });
    await ciclo(T('10:06:15'));

    assert.deepEqual(mes.entregas().map((c) => [c.reason_code, c.occurred_at]), [
        ['15', '2026-10-19T07:05:00.000-03:00'],
        ['12', '2026-10-19T07:01:00.000-03:00'],
    ]);
});

test('cartão sem UID, valor estranho e motivo 0 são ignorados com aviso', async () => {
    const { mes, avisos, ciclo } = cenario({
        'injetora01/operador': [
            { id: 'o1', ts: T('10:00:00'), value: 1 },
            { id: 'o2', ts: T('10:00:01'), value: 7, context: { uid: 'A1' } },
        ],
        'injetora01/motivo_parada': [{ id: 'm1', ts: T('10:00:02'), value: 0 }],
    }, [{ device: 'injetora01', workstation_id: 3, operator_variable: 'operador', reason_variable: 'motivo_parada' }]);

    const r = await ciclo(T('10:01:00'));

    assert.equal(mes.entregas().length, 0);
    assert.equal(r.descartados, 3);
    assert.match(avisos.join('\n'), /sem o UID/);
    assert.match(avisos.join('\n'), /valor 7/);
    assert.match(avisos.join('\n'), /motivo 0/);
});

test('motivo com letras pode vir em context.reason_code', async () => {
    const { mes, ciclo } = cenario({ 'injetora01/motivo_parada': [{ id: 'm1', ts: T('10:00:00'), value: 1, context: { reason_code: 'MAT-01' } }] },
        [{ device: 'injetora01', workstation_id: 3, reason_variable: 'motivo_parada' }]);

    await ciclo(T('10:01:00'));

    assert.equal(mes.entregas()[0].reason_code, 'MAT-01');
});

// Firmware que conta por período (injecao_hora do Nitron) e manda cartões com o
// código num campo próprio do context (fun_rfid / maq_rfid).
const nitron = {
    device: 'injetora000',
    workstation_id: 9,
    connection_id: 2,
    signals: ['parada', { variable: 'injecao_hora', accumulate: 'sum' }],
    operator_variable: { variable: 'fun_rfid', card_field: 'fun_rfid' },
    reason_variable: { variable: 'maq_rfid', code_field: 'maq_rfid' },
};
const valoresContador = (mes) => mes.entregas()
    .flatMap((c) => c.leituras ?? [])
    .filter((l) => l.node_id === 'injetora000/injecao_hora')
    .map((l) => l.value);

test('contagem por período vira total acumulado, com base 0, e continua no ciclo seguinte', async () => {
    const { jk, mes, estado, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: 5 },
            { id: 'h2', ts: T('10:15:00'), value: 0 },
            { id: 'h3', ts: T('10:30:00'), value: 7 },
        ],
    }, [nitron]);

    await ciclo(T('10:31:00'));
    jk.adicionar('injetora000/injecao_hora', { id: 'h4', ts: T('10:45:00'), value: 3 });
    await ciclo(T('10:46:00'));

    // Base 0 antes da primeira parcela; o período parado (0) repete o total;
    // a sobreposição não soma de novo.
    assert.deepEqual(valoresContador(mes), [0, 5, 5, 12, 15]);
    assert.equal(estado.total('injetora000/injecao_hora'), 15);
});

test('primeira contagem 0 já serve de base', async () => {
    const { mes, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: 0 },
            { id: 'h2', ts: T('10:15:00'), value: 6 },
        ],
    }, [nitron]);

    await ciclo(T('10:16:00'));

    assert.deepEqual(valoresContador(mes), [0, 6]);
});

test('contagem atrasada ainda soma, com o horário da última entregue', async () => {
    const { jk, mes, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [{ id: 'h2', ts: T('10:30:00'), value: 4 }],
    }, [nitron]);

    await ciclo(T('10:31:00'));
    // Veio da fila offline do equipamento, com o horário em que foi contada.
    jk.adicionar('injetora000/injecao_hora', { id: 'h1', ts: T('10:20:00'), value: 2 });
    await ciclo(T('10:32:00'));

    const leituras = mes.entregas().flatMap((c) => c.leituras ?? []);
    assert.deepEqual(leituras.map((l) => [l.value, l.ts]), [
        [0, '2026-10-19T07:30:00.000-03:00'],
        [4, '2026-10-19T07:30:00.000-03:00'],
        [6, '2026-10-19T07:30:00.000-03:00'],
    ]);
});

test('falha temporária não perde nem duplica a contagem', async () => {
    const { mes, estado, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [{ id: 'h1', ts: T('10:00:00'), value: 5 }],
    }, [nitron]);

    mes.falhas.sinais.push(new ErroHttp(503, 'indisponível', 'mes'));
    await assert.rejects(ciclo(T('10:01:00')), /HTTP 503/);
    assert.equal(estado.total('injetora000/injecao_hora'), 0, 'total só grava o que foi entregue');

    await ciclo(T('10:01:15'));
    assert.deepEqual(valoresContador(mes), [0, 5]);
    assert.equal(estado.total('injetora000/injecao_hora'), 5);
});

test('contagem negativa ou não numérica é ignorada com aviso', async () => {
    const { mes, avisos, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/fun_rfid': [],
        'injetora000/maq_rfid': [],
        'injetora000/injecao_hora': [
            { id: 'h1', ts: T('10:00:00'), value: -3 },
            { id: 'h2', ts: T('10:15:00'), value: 4 },
        ],
    }, [nitron]);

    const r = await ciclo(T('10:16:00'));

    assert.deepEqual(valoresContador(mes), [0, 4]);
    assert.equal(r.descartados, 1);
    assert.match(avisos.join('\n'), /contagem -3 inválida/);
});

test('cartão e código de motivo podem vir em campos próprios do context', async () => {
    const { mes, avisos, ciclo } = cenario({
        'injetora000/parada': [],
        'injetora000/injecao_hora': [],
        'injetora000/fun_rfid': [
            { id: 'f1', ts: T('10:00:00'), value: 1, context: { fun_rfid: '7788' } },
            { id: 'f2', ts: T('10:00:30'), value: 1, context: { uid: '444' } },
        ],
        // O valor é sempre 1 no cartão MAQ: o código está só no context.
        'injetora000/maq_rfid': [{ id: 'q1', ts: T('10:01:00'), value: 1, context: { maq_rfid: '3101' } }],
    }, [nitron]);

    const r = await ciclo(T('10:02:00'));

    const [login, motivo] = mes.entregas();
    assert.equal(login.card_uid, '7788');
    assert.equal(login.action, 'login');
    assert.equal(motivo.reason_code, '3101');
    assert.equal(motivo.estacaoId, 9);
    assert.equal(r.descartados, 1);
    assert.match(avisos.join('\n'), /sem o UID do cartão em context\.fun_rfid/);
});

test('muitas leituras de sinal vão em lotes pequenos, na ordem', async () => {
    const leituras = Array.from({ length: LOTE_MAXIMO * 2 + 50 }, (_, i) => ({
        id: `p${i}`, ts: new Date(T('09:30:00').getTime() + i * 1000), value: i + 1,
    }));
    const { mes, ciclo } = cenario({ 'injetora01/produzido': leituras },
        [{ device: 'injetora01', connection_id: 1, signals: ['produzido'] }]);

    await ciclo(T('10:00:00'));

    const lotes = mes.entregas().map((c) => c.leituras);
    assert.deepEqual(lotes.map((l) => l.length), [LOTE_MAXIMO, LOTE_MAXIMO, 50]);
    assert.deepEqual(lotes.flat().map((l) => l.value), leituras.map((l) => l.value));
});

test('dispositivo inexistente no jkcontrol não impede os outros', async () => {
    const { mes, avisos, ciclo } = cenario({ 'injetora01/estado': [{ id: 'e1', ts: T('10:00:00'), value: 1 }] }, [
        { device: 'fantasma', connection_id: 1, signals: ['estado'] },
        { device: 'injetora01', connection_id: 1, signals: ['estado'] },
    ]);

    await ciclo(T('10:01:00'));

    assert.equal(mes.entregas().length, 1);
    assert.match(avisos.join('\n'), /fantasma\/estado não encontrado/);
});

test('cada conexão recebe heartbeat no fim do ciclo', async () => {
    const { mes, ciclo } = cenario({ 'a/estado': [], 'b/estado': [], 'c/estado': [] }, [
        { device: 'a', connection_id: 1, signals: ['estado'] },
        { device: 'b', connection_id: 1, signals: ['estado'] },
        { device: 'c', connection_id: 2, signals: ['estado'] },
    ]);

    await ciclo(T('10:00:00'));

    assert.deepEqual(mes.chamadas.filter((c) => c.tipo === 'heartbeat').map((c) => c.conexaoId), [1, 2]);
});
