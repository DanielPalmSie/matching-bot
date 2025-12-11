function formatSimilarity(similarity) {
    if (similarity === null || similarity === undefined) return '—';
    const percent = Number(similarity) * 100;
    return `${percent.toFixed(1)}%`;
}

function formatCreatedAt(createdAt) {
    if (!createdAt) return '—';
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return createdAt;
    return date.toLocaleString('ru-RU');
}

export function formatMatchMessage(match) {
    const lines = [
        '🔎 Рекомендация:',
        `• Тип: ${match.type ?? '—'}`,
        `• Город/страна: ${match.city ?? '—'}, ${match.country ?? '—'}`,
        `• Статус: ${match.status ?? '—'}`,
        `• Похожесть: ${formatSimilarity(match.similarity)}`,
        `• Создано: ${formatCreatedAt(match.createdAt)}`,
    ];

    return lines.join('\n');
}

export function formatRequestSummary(request) {
    return [
        `• ${request.title || request.name || 'Запрос'}`,
        request.description ? `Описание: ${request.description}` : null,
        request.city ? `Город: ${request.city}` : null,
    ]
        .filter(Boolean)
        .join('\n');
}
