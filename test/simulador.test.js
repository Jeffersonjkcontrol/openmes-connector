// O simulador tem que se comportar como o jkcontrol real para o teste local
// valer: o cliente do conector lê dele sem adaptação, e as regras de ingestão
// (valor numérico, janela de horário, buffer de 250 ms) são as mesmas.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ErroHttp } from '../src/http.js';
import { JkControlClient } from '../src/jkcontrol.js';
import { Armazem, ErroLeitura, criarServidor } from '../sim/servidor.js';

let agora = Date.parse('2026-10-19T12:00:00.000Z');
const armazem = new Armazem({ relogio: () => agora });
let servidor;
let url;

before(async () => {
    servidor = criarServidor({ token: 'ag_teste', armazem });
    await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${servidor.address().port}`;

    // Sete leituras com 1 s de chegada entre elas (nada cai no buffer de 250 ms).
    for (let i = 0; i < 7; i += 1) {
        agora += 1000;
        armazem.publicar({ device: 'torno01', variable: 'produzido', value: (i + 1) * 10, timestamp: Date.parse(`2026-10-19T11:0${i}:00.000Z`) });
    }
});

after(() => servidor.close());

test('o cliente do conector lê todas as páginas em ordem cronológica', async () => {
    const jk = new JkControlClient({ baseUrl: url, token: 'ag_teste', porPagina: 3 });
    const itens = await jk.leituras('torno01', 'produzido', new Date('2026-10-19T10:00:00Z'), new Date('2026-10-19T12:00:00Z'));

    assert.deepEqual(itens.map((i) => i.value), [10, 20, 30, 40, 50, 60, 70]);
    assert.equal(new Set(itens.map((i) => i.id)).size, 7);
});

test('a janela de horário é respeitada', async () => {
    const jk = new JkControlClient({ baseUrl: url, token: 'ag_teste' });
    const itens = await jk.leituras('torno01', 'produzido', new Date('2026-10-19T11:02:00Z'), new Date('2026-10-19T11:04:00Z'));

    assert.deepEqual(itens.map((i) => i.value), [30, 40, 50]);
});

test('token errado recebe 401 e variável inexistente recebe 404', async () => {
    const intruso = new JkControlClient({ baseUrl: url, token: 'ag_errado' });
    await assert.rejects(intruso.leituras('torno01', 'produzido', new Date(0), new Date(agora)), (e) => e instanceof ErroHttp && e.status === 401);

    const jk = new JkControlClient({ baseUrl: url, token: 'ag_teste' });
    await assert.rejects(jk.leituras('torno01', 'nao_existe', new Date(0), new Date(agora)), (e) => e instanceof ErroHttp && e.status === 404);
});

test('valor em texto e horário fora da janela são recusados', () => {
    assert.throws(() => armazem.publicar({ device: 'torno01', variable: 'operador', value: '04A1B2C3' }), ErroLeitura);
    assert.throws(() => armazem.publicar({ device: 'torno01', variable: 'estado', value: 1, timestamp: agora + 6 * 60_000 }), /futuro/);
    assert.throws(() => armazem.publicar({ device: 'torno01', variable: 'estado', value: 1, timestamp: agora - 31 * 24 * 3_600_000 }), /passado/);
    assert.throws(() => armazem.publicar({ device: 'torno 01', variable: 'estado', value: 1 }), ErroLeitura);
});

test('duas leituras em menos de 250 ms: fica só a última', () => {
    agora += 1000;
    armazem.publicar({ device: 'torno01', variable: 'estado', value: 0 });
    agora += 100;
    armazem.publicar({ device: 'torno01', variable: 'estado', value: 1 });
    agora += 300;
    armazem.publicar({ device: 'torno01', variable: 'estado', value: 2 });

    assert.deepEqual(armazem.series.get('torno01/estado').map((i) => i.value), [1, 2]);
});

test('o arquivo guarda o histórico entre reinícios', () => {
    const arquivo = join(mkdtempSync(join(tmpdir(), 'sim-')), 'simulador.json');
    const primeiro = new Armazem({ arquivo, relogio: () => agora });
    primeiro.publicar({ device: 'torno01', variable: 'operador', value: 1, context: { uid: '04:A1:B2:C3' } });

    const depois = new Armazem({ arquivo, relogio: () => agora });
    assert.deepEqual(depois.ultimo('torno01/operador').context, { uid: '04:A1:B2:C3' });
});
