import axios from 'axios';

export class ApiError extends Error {
    constructor(message, status = null, isAuthError = false) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.isAuthError = isAuthError;
    }
}

function normalizeApiError(error) {
    if (error.response) {
        const status = error.response.status;

        if (typeof error.response.data === 'string') {
            const isHtml = error.response.data.toLowerCase().includes('<html');
            return {
                message: isHtml ? '❌ Произошла ошибка на сервере. Попробуйте позже.' : error.response.data,
                status,
                isAuthError: status === 401 || status === 403,
            };
        }

        if (error.response.data?.violations) {
            return {
                message: error.response.data.violations
                    .map((v) => `${v.propertyPath}: ${v.message}`)
                    .join('\n'),
                status,
                isAuthError: status === 401 || status === 403,
            };
        }

        return {
            message: error.response.data?.message ||
                     error.response.data?.error ||
                     `Ошибка ${status}: попробуйте позже.`,
            status,
            isAuthError: status === 401 || status === 403,
        };
    }

    if (error.request) {
        return {
            message: 'Не удалось связаться с сервером. Проверьте соединение или попробуйте позже.',
            status: null,
            isAuthError: false,
        };
    }

    return {
        message: '❌ Произошла ошибка на сервере. Попробуйте позже.',
        status: null,
        isAuthError: false,
    };
}

export class ApiClient {
    constructor({ baseUrl, timeout = 10000 } = {}) {
        this.baseUrl = baseUrl;
        this.timeout = timeout;
    }

    buildUrl(pathname) {
        const base = (this.baseUrl || '').replace(/\/+$/, '');
        if (!pathname) return base;
        const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
        if (base.endsWith('/api') && normalizedPath.startsWith('/api')) {
            return `${base}${normalizedPath.replace(/^\/api/, '')}`;
        }
        return `${base}${normalizedPath}`;
    }

    buildHeaders(token) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        return headers;
    }

    async requestWithConfig(method, url, { data, params } = {}, token) {
        try {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`[api] ${String(method).toUpperCase()} ${this.buildUrl(url)}`);
            }
            const response = await axios({
                method,
                url: this.buildUrl(url),
                data,
                params,
                headers: this.buildHeaders(token),
                timeout: this.timeout,
            });
            return response.data;
        } catch (error) {
            const normalized = normalizeApiError(error);
            throw new ApiError(normalized.message, normalized.status, normalized.isAuthError);
        }
    }

    async request(method, url, data, token) {
        return this.requestWithConfig(method, url, { data }, token);
    }

    async get(url, { params, token } = {}) {
        return this.requestWithConfig('get', url, { params }, token);
    }
}

export default ApiClient;
