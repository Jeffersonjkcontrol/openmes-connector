import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatarNoFuso, validarFuso } from '../src/time.js';

test('formata no fuso de São Paulo com deslocamento', () => {
    assert.equal(formatarNoFuso(new Date('2026-10-19T11:00:00.000Z'), 'America/Sao_Paulo'), '2026-10-19T08:00:00.000-03:00');
});

test('mantém os milissegundos e vira o dia corretamente', () => {
    assert.equal(formatarNoFuso(new Date('2026-10-20T02:30:15.042Z'), 'America/Sao_Paulo'), '2026-10-19T23:30:15.042-03:00');
});

test('UTC sai como +00:00 e meia hora de deslocamento é respeitada', () => {
    assert.equal(formatarNoFuso(new Date('2026-10-19T11:00:00.000Z'), 'UTC'), '2026-10-19T11:00:00.000+00:00');
    assert.equal(formatarNoFuso(new Date('2026-10-19T11:00:00.000Z'), 'Asia/Kolkata'), '2026-10-19T16:30:00.000+05:30');
});

test('meia-noite sai como 00, não 24', () => {
    assert.equal(formatarNoFuso(new Date('2026-10-19T03:00:00.000Z'), 'America/Sao_Paulo'), '2026-10-19T00:00:00.000-03:00');
});

test('o texto formatado volta ao mesmo instante', () => {
    const instante = new Date('2026-10-19T14:07:09.123Z');
    assert.equal(new Date(formatarNoFuso(instante, 'America/Sao_Paulo')).getTime(), instante.getTime());
});

test('fuso inválido é recusado na partida', () => {
    assert.throws(() => validarFuso('America/Sao_Paolo'));
});
