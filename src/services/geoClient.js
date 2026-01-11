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

    async searchCities(query, countryCode, limit = 10) {
        if (!query || query.length < 2 || !countryCode) {
            return { items: [], error: null };
        }
        const params = { q: query, country: countryCode, limit: Math.min(limit, 10) };
        try {
            const data = await this.apiClient.get(API_ROUTES.GEO_CITIES, { params, timeout: this.timeout });
            const items = Array.isArray(data) ? data : [];
            this.logger.info('geo.cities', { endpoint: API_ROUTES.GEO_CITIES, params, results: items.length });
            return { items, error: null };
        } catch (error) {
            this.logger.warn('geo.cities.failed', {
                endpoint: API_ROUTES.GEO_CITIES,
                params,
                status: error?.status ?? null,
                message: error?.message ?? null,
            });
            return { items: [], error };
        }
    }
}

export default GeoClient;
