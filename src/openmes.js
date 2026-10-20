import { ErroHttp, requisicao } from './http.js';

/** Tempo limite das chamadas ao OpenMES: gravar um lote de sinais é bem mais lento que ler o jkcontrol. */
const TEMPO_LIMITE_MS = 60_000;

/**
 * Cliente da API do OpenMES.
 *
 * O token do OpenMES expira (15 min por padrão — DEFAULT_TOKEN_TTL_MINUTES),
 * então com usuário e senha configurados o cliente faz login sozinho e repete
 * a chamada uma vez quando recebe 401.
 */
export class OpenMesClient {
    constructor({ baseUrl, token = null, usuario = null, senha = null, fetchImpl = fetch }) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.usuario = usuario;
        this.senha = senha;
        this.fetch = fetchImpl;
    }

    get podeLogar() {
        return Boolean(this.usuario && this.senha);
    }

    async login() {
        const corpo = await requisicao(this.fetch, new URL('/api/auth/login', this.baseUrl), {
            method: 'POST',
            body: { username: this.usuario, password: this.senha },
        });

        if (corpo?.data?.force_password_change) {
            throw new Error(
                `O usuário "${this.usuario}" do OpenMES precisa trocar a senha antes de usar a API. `
                + 'Entre uma vez pela interface, troque a senha e atualize OPENMES_PASSWORD.',
            );
        }

        this.token = corpo?.data?.token;
        if (!this.token) {
            throw new Error('Login no OpenMES não devolveu token.');
        }
    }

    async chamar(method, caminho, body) {
        if (!this.token) {
            if (!this.podeLogar) {
                throw new Error('Configure OPENMES_TOKEN ou OPENMES_USERNAME/OPENMES_PASSWORD.');
            }
            await this.login();
        }

        const tentar = () => requisicao(this.fetch, new URL(caminho, this.baseUrl), {
            method,
            body,
            headers: { Authorization: `Bearer ${this.token}` },
            timeoutMs: TEMPO_LIMITE_MS,
        });

        try {
            return await tentar();
        } catch (erro) {
            if (erro instanceof ErroHttp && erro.status === 401 && this.podeLogar) {
                await this.login();
                return tentar();
            }
            throw erro;
        }
    }

    /** Sinais de máquina (estado, contadores) — endpoint nativo do OpenMES. */
    enviarSinais(conexaoId, leituras) {
        return this.chamar('POST', `/api/v1/machine-connections/${conexaoId}/signals`, { readings: leituras });
    }

    heartbeat(conexaoId) {
        return this.chamar('POST', `/api/v1/machine-connections/${conexaoId}/heartbeat`);
    }

    /** Leitura de cartão RFID — módulo JkControl. */
    eventoOperador(payload) {
        return this.chamar('POST', '/api/v1/jk/operator-events', payload);
    }

    /** Cartão de OP lido na máquina: a OP passa a rodar no posto — módulo JkControl. */
    iniciarOrdem(estacaoId, payload) {
        return this.chamar('POST', `/api/v1/jk/workstations/${estacaoId}/work-order`, payload);
    }

    /** Motivo de parada digitado na máquina — módulo JkControl. */
    motivoParada(estacaoId, payload) {
        return this.chamar('POST', `/api/v1/jk/workstations/${estacaoId}/downtime-reason`, payload);
    }

    /** Cartão de qualidade lido na máquina: inspeção na OP que roda no posto — módulo JkControl 0.3.0. */
    registrarQualidade(estacaoId, payload) {
        return this.chamar('POST', `/api/v1/jk/workstations/${estacaoId}/quality-check`, payload);
    }
}
