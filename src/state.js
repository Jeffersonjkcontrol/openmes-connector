import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Estado persistido entre ciclos, por série (dispositivo/variável):
 *  - cursor: até onde a janela já foi lida com sucesso;
 *  - vistos: _id das leituras já entregues ao OpenMES, com o horário da leitura,
 *    para não reenviar o que a janela de sobreposição relê;
 *  - ultimoTs: horário da leitura mais nova já entregue (sinais de máquina não
 *    podem andar para trás — ver sync.js);
 *  - total: nas séries com "accumulate", o total já entregue ao OpenMES. Apagar
 *    o estado zera o total, e o OpenMES trava o contador (reset_required).
 *
 * Gravado de forma atômica (arquivo temporário + rename): uma queda no meio da
 * gravação não corrompe o estado.
 */
export class Estado {
    constructor(arquivo) {
        this.arquivo = arquivo;
        this.dados = { versao: 1, series: {} };

        if (arquivo && existsSync(arquivo)) {
            this.dados = JSON.parse(readFileSync(arquivo, 'utf8'));
            this.dados.series ??= {};
        }
    }

    serie(chave) {
        this.dados.series[chave] ??= { cursor: null, ultimoTs: null, vistos: {} };
        return this.dados.series[chave];
    }

    jaVisto(chave, id) {
        return Object.hasOwn(this.serie(chave).vistos, id);
    }

    marcarVisto(chave, id, ts) {
        const serie = this.serie(chave);
        serie.vistos[id] = ts.getTime();
    }

    marcarEntregue(chave, id, ts) {
        const serie = this.serie(chave);
        serie.vistos[id] = ts.getTime();
        serie.ultimoTs = Math.max(serie.ultimoTs ?? 0, ts.getTime());
    }

    ultimoEntregue(chave) {
        return this.serie(chave).ultimoTs;
    }

    total(chave) {
        return this.serie(chave).total ?? 0;
    }

    definirTotal(chave, total) {
        this.serie(chave).total = total;
    }

    avancarCursor(chave, ate) {
        this.serie(chave).cursor = ate.toISOString();
    }

    /** Esquece ids mais antigos que o limite — fora da janela não voltam a ser lidos. */
    podar(chave, limite) {
        const vistos = this.serie(chave).vistos;
        for (const [id, ts] of Object.entries(vistos)) {
            if (ts < limite.getTime()) delete vistos[id];
        }
    }

    salvar() {
        if (!this.arquivo) return;
        mkdirSync(dirname(this.arquivo), { recursive: true });
        const temporario = `${this.arquivo}.tmp`;
        writeFileSync(temporario, JSON.stringify(this.dados));
        renameSync(temporario, this.arquivo);
    }
}
