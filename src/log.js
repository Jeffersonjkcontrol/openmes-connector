// Log simples com horário — o suficiente para `docker logs` e para o terminal.

const linha = (nivel, args) => [new Date().toISOString(), nivel, ...args];

export const log = {
    info: (...args) => console.log(...linha('INFO ', args)),
    warn: (...args) => console.warn(...linha('AVISO', args)),
    error: (...args) => console.error(...linha('ERRO ', args)),
};

/** Logger mudo para os testes. */
export const silencioso = { info() {}, warn() {}, error() {} };
