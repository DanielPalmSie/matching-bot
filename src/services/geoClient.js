import { API_ROUTES } from '../config/apiRoutes.js';

class GeoClient {
    constructor({ apiClient, logger = console, timeout = 8000 } = {}) {
        this.apiClient = apiClient;
        this.logger = logger;
        this.timeout = timeout;
    }

    async searchCountries(query, limit = 10) {
        if (!query || query.length < 2) {
            return { items: [], error: null };
        }
        const params = { q: query, limit: Math.min(limit, 10) };
        try {
            const data = await this.apiClient.get(API_ROUTES.GEO_COUNTRIES, { params, timeout: this.timeout });
            const items = Array.isArray(data) ? data : [];
            this.logger.info('geo.countries', { endpoint: API_ROUTES.GEO_COUNTRIES, params, results: items.length });
            return { items, error: null };
        } catch (error) {
            this.logger.warn('geo.countries.failed', {
                endpoint: API_ROUTES.GEO_COUNTRIES,
                params,
                status: error?.status ?? null,
                message: error?.message ?? null,
            });
            return { items: [], error };
        }
    }

    async searchCities({ q, country, limit = 10, offset = 0 } = {}) {
        const safeLimit = Math.min(Math.max(limit ?? 10, 1), 10);
        const safeOffset = Math.max(offset ?? 0, 0);
        if (!q || q.length < 2 || !country) {
            return { items: [], limit: safeLimit, offset: safeOffset, hasMore: false, error: null };
        }
        const params = { q, country, limit: safeLimit, offset: safeOffset };
        try {
            const data = await this.apiClient.get(API_ROUTES.GEO_CITIES, { params, timeout: this.timeout });
            const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
            const resolvedLimit = Number.isInteger(data?.limit) ? data.limit : safeLimit;
            const resolvedOffset = Number.isInteger(data?.offset) ? data.offset : safeOffset;
            const hasMore = data?.hasMore === true;
            this.logger.info('geo.cities', { endpoint: API_ROUTES.GEO_CITIES, params, results: items.length });
            return { items, limit: resolvedLimit, offset: resolvedOffset, hasMore, error: null };
        } catch (error) {
            this.logger.warn('geo.cities.failed', {
                endpoint: API_ROUTES.GEO_CITIES,
                params,
                status: error?.status ?? null,
                message: error?.message ?? null,
            });
            return { items: [], limit: safeLimit, offset: safeOffset, hasMore: false, error };
        }
    }
}

export default GeoClient;
