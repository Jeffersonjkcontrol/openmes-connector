// fetch com tempo limite e erro que carrega o status HTTP.

export class ErroHttp extends Error {
    constructor(status, corpo, url) {
        const detalhe = typeof corpo === 'object' && corpo !== null
            ? (corpo.message ?? JSON.stringify(corpo))
            : String(corpo ?? '');
        super(`HTTP ${status} em ${url}${detalhe ? `: ${detalhe}` : ''}`);
        this.status = status;
        this.corpo = corpo;
    }
}

export async function requisicao(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
    const resposta = await fetchImpl(url, {
        method,
        headers: {
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
    });

    const texto = await resposta.text();
    let corpo = texto;
    try {
        corpo = texto ? JSON.parse(texto) : null;
    } catch {
        // resposta não-JSON (ex.: página de erro do proxy) — fica como texto
    }

    if (!resposta.ok) {
        throw new ErroHttp(resposta.status, corpo, String(url));
    }

    return corpo;
}
