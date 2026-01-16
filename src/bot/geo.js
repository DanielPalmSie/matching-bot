import { Markup } from 'telegraf';

export function createGeoHelpers({ sessionStore, ApiError, GEO_SELECTION_TTL_MS }) {
    function ensureGeoTemp(session) {
        if (!session.temp) {
            session.temp = {};
        }
        if (!session.temp.geo) {
            session.temp.geo = {};
        }
        return session.temp.geo;
    }

    async function promptCountryQuery(ctx) {
        await ctx.reply(
            'Введите первые 2–3 буквы страны (латиницей) — я предложу варианты. Пример: ge, fra, ukr.'
        );
    }

    async function promptCityQuery(ctx, countryName) {
        await ctx.reply(
            `Теперь введите первые 2–3 буквы города в ${countryName} — я предложу варианты. Пример: ber, mun, par.`
        );
    }

    function startLocationSelection(session) {
        const geoTemp = ensureGeoTemp(session);
        geoTemp.lastCountries = {};
        geoTemp.lastCities = {};
        geoTemp.country = null;
        geoTemp.city = null;
        geoTemp.q = null;
        geoTemp.limit = 10;
        geoTemp.offset = 0;
        geoTemp.lastCountriesAt = null;
        geoTemp.lastCitiesAt = null;
        session.state = 'WAIT_COUNTRY_QUERY';
        sessionStore.persist();
    }

    function isGeoSelectionExpired(timestamp) {
        if (!timestamp) return true;
        return Date.now() - timestamp > GEO_SELECTION_TTL_MS;
    }

    function buildGeoCountriesKeyboard(countries, callbackPrefix = 'geo_country_pick') {
        const mapping = {};
        const rows = countries.map((country, index) => {
            const key = String(index + 1);
            mapping[key] = { code: country.code, name: country.name };
            return [Markup.button.callback(`${country.name} (${country.code})`, `${callbackPrefix}:${key}`)];
        });
        rows.push([Markup.button.callback('Отмена', 'geo_cancel')]);
        return { keyboard: Markup.inlineKeyboard(rows), mapping };
    }

    function buildGeoCitiesKeyboard(
        cities,
        { offset = 0, hasMore = false } = {},
        callbackPrefix = 'geo_city_pick'
    ) {
        const mapping = {};
        const rows = cities.map((city, index) => {
            const key = String(index + 1);
            mapping[key] = {
                id: city.id,
                name: city.name,
                region: city.region ?? null,
                countryCode: city.countryCode,
                latitude: city.latitude,
                longitude: city.longitude,
            };
            const regionPart = city.region ? `, ${city.region}` : '';
            const label = `${city.name}${regionPart} (${city.countryCode})`;
            return [Markup.button.callback(label, `${callbackPrefix}:${key}`)];
        });
        const paginationRow = [];
        if (offset > 0) {
            paginationRow.push(Markup.button.callback('⬅️ Prev', 'geo_city_page:prev'));
        }
        if (hasMore) {
            paginationRow.push(Markup.button.callback('➡️ Next', 'geo_city_page:next'));
        }
        if (paginationRow.length) {
            rows.push(paginationRow);
        }
        return { keyboard: Markup.inlineKeyboard(rows), mapping };
    }

    function isGeoServiceUnavailable(error) {
        return error instanceof ApiError && error.status === 503 && error.message === 'geo_service_unavailable';
    }

    return {
        ensureGeoTemp,
        promptCountryQuery,
        promptCityQuery,
        startLocationSelection,
        isGeoSelectionExpired,
        buildGeoCountriesKeyboard,
        buildGeoCitiesKeyboard,
        isGeoServiceUnavailable,
    };
}
